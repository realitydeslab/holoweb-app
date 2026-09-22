/**
 * Desktop stand-in for the iOS app: answers the `holoweb` messages and pushes 60 Hz
 * frames from an orbiting camera. Used only when window.webkit is absent.
 *
 * Like native without WKJSHandle support, it calls window.__holoweb.onFrame(...), i.e. the
 * evaluateJavaScript fallback path. Query overrides: ?holoweb-mode=stereo,
 * ?holoweb-model=iPhone17,1.
 */
import { mat4 } from 'gl-matrix';
import type { NativeCallbacks, RenderMode } from './bridge.js';
import { mockEnvironment, mockMeshes, mockPlanes } from './mock-environment.js';
import { mockHand } from './mock-hands.js';
import type { Transport } from './webkit.js';

const FRAME_MS = 1000 / 60;

export interface MockOptions {
  mode?: RenderMode;
  model?: string;
  /** Resolves the callbacks object native would call (window.__holoweb). */
  target?: () => NativeCallbacks | undefined;
}

/** Camera-to-world pose of the mock camera at time t (seconds). */
export function mockCameraPose(t: number): mat4 {
  const m = mat4.create();
  mat4.translate(m, m, [0.3 * Math.sin(t * 0.5), 0, 0.3 * Math.cos(t * 0.5)]);
  mat4.rotateY(m, m, 0.35 * Math.sin(t * 0.3));
  mat4.rotateX(m, m, -0.6);
  return m;
}


function queryParam(name: string): string | undefined {
  try {
    return new URLSearchParams(globalThis.location?.search ?? '').get(name) ?? undefined;
  } catch {
    return undefined;
  }
}

export function createMockTransport(options: MockOptions = {}): Transport {
  let mode: RenderMode = options.mode ?? (queryParam('holoweb-mode') === 'stereo' ? 'stereo' : 'mono');
  const model = options.model ?? queryParam('holoweb-model') ?? 'iPhone16,1';
  const target =
    options.target ?? (() => (globalThis as unknown as { __holoweb?: NativeCallbacks }).__holoweb);
  let timer: ReturnType<typeof setInterval> | null = null;
  let frameIndex = 0;
  const start = performance.now();
  // Anchors stay where they were created (a static world); echoed at 10 Hz like native.
  const anchors = new Map<string, number[]>();
  let nextAnchor = 1;
  // Like native, hand tracking (Vision) runs only for sessions that asked for it.
  let handsOn = false;
  // Image tracking: widths of the trackable images (setTrackedImages); image 0 is "seen" 0.5 m ahead.
  let trackedWidths: (number | null)[] = [];
  let imageAnchor: number[] | null = null;

  const pushFrame = () => {
    const cb = target();
    if (!cb) return;
    if (++frameIndex % 6 === 0 && anchors.size > 0) {
      cb.onAnchors([...anchors].map(([id, transform]) => ({ id, transform })));
    }
    const t = (performance.now() - start) / 1000;
    const pose = mockCameraPose(t);
    const view = mat4.invert(mat4.create(), pose) ?? mat4.create();
    const aspect = globalThis.innerWidth / Math.max(1, globalThis.innerHeight);
    const proj = mat4.perspective(mat4.create(), (60 * Math.PI) / 180, aspect, 0.01, 1000);
    cb.onFrame(
      performance.now(),
      mode,
      Array.from(pose),
      Array.from(view),
      Array.from(proj),
      { ambientIntensity: 1000, ambientColorTemperature: 6500 },
      'normal',
      innerWidth >= innerHeight ? 'landscapeRight' : 'portrait',
      Date.now(),
    );
    // Vision runs at ~30 Hz on device
    if (imageAnchor && trackedWidths[0]) {
      // tracked for a second, then emulated (out of view) for a second, like a phone panning away
      const tracked = Math.floor(t) % 2 === 0;
      cb.onImages([{ index: 0, transform: imageAnchor, tracked, measuredWidthInMeters: trackedWidths[0] }]);
    }
    if (handsOn && frameIndex % 2 === 0) cb.onHands({ t: performance.now(), hands: [mockHand(pose, performance.now() - start)] });
  };

  const stop = () => {
    if (timer !== null) clearInterval(timer);
    timer = null;
  };

  const dpr = globalThis.devicePixelRatio || 1;
  const handlers: Record<string, (msg: Record<string, unknown>) => unknown> = {
    ready: () => ({
      ok: true,
      device: {
        model,
        screenWidthPx: Math.round(globalThis.innerWidth * dpr),
        screenHeightPx: Math.round(globalThis.innerHeight * dpr),
        scale: dpr,
        dpi: 460,
      },
      mode,
      // like an iPhone Pro: LiDAR scene reconstruction and depth
      capabilities: { lidar: true, sceneReconstruction: true, handTracking: true },
    }),
    requestSession: (msg) => {
      stop();
      const features = Array.isArray(msg.features) ? (msg.features as string[]) : [];
      handsOn = features.includes('hand-tracking');
      const ahead = mat4.translate(mat4.create(), mockCameraPose((performance.now() - start) / 1000), [0, 0, -0.5]);
      imageAnchor = features.includes('image-tracking') ? Array.from(ahead) : null;
      if (features.includes('mesh-detection')) {
        setTimeout(() => target()?.onMeshes(mockMeshes(false, 0) as never), 100);
        setTimeout(() => timer !== null && target()?.onMeshes(mockMeshes(true, performance.now()) as never), 1500);
      }
      pushFrame();
      timer = setInterval(pushFrame, FRAME_MS);
      const t0 = performance.now();
      setTimeout(() => target()?.onPlanes(mockPlanes(false, t0)), 0);
      setTimeout(() => target()?.onEnvironment(mockEnvironment(32, 1, t0)), 50);
      // one plane update and one new reflection map later in the session (native: <= 10 Hz / <= 1 Hz)
      setTimeout(() => timer !== null && target()?.onPlanes(mockPlanes(true, performance.now())), 1000);
      setTimeout(() => timer !== null && target()?.onEnvironment(mockEnvironment(32, 0.9, performance.now())), 2000);
      return { ok: true, mode, frameRate: 60 };
    },
    endSession: () => {
      stop();
      handsOn = false;
      imageAnchor = null;
      anchors.clear();
      return { ok: true };
    },
    setMode: (msg) => {
      mode = msg.mode === 'stereo' ? 'stereo' : 'mono';
      return { ok: true };
    },
    // ARKit rejects images without enough detail; the mock calls 1x1 images untrackable
    setTrackedImages: (msg) => {
      const images = Array.isArray(msg.images) ? (msg.images as { index: number; width: number; height: number; widthInMeters: number }[]) : [];
      trackedWidths = [];
      // scores follow the order of `images`; results use each image's `index`
      const scores = images.map((img) => {
        const ok = img.width * img.height > 1;
        trackedWidths[img.index] = ok ? img.widthInMeters : null;
        return ok ? 'trackable' : 'untrackable';
      });
      return { scores };
    },
    hitTest: () => ({ hits: [] }),
    rendered: () => null,
    createAnchor: (msg) => {
      const id = `mock-anchor-${nextAnchor++}`;
      anchors.set(id, Array.isArray(msg.pose) ? (msg.pose as number[]) : Array.from(mat4.create()));
      return { id };
    },
    deleteAnchor: (msg) => {
      anchors.delete(String(msg.id));
      return { ok: true };
    },
    log: (msg) => {
      console.log(`[holoweb-native:${String(msg.level)}] ${String(msg.message)}`);
      return { ok: true };
    },
  };

  return {
    kind: 'mock',
    post: async (message) => {
      const handler = handlers[String(message.type)];
      if (!handler) throw new Error(`mock-native: unknown message ${String(message.type)}`);
      return handler(message);
    },
    createHandle: () => null,
  };
}
