/**
 * Native <-> JS bridge, implementing plan/bridge_protocol.md (v1).
 *
 * Native pushes one frame per ARFrame through bridge.onFrame (via a WKJSHandle, or
 * window.__holoweb.onFrame as the evaluateJavaScript fallback). The bridge applies the
 * latest frame to the IWER device immediately: IWER's own rAF loop reads it, so a
 * dropped or late native call never stalls rendering.
 */
import { mat4 } from 'gl-matrix';
import { P_DEVICE, type XRDevice } from 'iwer';
import { XREnvironmentBlendMode, XRInteractionMode } from 'iwer/lib/session/XRSession.js';
import type { NativeAnchorData } from './anchors.js';
import {
  isMode,
  isTopFrame,
  parseDeviceInfo,
  scaleRect,
  type DeviceInfo,
  type FramePacket,
  type HitTestHit,
  type InterfaceOrientation,
  type LightEstimate,
  type NativeCallbacks,
  type RenderMode,
  type SessionReply,
  type TrackingState,
} from './bridge-types.js';
import { nativeFramebufferSize, devicePixelRatioOrOne } from './device.js';
import type { NativeHandData } from './hand-input.js';
import type { NativePlaneData, PlaneEnvironment } from './hittest.js';
import { PosePredictor } from './prediction.js';
import type { NativeEnvironment } from './reflection.js';
import { INERT_VIEWPORT } from './views.js';
import { lookupPhone, type PhoneLookup } from './phones.js';
import { clampIpd, computeStereo, IPD_DEFAULT, type PixelRect, type StereoParams } from './stereo.js';
import { isRecord, type Transport } from './webkit.js';

export type * from './bridge-types.js';

export class HoloWebBridge {
  mode: RenderMode = 'mono';
  ipd = IPD_DEFAULT;
  tracking: TrackingState = 'notAvailable';
  deviceInfo: DeviceInfo | undefined;
  latest: FramePacket | null = null;
  frameCount = 0;
  /** Set by session hooks; called when native ends the session. */
  onNativeSessionEnded: ((reason?: string) => void) | null = null;
  /** Called with every onPlanes set (local-floor tracking). */
  readonly planeListeners = new Set<(planes: readonly NativePlaneData[]) => void>();
  /** Receives onAnchors updates (NativeAnchors). */
  anchorsHandler: ((anchors: NativeAnchorData[]) => void) | null = null;
  /** Receives onHands updates (HandTracking). */
  handsHandler: ((hands: NativeHandData[]) => void) | null = null;
  /** Receives onEnvironment reflection maps (ReflectionMaps). */
  environmentHandler: ((environment: NativeEnvironment) => void) | null = null;
  /** Receives onVisibility states (visibility.ts). */
  visibilityHandler: ((state: string) => void) | null = null;
  /** Stereo-only viewer pose prediction; horizonMs 0 disables it. */
  readonly predictor = new PosePredictor();
  /** Orientation / framebuffer size changes seen between frames (presentation rescales). */
  layoutChanges = 0;
  readonly callbacks: NativeCallbacks;

  private lastLayout = '';
  private stereoCache: { key: string; params: StereoParams } | null = null;
  private readonly cameraMatrix = mat4.create();
  private readonly poseMatrix = mat4.create();

  constructor(
    readonly device: XRDevice,
    readonly environment: PlaneEnvironment,
    readonly transport: Transport,
  ) {
    this.callbacks = {
      onFrame: (t, mode, transform, view, proj, light, tracking, orientation, sentAt) =>
        this.onFrame(t, mode, transform, view, proj, light, tracking, orientation, sentAt),
      onTracking: (tracking) => {
        this.tracking = tracking;
      },
      onPlanes: (planes) => {
        const list = Array.isArray(planes) ? planes : [];
        this.environment.setPlanes(list);
        this.planeListeners.forEach((l) => l(list));
      },
      onAnchors: (anchors) => this.anchorsHandler?.(Array.isArray(anchors) ? anchors : []),
      onHands: (hands) => this.handsHandler?.(Array.isArray(hands) ? hands : []),
      onEnvironment: (environment) => this.environmentHandler?.(environment),
      onVisibility: (state) => this.visibilityHandler?.(state),
      onSessionEnded: (reason) => this.onNativeSessionEnded?.(reason),
    };
  }

  /** Post `ready` with a WKJSHandle to the callbacks object (null if unsupported). */
  /** 'main' for the top-level document, 'sub' inside an iframe (diagnostics for native). */
  readonly frame: 'main' | 'sub' = isTopFrame() ? 'main' : 'sub';
  /** Number of `ready` messages posted by this frame. */
  readyPosts = 0;
  private readyOnce: Promise<void> | null = null;

  /**
   * Post `ready` once, lazily: only frames that use WebXR (isSessionSupported / requestSession)
   * announce themselves, so a main frame and a same-origin iframe don't both register a handle.
   */
  ensureReady(): Promise<void> {
    this.readyOnce ??= this.announceReady().catch((err: unknown) => console.warn('HoloWeb: ready failed', err));
    return this.readyOnce;
  }

  async announceReady(): Promise<void> {
    this.readyPosts++;
    const reply = await this.transport.post({
      type: 'ready',
      frame: this.frame,
      bridge: this.transport.createHandle(this.callbacks),
    });
    if (!isRecord(reply)) return;
    this.deviceInfo = parseDeviceInfo(reply.device) ?? this.deviceInfo;
    if (isMode(reply.mode)) this.setLocalMode(reply.mode);
  }

  get phone(): PhoneLookup {
    const info = this.deviceInfo;
    return lookupPhone(info?.model, info ? { w: info.screenWidthPx, h: info.screenHeightPx } : undefined);
  }

  onFrame(
    t: number,
    mode: RenderMode,
    transform: ArrayLike<number>,
    view: ArrayLike<number>,
    proj: ArrayLike<number>,
    light: LightEstimate | null,
    tracking: TrackingState,
    orientation?: InterfaceOrientation,
    sentAt?: number,
  ): void {
    const packet: FramePacket = {
      t,
      mode: isMode(mode) ? mode : this.mode,
      transform: Float32Array.from(transform),
      view: Float32Array.from(view),
      proj: Float32Array.from(proj),
      light: light ?? null,
      tracking,
      orientation,
      sentAt,
      latencyMs: typeof sentAt === 'number' ? performance.timeOrigin + performance.now() - sentAt : undefined,
    };
    this.latest = packet;
    this.tracking = tracking;
    this.frameCount++;
    this.applyFrame(packet);
  }

  /** Update the IWER device from a frame packet. */
  applyFrame(packet: FramePacket): void {
    if (packet.mode !== this.mode) this.setLocalMode(packet.mode);
    this.trackLayout(packet);

    // `transform` is the display-oriented camera pose (= inverse(view)) matching `proj`.
    // If a native build sends no usable transform, derive it from the view matrix.
    const cam = this.cameraMatrix;
    if (packet.transform.length === 16) {
      mat4.copy(cam, packet.transform as unknown as mat4);
    } else if (packet.view.length !== 16 || !mat4.invert(cam, packet.view as unknown as mat4)) {
      return;
    }

    const device = this.device;
    const tracked = packet.tracking !== 'notAvailable';
    if (this.mode === 'stereo') {
      const stereo = this.stereo();
      // No camera image to stay in sync with: extrapolate to the expected display time.
      const predicted = tracked ? this.predictor.predict({ t: packet.t, matrix: cam }) : cam;
      mat4.translate(this.poseMatrix, predicted, stereo.params.cameraToCenterEye);
      device.stereoEnabled = true;
      device.ipd = this.ipd;
      device.nativeProjection.left = stereo.params.left.projection;
      device.nativeProjection.right = stereo.params.right.projection;
      delete device.nativeProjection.none;
      device.nativeViewports.left = stereo.left;
      device.nativeViewports.right = stereo.right;
    } else {
      // Mono: the camera background shows exactly this ARFrame, so never predict.
      this.predictor.reset();
      mat4.copy(this.poseMatrix, cam);
      device.stereoEnabled = false;
      device.nativeProjection.none = packet.proj;
      delete device.nativeProjection.left;
      delete device.nativeProjection.right;
      delete device.nativeViewports.left;
      // Only used by views.ts' inert 2nd view (mono after stereo): a true 0x0 viewport.
      device.nativeViewports.right = { ...INERT_VIEWPORT };
    }
    // Keep the last good pose while ARKit has no tracking.
    if (!tracked) return;
    mat4.getTranslation(device.position.vec3, this.poseMatrix);
    mat4.getRotation(device.quaternion.quat, this.poseMatrix);
  }

  private trackLayout(packet: FramePacket): void {
    const fb = nativeFramebufferSize();
    const layout = `${packet.orientation ?? ''}|${fb.width}x${fb.height}`;
    if (this.lastLayout && layout !== this.lastLayout) this.layoutChanges++;
    this.lastLayout = layout;
  }

  /** Set the stereo prediction horizon in ms (0 disables). */
  setPrediction(ms: number): void {
    this.predictor.horizonMs = Number.isFinite(ms) ? Math.max(0, ms) : 0;
    this.predictor.reset();
  }

  /** HoloKit parameters for the current phone, IPD and framebuffer size (cached). */
  stereo(): { params: StereoParams; left: PixelRect; right: PixelRect } {
    const fb = nativeFramebufferSize();
    const info = this.deviceInfo;
    const screen = info
      ? { w: Math.max(info.screenWidthPx, info.screenHeightPx), h: Math.min(info.screenWidthPx, info.screenHeightPx) }
      : { w: Math.max(fb.width, fb.height), h: Math.min(fb.width, fb.height) };
    const { phone } = this.phone;
    const key = `${phone.identifier}|${this.ipd}|${screen.w}x${screen.h}|${fb.width}x${fb.height}`;
    if (!this.stereoCache || this.stereoCache.key !== key) {
      const params = computeStereo(phone, { ...screen, scale: devicePixelRatioOrOne() }, this.ipd, 0.1, 1000);
      this.stereoCache = { key, params };
    }
    const params = this.stereoCache.params;
    const sx = Math.max(fb.width, fb.height) / screen.w;
    const sy = Math.min(fb.width, fb.height) / screen.h;
    return { params, left: scaleRect(params.left.viewport, sx, sy), right: scaleRect(params.right.viewport, sx, sy) };
  }

  private setLocalMode(mode: RenderMode): void {
    this.mode = mode;
    const stereo = mode === 'stereo';
    this.device.stereoEnabled = stereo;
    // WebXR AR Module: what the compositor does, and how input works, in the current mode.
    // Mono shows the camera behind the content (alpha-blend) with transient screen input;
    // HoloKit is optical see-through (black is transparent: additive) with gaze input.
    const state = this.device[P_DEVICE];
    state.environmentBlendModes = {
      ...state.environmentBlendModes,
      'immersive-ar': stereo ? XREnvironmentBlendMode.Additive : XREnvironmentBlendMode.AlphaBlend,
    };
    state.interactionMode = stereo ? XRInteractionMode.WorldSpace : XRInteractionMode.ScreenSpace;
  }

  setIpd(ipd: number): void {
    this.ipd = clampIpd(ipd);
  }

  async requestNativeSession(mode: 'immersive-ar' | 'immersive-vr' | 'inline', features: string[]): Promise<SessionReply> {
    const reply = await this.transport.post({ type: 'requestSession', mode, features });
    const r = isRecord(reply) ? reply : {};
    const result: SessionReply = {
      ok: r.ok !== false,
      ...(isMode(r.mode) ? { mode: r.mode } : {}),
      ...(typeof r.frameRate === 'number' ? { frameRate: r.frameRate } : {}),
      ...(typeof r.error === 'string' ? { error: r.error } : {}),
    };
    if (result.mode) this.setLocalMode(result.mode);
    return result;
  }

  /** Tell native which ARFrame the XR frame just drawn used (fire and forget). */
  markRendered(): void {
    const latest = this.latest;
    if (!latest) return;
    this.transport.post({ type: 'rendered', t: latest.t }).catch(() => undefined);
  }

  async createNativeAnchor(pose: ArrayLike<number>): Promise<string> {
    const reply = await this.transport.post({ type: 'createAnchor', pose: Array.from(pose) });
    const id = isRecord(reply) ? reply.id : undefined;
    if (typeof id !== 'string' && typeof id !== 'number') {
      throw new DOMException('Native anchor creation failed', 'OperationError');
    }
    return String(id);
  }

  async deleteNativeAnchor(id: string): Promise<void> {
    await this.transport.post({ type: 'deleteAnchor', id });
  }

  async endNativeSession(): Promise<void> {
    await this.transport.post({ type: 'endSession' });
  }

  /** Ask native to switch mono/stereo; the next frame packet carries the new mode. */
  async setMode(mode: RenderMode): Promise<boolean> {
    const reply = await this.transport.post({ type: 'setMode', mode });
    const ok = !isRecord(reply) || reply.ok !== false;
    if (ok) this.setLocalMode(mode);
    return ok;
  }

  /** Native ARSession.raycast (one IPC round trip). Origin/direction in world space, metres. */
  async hitTest(origin: ArrayLike<number>, direction: ArrayLike<number>): Promise<HitTestHit[]> {
    const reply = await this.transport.post({
      type: 'hitTest',
      origin: Array.from(origin).slice(0, 3),
      direction: Array.from(direction).slice(0, 3),
    });
    return isRecord(reply) && Array.isArray(reply.hits) ? (reply.hits as HitTestHit[]) : [];
  }

  log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void {
    this.transport.post({ type: 'log', level, message }).catch(() => undefined);
  }
}
