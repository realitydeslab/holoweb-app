// @vitest-environment happy-dom
import { mat4 } from 'gl-matrix';
import { beforeAll, describe, expect, it } from 'vitest';
import type { HoloWebGlobal } from '../src/index.js';
import { computeStereo, applyDepthRange } from '../src/stereo.js';
import { lookupPhone } from '../src/phones.js';

type Msg = Record<string, unknown> & { type: string };
const posted: Msg[] = [];
const replies: Record<string, unknown> = {
  ready: {
    ok: true,
    device: { model: 'iPhone16,1', screenWidthPx: 2556, screenHeightPx: 1179, scale: 3, dpi: 460 },
    mode: 'mono',
  },
  requestSession: { ok: true, mode: 'mono', frameRate: 60 },
  endSession: { ok: true },
  setMode: { ok: true },
  hitTest: { hits: [{ pose: Array.from(mat4.create()), type: 'plane' }] },
};

let hw: HoloWebGlobal;
// Minimal structural view of the IWER objects the tests touch.
interface TestView { eye: string; projectionMatrix: Float32Array; transform: { matrix: Float32Array } }
interface TestFrame {
  getViewerPose(space: unknown): { views: TestView[]; transform: { matrix: Float32Array } } | null;
  getHitTestResults(source: unknown): { getPose(space: unknown): { transform: { matrix: Float32Array } } }[];
}
interface TestSession {
  enabledFeatures: string[];
  renderState: { layers: unknown[] };
  updateRenderState(s: Record<string, unknown>): void;
  requestReferenceSpace(t: string): Promise<unknown>;
  requestAnimationFrame(cb: (t: number, f: TestFrame) => void): number;
  requestHitTestSource(o: { space: unknown }): Promise<unknown>;
  addEventListener(t: string, cb: () => void): void;
  end(): Promise<void>;
}
interface TestXR {
  isSessionSupported(mode: string): Promise<boolean>;
  requestSession(mode: string, init?: Record<string, unknown>): Promise<TestSession>;
}
const xr = () => (navigator as unknown as { xr: TestXR }).xr;
/** Run fn inside the next XR frame callback (XRFrame is only valid there). */
const inFrame = <T>(s: TestSession, fn: (f: TestFrame) => T = () => undefined as T) =>
  new Promise<T>((resolve, reject) =>
    s.requestAnimationFrame((_t, f) => {
      try {
        resolve(fn(f));
      } catch (e) {
        reject(e);
      }
    }),
  );

// Camera 1.5 m up, rotated 90 degrees about Y (looking along -X).
const camPose = mat4.fromRotationTranslation(mat4.create(), [0, Math.SQRT1_2, 0, Math.SQRT1_2], [0.5, 1.5, -2]);
const invert = (m: mat4): mat4 => mat4.invert(mat4.create(), m) ?? mat4.create();
const camView = invert(camPose);
const arkitProj = mat4.perspective(mat4.create(), 1.0, 0.5, 0.01, 1000);

beforeAll(async () => {
  (globalThis as Record<string, unknown>).WebGL2RenderingContext = class {};
  (globalThis as Record<string, unknown>).webkit = {
    messageHandlers: {
      holoweb: {
        postMessage: (m: Msg) => {
          posted.push(m);
          return Promise.resolve(replies[m.type] ?? { ok: true });
        },
      },
    },
    createJSHandle: (value: object) => ({ handleFor: value }),
  };
  await import('../src/index.js');
  hw = (globalThis as unknown as { __holoweb: HoloWebGlobal }).__holoweb;
  await Promise.resolve();
});

describe('bridge ready handshake', () => {
  it('posts ready with a WKJSHandle wrapping the callbacks object', () => {
    const ready = posted.find((m) => m.type === 'ready');
    expect(ready).toBeDefined();
    const handle = ready?.bridge as { handleFor: Record<string, unknown> };
    expect(typeof handle.handleFor.onFrame).toBe('function');
    expect(typeof handle.handleFor.onPlanes).toBe('function');
    expect(typeof handle.handleFor.onSessionEnded).toBe('function');
  });

  it('stores the device info from the ready reply', () => {
    expect(hw.bridge.deviceInfo?.model).toBe('iPhone16,1');
    expect(hw.bridge.phone.match).toBe('exact');
  });

  it('installs navigator.xr and supports immersive-ar', async () => {
    await expect(xr().isSessionSupported('immersive-ar')).resolves.toBe(true);
    await expect(xr().isSessionSupported('immersive-vr')).resolves.toBe(false);
  });
});

describe('immersive-ar session', () => {
  let session: TestSession;

  beforeAll(async () => {
    session = await xr().requestSession('immersive-ar', {
      requiredFeatures: ['hit-test'],
      optionalFeatures: ['local-floor', 'dom-overlay', 'anchors', 'light-estimation', 'webgpu', 'plane-detection'],
    });
    // A layers-only render state (as XRGPUBinding uses) drives the frame loop without WebGL.
    session.updateRenderState({ layers: [{}], depthNear: 0.1, depthFar: 50 });
  });

  it('asks native to start and echoes granted features including webgpu', () => {
    const req = posted.find((m) => m.type === 'requestSession');
    expect(req?.mode).toBe('immersive-ar');
    expect(session.enabledFeatures).toEqual(expect.arrayContaining(['hit-test', 'webgpu', 'dom-overlay', 'local']));
    expect(session.enabledFeatures).not.toContain('plane-detection');
    expect(req?.features).toEqual(session.enabledFeatures);
  });

  it('resolves the native requestSession reply', async () => {
    await expect(hw.bridge.requestNativeSession('immersive-ar', ['local'])).resolves.toEqual({
      ok: true,
      mode: 'mono',
      frameRate: 60,
    });
  });

  it('mono onFrame sets the viewer pose and the native projection (depth rewritten)', async () => {
    hw.onFrame(1, 'mono', Array.from(camPose), Array.from(camView), Array.from(arkitProj), null, 'normal');
    const local = await session.requestReferenceSpace('local');
    await inFrame(session); // pending render state applies on this frame
    const pose = await inFrame(session, (f) => f.getViewerPose(local));
    expect(pose?.views).toHaveLength(1);
    const view = pose!.views[0];
    expect(view.eye).toBe('none');
    for (let i = 0; i < 16; i++) expect(view.transform.matrix[i]).toBeCloseTo(camPose[i], 5);
    const expected = applyDepthRange(new Float32Array(arkitProj), 0.1, 50);
    for (let i = 0; i < 16; i++) expect(view.projectionMatrix[i]).toBeCloseTo(expected[i], 5);
  });

  it('stereo onFrame gives two HoloKit eyes around the centre eye', async () => {
    hw.onFrame(2, 'stereo', Array.from(camPose), Array.from(camView), Array.from(arkitProj), null, 'normal');
    const local = await session.requestReferenceSpace('local');
    const pose = await inFrame(session, (f) => f.getViewerPose(local));
    expect(pose?.views.map((v) => v.eye)).toEqual(['left', 'right']);
    const s = computeStereo(lookupPhone('iPhone16,1').phone, { w: 2556, h: 1179, scale: 3 }, 0.064, 0.1, 50);
    const centre = mat4.translate(mat4.create(), camPose, s.cameraToCenterEye);
    for (let i = 0; i < 16; i++) expect(pose!.transform.matrix[i]).toBeCloseTo(centre[i], 5);
    const left = mat4.translate(mat4.create(), centre, [-0.032, 0, 0]);
    for (let i = 12; i < 15; i++) expect(pose!.views[0].transform.matrix[i]).toBeCloseTo(left[i], 5);
    for (let i = 0; i < 16; i++) expect(pose!.views[1].projectionMatrix[i]).toBeCloseTo(s.right.projection[i], 5);
    const vp = hw.bridge.device.nativeViewports;
    expect(vp.left?.width).toBeGreaterThan(0);
    expect(vp.left?.y).toBe(vp.right?.y);
    hw.onFrame(3, 'mono', Array.from(camPose), Array.from(camView), Array.from(arkitProj), null, 'normal');
    expect(hw.bridge.device.stereoEnabled).toBe(false);
  });

  it('hit-tests the viewer ray against planes from onPlanes', async () => {
    // camera at y=1.5 looking straight down
    const down = mat4.fromRotationTranslation(mat4.create(), [-Math.SQRT1_2, 0, 0, Math.SQRT1_2], [0.2, 1.5, -1]);
    hw.onFrame(4, 'mono', Array.from(down), Array.from(invert(down)), Array.from(arkitProj), null, 'normal');
    hw.onPlanes([{ id: 1, transform: Array.from(mat4.create()), extent: [4, 4], orientation: 'horizontal' }]);
    const viewer = await session.requestReferenceSpace('viewer');
    const local = await session.requestReferenceSpace('local');
    const source = await session.requestHitTestSource({ space: viewer });
    await inFrame(session);
    const poses = await inFrame(session, (f) => f.getHitTestResults(source).map((r) => r.getPose(local)));
    expect(poses).toHaveLength(1);
    const m = poses[0].transform.matrix;
    expect([m[12], m[13], m[14]].map((v) => +v.toFixed(4))).toEqual([0.2, 0, -1]);
    expect(m[5]).toBeCloseTo(1, 5); // pose Y axis = plane normal
  });

  it('uses transform as the display-oriented pose, records latency, and posts rendered per XR frame', async () => {
    const sentAt = performance.timeOrigin + performance.now() - 5;
    // view deliberately inconsistent: the protocol says transform is authoritative
    hw.onFrame(42, 'mono', Array.from(camPose), Array.from(mat4.create()), Array.from(arkitProj), null, 'normal', 'landscapeRight', sentAt);
    expect(hw.bridge.latest?.orientation).toBe('landscapeRight');
    expect(hw.bridge.latest?.latencyMs).toBeGreaterThanOrEqual(5);
    const local = await session.requestReferenceSpace('local');
    const before = posted.filter((m) => m.type === 'rendered').length;
    const pose = await inFrame(session, (f) => f.getViewerPose(local));
    for (let i = 0; i < 16; i++) expect(pose!.transform.matrix[i]).toBeCloseTo(camPose[i], 5);
    await inFrame(session);
    const rendered = posted.filter((m) => m.type === 'rendered');
    expect(rendered.length).toBeGreaterThanOrEqual(before + 2);
    expect(rendered.at(-1)).toEqual({ type: 'rendered', t: 42 });
  });

  it('routes native hitTest through the message handler', async () => {
    const hits = await hw.hitTest([0, 0, 0], [0, 0, -1]);
    expect(hits[0].type).toBe('plane');
    expect(posted.at(-1)).toMatchObject({ type: 'hitTest', origin: [0, 0, 0], direction: [0, 0, -1] });
  });

  it('posts endSession when the page ends the session', async () => {
    const before = posted.filter((m) => m.type === 'endSession').length;
    await session.end();
    expect(posted.filter((m) => m.type === 'endSession').length).toBe(before + 1);
  });
});

describe('native-initiated end', () => {
  it('ends the session without echoing endSession', async () => {
    const session = await xr().requestSession('immersive-ar');
    const ended = new Promise<void>((resolve) => session.addEventListener('end', () => resolve()));
    const before = posted.filter((m) => m.type === 'endSession').length;
    hw.onSessionEnded('interrupted');
    await ended;
    expect(posted.filter((m) => m.type === 'endSession').length).toBe(before);
  });
});
