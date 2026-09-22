// @vitest-environment happy-dom
import { mat4 } from 'gl-matrix';
import { beforeAll, describe, expect, it } from 'vitest';
import type { HoloWebGlobal } from '../src/index.js';
import { computeStereo, applyDepthRange } from '../src/stereo.js';
import { lookupPhone } from '../src/phones.js';
import { extrapolatePose } from '../src/prediction.js';
import { lightTerms } from '../src/light.js';

type Msg = Record<string, unknown> & { type: string };
const posted: Msg[] = [];
let anchorSeq = 0;
const replies: Record<string, unknown> = {
  createAnchor: () => ({ id: `a${++anchorSeq}` }),
  deleteAnchor: { ok: true },
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
interface TestAnchor { anchorSpace: unknown; delete(): void }
interface TestLightEstimate { sphericalHarmonicsCoefficients: Float32Array; primaryLightIntensity: DOMPointReadOnly }
interface TestFrame {
  trackedAnchors: Set<TestAnchor>;
  createAnchor(pose: unknown, space: unknown): Promise<TestAnchor>;
  getPose(space: unknown, base: unknown): { transform: { matrix: Float32Array } } | null;
  getLightEstimate(probe: unknown): TestLightEstimate | null;
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
  requestLightProbe(): Promise<unknown>;
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
          const r = replies[m.type];
          return Promise.resolve(typeof r === 'function' ? r(m) : (r ?? { ok: true }));
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
  it('posts ready lazily, once, on the first WebXR call, with frame: main', async () => {
    expect(posted.filter((m) => m.type === 'ready')).toHaveLength(0); // page loaded, no WebXR used yet
    await xr().isSessionSupported('immersive-ar');
    await xr().isSessionSupported('immersive-ar');
    const ready = posted.filter((m) => m.type === 'ready');
    expect(ready).toHaveLength(1);
    expect(ready[0].frame).toBe('main');
    expect('offerSession' in (navigator as unknown as { xr: object }).xr).toBe(false);
  });

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

  it('re-posts ready after a back/forward-cache restore', async () => {
    const before = posted.filter((m) => m.type === 'ready').length;
    window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: false }));
    window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }));
    await Promise.resolve();
    expect(posted.filter((m) => m.type === 'ready').length).toBe(before + 1);
  });

  it('installs navigator.xr and supports immersive-ar (and immersive-vr, opaque)', async () => {
    await expect(xr().isSessionSupported('immersive-ar')).resolves.toBe(true);
    await expect(xr().isSessionSupported('immersive-vr')).resolves.toBe(true);
  });
});

describe('immersive-ar session', () => {
  let session: TestSession;

  beforeAll(async () => {
    session = await xr().requestSession('immersive-ar', {
      requiredFeatures: ['hit-test'],
      optionalFeatures: ['local-floor', 'dom-overlay', 'anchors', 'light-estimation', 'webgpu', 'camera-access'],
    });
    // A layers-only render state (as XRGPUBinding uses) drives the frame loop without WebGL.
    session.updateRenderState({ layers: [{}], depthNear: 0.1, depthFar: 50 });
  });

  it('asks native to start and echoes granted features including webgpu', () => {
    const req = posted.find((m) => m.type === 'requestSession');
    expect(req?.mode).toBe('immersive-ar');
    expect(session.enabledFeatures).toEqual(expect.arrayContaining(['hit-test', 'webgpu', 'dom-overlay', 'local']));
    expect(session.enabledFeatures).not.toContain('camera-access');
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

  it('stereo in a portrait window keeps both eyes on the portrait framebuffer', async () => {
    const size = { w: innerWidth, h: innerHeight };
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 393 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 852 });
    try {
      hw.onFrame(2, 'stereo', Array.from(camPose), Array.from(camView), Array.from(arkitProj), null, 'normal', 'portrait');
      const fb = { width: Math.round(393 * devicePixelRatio), height: Math.round(852 * devicePixelRatio) };
      const vp = hw.bridge.device.nativeViewports;
      for (const r of [vp.left!, vp.right!]) {
        expect(r.x + r.width).toBeLessThanOrEqual(fb.width);
        expect(r.y + r.height).toBeLessThanOrEqual(fb.height);
        expect(r.height).toBeGreaterThan(r.width); // eyes stacked along the long (physical landscape) side
      }
      // left eye is nearer the device top (landscapeRight: device top points left)
      expect(vp.left!.y).toBeGreaterThan(vp.right!.y);
      // viewer right = device bottom: the centre-eye pose's x axis is the portrait camera's -y
      const local = await session.requestReferenceSpace('local');
      const pose = await inFrame(session, (f) => f.getViewerPose(local));
      const m = pose!.transform.matrix;
      expect([m[0], m[1], m[2]].map((v) => Math.round(v * 1e5) / 1e5)).toEqual(
        [-camPose[4], -camPose[5], -camPose[6]].map((v) => Math.round(v * 1e5) / 1e5 + 0),
      );
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: size.w });
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: size.h });
      hw.onFrame(3, 'mono', Array.from(camPose), Array.from(camView), Array.from(arkitProj), null, 'normal');
    }
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

describe('M7: anchors, light estimation, local-floor reset, stereo prediction', () => {
  let session: TestSession;
  // read lazily: describe bodies run before beforeAll installs the runtime
  const rigid = (p: DOMPointInit) =>
    new (globalThis as unknown as { XRRigidTransform: new (p: DOMPointInit) => unknown }).XRRigidTransform(p);
  const translation = (m: Float32Array) => [m[12], m[13], m[14]].map((v) => +v.toFixed(4));

  beforeAll(async () => {
    session = await xr().requestSession('immersive-ar', {
      optionalFeatures: ['anchors', 'light-estimation', 'local-floor', 'hit-test', 'webgpu'],
    });
    session.updateRenderState({ layers: [{}], depthNear: 0.1, depthFar: 50 });
    hw.onFrame(10, 'mono', Array.from(camPose), Array.from(camView), Array.from(arkitProj), null, 'normal');
    await inFrame(session);
  });

  it('creates native anchors, follows onAnchors, drops lost anchors, deletes on delete()', async () => {
    const local = await session.requestReferenceSpace('local');
    const pending = await inFrame(session, (f) => f.createAnchor(rigid({ x: 0.1, y: 0, z: -1 }), local));
    const anchor = await pending;
    const req = posted.filter((m) => m.type === 'createAnchor').at(-1) as unknown as { pose: number[] };
    expect(translation(Float32Array.from(req.pose))).toEqual([0.1, 0, -1]);

    const tracked = await inFrame(session, (f) => ({
      has: f.trackedAnchors.has(anchor),
      pos: translation(f.getPose(anchor.anchorSpace, local)!.transform.matrix),
    }));
    expect(tracked).toEqual({ has: true, pos: [0.1, 0, -1] });

    const id = `a${anchorSeq}`;
    hw.onAnchors([{ id, transform: Array.from(mat4.fromTranslation(mat4.create(), [0.2, 0.05, -1])) }]);
    const moved = await inFrame(session, (f) => translation(f.getPose(anchor.anchorSpace, local)!.transform.matrix));
    expect(moved).toEqual([0.2, 0.05, -1]);

    hw.onAnchors([{ id, transform: null }]);
    expect(await inFrame(session, (f) => f.trackedAnchors.has(anchor))).toBe(false);
    const deletesBefore = posted.filter((m) => m.type === 'deleteAnchor').length;
    anchor.delete(); // native already removed it: no deleteAnchor
    expect(posted.filter((m) => m.type === 'deleteAnchor').length).toBe(deletesBefore);

    const second = await (await inFrame(session, (f) => f.createAnchor(rigid({ x: 0, y: 0, z: -2 }), local)));
    second.delete();
    expect(posted.at(-1)).toEqual({ type: 'deleteAnchor', id: `a${anchorSeq}` });
    expect(await inFrame(session, (f) => f.trackedAnchors.has(second))).toBe(false);
  });

  it('provides light estimates from onFrame light', async () => {
    const probe = await session.requestLightProbe();
    const light = { ambientIntensity: 2000, ambientColorTemperature: 3000 };
    hw.onFrame(11, 'mono', Array.from(camPose), Array.from(camView), Array.from(arkitProj), light, 'normal');
    const est = await inFrame(session, (f) => f.getLightEstimate(probe));
    const expected = lightTerms(light);
    expect(est!.sphericalHarmonicsCoefficients[0]).toBeCloseTo(expected.sphericalHarmonicsCoefficients[0], 5);
    expect(est!.primaryLightIntensity.x).toBeGreaterThan(est!.primaryLightIntensity.z); // 3000 K is warm
  });

  it('moves local-floor to a new lower plane and dispatches reset', async () => {
    const floor = await session.requestReferenceSpace('local-floor');
    const local = await session.requestReferenceSpace('local');
    let resets = 0;
    (floor as EventTarget).addEventListener('reset', () => resets++);
    const plane = (y: number) => ({ id: 'p', transform: Array.from(mat4.fromTranslation(mat4.create(), [0, y, 0])), extent: [5, 5], orientation: 'horizontal' as const });
    // hit-test planes from the earlier test put the floor at y=0 only if below origin; use y < 0 here
    hw.onPlanes([plane(-0.9)]);
    const y1 = await inFrame(session, (f) => f.getPose(floor, local)!.transform.matrix[13]);
    hw.onPlanes([plane(-0.905)]); // < 2 cm: no reset
    hw.onPlanes([plane(-1.1)]);
    const y2 = await inFrame(session, (f) => f.getPose(floor, local)!.transform.matrix[13]);
    expect(y1).toBeCloseTo(-0.9, 5);
    expect(y2).toBeCloseTo(-1.1, 5);
    expect(resets).toBe(2);
  });

  it('predicts the stereo viewer pose 25 ms ahead, never in mono, and setPrediction(0) disables it', async () => {
    const local = await session.requestReferenceSpace('local');
    const at = (x: number) => mat4.fromRotationTranslation(mat4.create(), [0, 0, 0, 1], [x, 1.5, 0]);
    const s = computeStereo(lookupPhone('iPhone16,1').phone, { w: 2556, h: 1179, scale: 3 }, 0.064, 0.1, 50);
    const viewerX = () => inFrame(session, (f) => f.getViewerPose(local)!.transform.matrix[12]);

    // mono: pose follows the frame exactly even while moving
    hw.onFrame(1000, 'mono', Array.from(at(0)), Array.from(invert(at(0))), Array.from(arkitProj), null, 'normal');
    hw.onFrame(1016.67, 'mono', Array.from(at(0.01)), Array.from(invert(at(0.01))), Array.from(arkitProj), null, 'normal');
    expect(await viewerX()).toBeCloseTo(0.01, 5);

    // stereo: centre eye of the extrapolated camera pose
    hw.onFrame(2000, 'stereo', Array.from(at(0)), Array.from(invert(at(0))), Array.from(arkitProj), null, 'normal');
    hw.onFrame(2016.67, 'stereo', Array.from(at(0.01)), Array.from(invert(at(0.01))), Array.from(arkitProj), null, 'normal');
    const predicted = extrapolatePose({ t: 2000, matrix: at(0) }, { t: 2016.67, matrix: at(0.01) }, 25);
    const centre = mat4.translate(mat4.create(), predicted, s.cameraToCenterEye);
    expect(predicted[12]).toBeCloseTo(0.025, 3);
    expect(await viewerX()).toBeCloseTo(centre[12], 5);

    hw.setPrediction(0);
    hw.onFrame(2033.33, 'stereo', Array.from(at(0.02)), Array.from(invert(at(0.02))), Array.from(arkitProj), null, 'normal');
    hw.onFrame(2050, 'stereo', Array.from(at(0.03)), Array.from(invert(at(0.03))), Array.from(arkitProj), null, 'normal');
    const exact = mat4.translate(mat4.create(), at(0.03), s.cameraToCenterEye);
    expect(await viewerX()).toBeCloseTo(exact[12], 5);
    hw.setPrediction(25);
    await session.end();
  });

  it('rejects requestLightProbe without the light-estimation feature', async () => {
    const inline = await xr().requestSession('inline');
    await expect(inline.requestLightProbe()).rejects.toMatchObject({ name: 'NotSupportedError' });
    await inline.end();
  });
});

describe('view-count policy (views.ts): never fewer views than the page has seen', () => {
  interface PoseView { eye: string; projectionMatrix: Float32Array; transform: { matrix: Float32Array } }
  const eyes = (sess: TestSession, local: unknown) =>
    inFrame(sess, (f) => (f.getViewerPose(local)!.views as unknown as PoseView[]).map((v) => v));

  it('keeps one view for a mono-only session, adds an inert right view after stereo', async () => {
    const sess = await xr().requestSession('immersive-ar');
    sess.updateRenderState({ layers: [{}] });
    const local = await sess.requestReferenceSpace('local');
    hw.onFrame(1, 'mono', Array.from(camPose), Array.from(camView), Array.from(arkitProj), null, 'normal');
    await inFrame(sess);
    expect((await eyes(sess, local)).map((v) => v.eye)).toEqual(['none']);

    hw.onFrame(2, 'stereo', Array.from(camPose), Array.from(camView), Array.from(arkitProj), null, 'normal');
    expect((await eyes(sess, local)).map((v) => v.eye)).toEqual(['left', 'right']);

    hw.onFrame(3, 'mono', Array.from(camPose), Array.from(camView), Array.from(arkitProj), null, 'normal');
    const [mono, inert] = await eyes(sess, local);
    expect([mono.eye, inert.eye]).toEqual(['none', 'right']);
    expect(Array.from(inert.transform.matrix)).toEqual(Array.from(mono.transform.matrix));
    const p = inert.projectionMatrix;
    for (const i of [0, 5, 8, 10, 11, 14]) expect(p[i]).toBe(mono.projectionMatrix[i]);
    expect((p[5] * 1 + p[9] * -2) / 2).toBeLessThan(-1000); // nothing reaches the viewport
    // the WebGL layer gives the inert view a zero-area viewport
    const device = hw.bridge.device as unknown as { [k: symbol]: { getViewport: (l: unknown, v: unknown) => { width: number; height: number } } };
    const pDevice = Object.getOwnPropertySymbols(device).find((s) => String(s).includes('xr-device'))!;
    const vp = device[pDevice].getViewport({ context: { canvas: { width: 1000, height: 500 } } }, inert);
    expect([vp.width, vp.height]).toEqual([0, 0]); // true 0x0, so pages that skip empty viewports skip it
    await sess.end();
  });

  it('starts each session afresh', async () => {
    const sess = await xr().requestSession('immersive-ar');
    sess.updateRenderState({ layers: [{}] });
    const local = await sess.requestReferenceSpace('local');
    hw.onFrame(4, 'mono', Array.from(camPose), Array.from(camView), Array.from(arkitProj), null, 'normal');
    await inFrame(sess);
    expect((await eyes(sess, local)).map((v) => v.eye)).toEqual(['none']);
    await sess.end();
  });
});
