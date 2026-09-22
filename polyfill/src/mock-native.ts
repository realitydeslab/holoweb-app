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
import type { NativePlaneData } from './hittest.js';
import type { Transport } from './webkit.js';

const FLOOR_Y = -1.3;
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

export function mockFloorPlane(): NativePlaneData {
  const transform = Array.from(mat4.fromTranslation(mat4.create(), [0, FLOOR_Y, -1]));
  return { id: 'mock-floor', transform, extent: [8, 8], orientation: 'horizontal' };
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
  const start = performance.now();

  const pushFrame = () => {
    const cb = target();
    if (!cb) return;
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
    }),
    requestSession: () => {
      stop();
      pushFrame();
      timer = setInterval(pushFrame, FRAME_MS);
      setTimeout(() => target()?.onPlanes([mockFloorPlane()]), 0);
      return { ok: true, mode, frameRate: 60 };
    },
    endSession: () => {
      stop();
      return { ok: true };
    },
    setMode: (msg) => {
      mode = msg.mode === 'stereo' ? 'stereo' : 'mono';
      return { ok: true };
    },
    hitTest: () => ({ hits: [] }),
    rendered: () => null,
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
