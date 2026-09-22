/**
 * Session lifecycle glue between IWER's XRSystem and the native bridge.
 *
 * - immersive sessions (immersive-ar, immersive-vr) call native `requestSession` with their mode (native starts ARKit frames; for VR it draws black instead of the camera) and
 *   `endSession` when the page or native ends the session, and post `rendered { t }` after each
 *   XR frame. Inline sessions stay JS-only.
 * - Reference spaces follow plan/bridge_protocol.md: `local` = ARKit world origin,
 *   `local-floor` follows FloorTracker (floor.ts), which dispatches `reset` when the floor moves.
 * - While immersive, page content is hidden (as in a real immersive session) except the XR
 *   canvases and the dom-overlay root, and html/body backgrounds are transparent so the native
 *   camera view (mono) or black (stereo) shows through.
 * - dom-overlay: the overlay root is raised above IWER's canvas container.
 * - Native may switch mono <-> stereo at any time (view count 1 <-> 2); sessions keep running.
 *   WebGL pages follow directly; XRGPUBinding sessions rely on the priming view in gpu-binding.ts.
 */
import { mat4 } from 'gl-matrix';
import { P_DEVICE, P_SESSION, P_SPACE, P_SYSTEM, XRDevice, XRReferenceSpace, XRSession, XRSystem } from 'iwer';
import type { XRSessionInit, XRSessionMode } from 'iwer/lib/session/XRSession.js';
import type { HoloWebBridge } from './bridge.js';
import { addFrameEndListener } from './device.js';
import { FloorTracker } from './floor.js';
import { SNAPSHOTS, type ImageTracking, type SnapshotOptions } from './image-tracking.js';
import type { ScreenInput } from './input.js';

const OVERLAY_Z_INDEX = '1000';

type SessionOptions = XRSessionInit & { domOverlay?: { root?: Element } } & Pick<SnapshotOptions, typeof SNAPSHOTS>;

function patchReferenceSpaces(session: XRSession, floor: FloorTracker): void {
  const original = session.requestReferenceSpace.bind(session);
  session.requestReferenceSpace = async (type) => {
    const space: XRReferenceSpace = await original(type);
    if (type === 'local') {
      // IWER anchors `local` at the viewer pose at request time; ARKit's origin is gravity aligned.
      mat4.identity(space[P_SPACE].offsetMatrix);
    } else if (type === 'local-floor') {
      floor.track(space);
    }
    return space;
  };
}

const IMMERSIVE_CLASS = 'holoweb-immersive';
/** The overlay root contains the page body: XR layers go behind the overlay content (as in Chrome). */
const XR_BEHIND_CLASS = 'holoweb-xr-behind';
const IMMERSIVE_CSS = `
html.${IMMERSIVE_CLASS}, html.${IMMERSIVE_CLASS} body { background: transparent !important; }
html.${IMMERSIVE_CLASS} body * { visibility: hidden !important; }
html.${IMMERSIVE_CLASS} [data-holoweb-xr], html.${IMMERSIVE_CLASS} [data-holoweb-xr] *,
html.${IMMERSIVE_CLASS} [data-holoweb-overlay], html.${IMMERSIVE_CLASS} [data-holoweb-overlay] * {
  visibility: visible !important;
}
html.${XR_BEHIND_CLASS} [data-holoweb-xr] { z-index: -1 !important; pointer-events: none !important; }`;

/** Hide page content for the duration of an immersive session; returns the restore function. */
function enterImmersiveStyle(device: XRDevice, overlayRoot: Element | undefined): () => void {
  if (!document.getElementById('holoweb-immersive-style')) {
    const style = document.createElement('style');
    style.id = 'holoweb-immersive-style';
    style.textContent = IMMERSIVE_CSS;
    (document.head ?? document.documentElement).appendChild(style);
  }
  device.canvasContainer.dataset.holowebXr = '';
  overlayRoot?.setAttribute('data-holoweb-overlay', '');
  const html = document.documentElement;
  html.classList.add(IMMERSIVE_CLASS);
  // With root = <body> (or <html>) the XR canvases are inside the overlay root; a z-index above the
  // root would cover the overlay, so they drop behind the page content instead.
  const bodyOverlay = Boolean(overlayRoot && document.body && overlayRoot.contains(document.body));
  if (bodyOverlay) html.classList.add(XR_BEHIND_CLASS);
  return () => {
    html.classList.remove(IMMERSIVE_CLASS, XR_BEHIND_CLASS);
    overlayRoot?.removeAttribute('data-holoweb-overlay');
  };
}

function raiseOverlay(root: Element | undefined): (() => void) | null {
  if (!(root instanceof HTMLElement)) return null;
  const saved = { zIndex: root.style.zIndex, position: root.style.position };
  root.style.zIndex = OVERLAY_Z_INDEX;
  if (getComputedStyle(root).position === 'static') root.style.position = 'relative';
  return () => {
    root.style.zIndex = saved.zIndex;
    root.style.position = saved.position;
  };
}

/**
 * Frame-level XRSystem adjustments:
 * - `ready` is posted on the first isSessionSupported / requestSession of this frame (bridge.ensureReady).
 * - offerSession is removed: HoloWeb cannot offer immersive-vr, and A-Frame (xr-mode-ui XRMode: xr) calls
 *   it at load and reports an unhandled "Failed to enter VR mode" when it rejects; without the method it
 *   skips the offer and keeps its AR button.
 */
export function installFrameHooks(device: XRDevice, bridge: HoloWebBridge): void {
  const xr = device[P_DEVICE].xrSystem;
  if (!(xr instanceof XRSystem)) throw new Error('HoloWeb: installRuntime must run before frame hooks');
  delete (XRSystem.prototype as unknown as Record<string, unknown>).offerSession;
  const isSessionSupported = xr.isSessionSupported.bind(xr);
  const requestSession = xr.requestSession.bind(xr);
  const sessions = new SessionSlots(xr);
  xr.isSessionSupported = async (mode) => {
    await bridge.ensureReady();
    return isSessionSupported(mode);
  };
  xr.requestSession = async (mode, options) => {
    await bridge.ensureReady();
    // IWER rejects unsupported required features with a plain Error; the spec wants NotSupportedError.
    const unsupported = (options?.requiredFeatures ?? []).filter((f) => !device.supportedFeatures.includes(f));
    if (unsupported.length > 0) {
      throw new DOMException(`Required features not supported: ${unsupported.join(', ')}`, 'NotSupportedError');
    }
    const parked = mode === 'inline' ? null : sessions.parkInline();
    try {
      const session = await requestSession(mode, options);
      sessions.track(session);
      return session;
    } catch (err) {
      if (parked) sessions.unpark(parked);
      throw err;
    }
  };
}

/**
 * Session bookkeeping: IWER allows one XRSession at a time and its `end` listener clears activeSession unconditionally.
 * Pages often hold an inline ("magic window") session and then enter AR, so:
 * - requesting an immersive session parks the active inline session (it stays valid but its frame
 *   loop idles without running callbacks, as in Chrome while presenting) and grants the immersive one;
 * - when any session ends, the remaining live session becomes active again (immersive first) and a
 *   parked inline session resumes; a second immersive session is still rejected by IWER.
 */
class SessionSlots {
  private readonly live = new Set<XRSession>();
  private readonly parked = new Set<XRSession>();

  constructor(private readonly xr: XRSystem) {}

  /** Park the active inline session so an immersive one can be granted. */
  parkInline(): XRSession | null {
    const active = this.xr[P_SYSTEM].activeSession;
    if (!active || active[P_SESSION].mode !== 'inline') return null;
    this.parked.add(active);
    this.xr[P_SYSTEM].activeSession = undefined;
    return active;
  }

  unpark(session: XRSession): void {
    this.parked.delete(session);
    if (!session[P_SESSION].ended && !this.xr[P_SYSTEM].activeSession) this.xr[P_SYSTEM].activeSession = session;
  }

  track(session: XRSession): void {
    this.live.add(session);
    const state = session[P_SESSION];
    const inline = state.mode === 'inline';
    const frame = state.onDeviceFrame;
    // Idle (keep the loop, run no callbacks): a parked inline session, or an immersive session while
    // the app is hidden (visibility.ts). IWER reschedules through this property, so the wrapper stays.
    state.onDeviceFrame = () => {
      if (state.ended) return;
      const hidden = state.device[P_DEVICE].visibilityState === 'hidden';
      if (inline ? this.parked.has(session) : hidden) {
        state.deviceFrameHandle = globalThis.requestAnimationFrame(state.onDeviceFrame);
        return;
      }
      frame();
    };
    // registered after IWER's own listener, which has just cleared activeSession
    session.addEventListener('end', () => this.onEnd(session), { once: true });
  }

  private onEnd(session: XRSession): void {
    this.live.delete(session);
    this.parked.delete(session);
    const remaining = [...this.live];
    const immersive = remaining.find((s) => s[P_SESSION].mode !== 'inline');
    const next = immersive ?? remaining.find((s) => s[P_SESSION].mode === 'inline');
    if (!immersive) this.parked.clear();
    this.xr[P_SYSTEM].activeSession = next;
  }
}

export function installSessionHooks(
  device: XRDevice,
  bridge: HoloWebBridge,
  input: ScreenInput,
  images: ImageTracking,
  /** Per-session native state to drop when an immersive session ends (anchors, hands, planes, maps). */
  onSessionEnd: () => void,
): void {
  const xr = device[P_DEVICE].xrSystem;
  if (!(xr instanceof XRSystem)) throw new Error('HoloWeb: installRuntime must run before session hooks');
  const iwerRequestSession = xr.requestSession.bind(xr);

  xr.requestSession = async (mode: XRSessionMode, options: SessionOptions = {}): Promise<XRSession> => {
    // image-tracking: images were snapshotted in the page's call (installImageSnapshot)
    const snapshots = options[SNAPSHOTS] ?? Promise.resolve([]);
    const session = await iwerRequestSession(mode, options);
    const floor = new FloorTracker(bridge.environment.planeData);
    patchReferenceSpaces(session, floor);
    if (mode === 'inline') return session;

    let endedByNative = false;
    try {
      if ((session.enabledFeatures as readonly string[]).includes('image-tracking')) {
        // native needs the detection images before it configures the ARSession
        const scores = snapshots.then((s) => bridge.setTrackedImages(s));
        images.setScores(session, scores);
        await scores;
      }
      const reply = await bridge.requestNativeSession(mode, [...session.enabledFeatures]);
      if (!reply.ok) throw new DOMException(reply.error ?? 'Native AR session refused', 'NotSupportedError');
    } catch (err) {
      endedByNative = true;
      await session.end().catch(() => undefined);
      throw err instanceof DOMException ? err : new DOMException(String(err), 'NotSupportedError');
    }

    const overlayEnabled = session.enabledFeatures.includes('dom-overlay');
    const overlayRoot = overlayEnabled ? options.domOverlay?.root : undefined;
    const restoreOverlay = raiseOverlay(overlayRoot);
    if (restoreOverlay) {
      Object.defineProperty(session, 'domOverlayState', { configurable: true, value: { type: 'screen' } });
    }
    const restoreStyle = enterImmersiveStyle(device, overlayRoot);
    // Native draws the camera image matching the pose used for each XR frame.
    const removeRendered = addFrameEndListener(device, (frame) => {
      if (frame.session === session) bridge.markRendered();
    });
    const onPlanes = (planes: Parameters<FloorTracker['update']>[0]) => floor.update(planes);
    bridge.planeListeners.add(onPlanes);
    input.attach(session, overlayRoot ?? null);

    bridge.onNativeSessionEnded = () => {
      endedByNative = true;
      session.end().catch(() => undefined);
    };
    session.addEventListener(
      'end',
      () => {
        input.detach();
        restoreOverlay?.();
        restoreStyle();
        removeRendered();
        bridge.planeListeners.delete(onPlanes);
        onSessionEnd();
        bridge.onNativeSessionEnded = null;
        if (!endedByNative) bridge.endNativeSession().catch((e) => console.warn('HoloWeb endSession', e));
      },
      { once: true },
    );
    return session;
  };
}
