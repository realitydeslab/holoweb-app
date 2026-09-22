// @vitest-environment happy-dom
import { mat4 } from 'gl-matrix';
import { beforeAll, describe, expect, it } from 'vitest';
import { insideOutline, raycastPlanes, type NativePlaneData } from '../src/hittest.js';
import type { HoloWebGlobal } from '../src/index.js';
import { mockEnvironment, mockPlanes } from '../src/mock-environment.js';
import { planePolygon } from '../src/planes.js';

// ---- fake WebGL2 context recording texture uploads and binding state ----
class FakeGL2 {
  TEXTURE_CUBE_MAP = 0x8513; TEXTURE_BINDING_CUBE_MAP = 0x8514; TEXTURE_CUBE_MAP_POSITIVE_X = 0x8515;
  UNPACK_FLIP_Y_WEBGL = 0x9240; UNPACK_PREMULTIPLY_ALPHA_WEBGL = 0x9241; UNPACK_ALIGNMENT = 0x0cf5;
  UNPACK_ROW_LENGTH = 0x0cf2; UNPACK_SKIP_ROWS = 0x0cf3; UNPACK_SKIP_PIXELS = 0x0cf4;
  PIXEL_UNPACK_BUFFER = 0x88ec; PIXEL_UNPACK_BUFFER_BINDING = 0x88ef; SRGB8_ALPHA8 = 0x8c43; RGBA = 0x1908;
  UNSIGNED_BYTE = 0x1401; TEXTURE_MIN_FILTER = 0x2801; TEXTURE_MAG_FILTER = 0x2800; LINEAR = 0x2601;
  TEXTURE_WRAP_S = 0x2802; TEXTURE_WRAP_T = 0x2803; CLAMP_TO_EDGE = 0x812f;
  state = new Map<number, unknown>([[0x9240, true], [0x9241, true], [0x0cf5, 1], [0x0cf2, 7], [0x0cf3, 0], [0x0cf4, 0], [0x88ef, 'pageBuffer'], [0x8514, 'pageCube']]);
  uploads: { target: number; internal: number; size: number; bytes: number; flipY: unknown }[] = [];
  created = 0;
  getParameter(p: number) { return this.state.get(p) ?? null; }
  pixelStorei(p: number, v: unknown) { this.state.set(p, v); }
  bindTexture(_t: number, tex: unknown) { this.state.set(0x8514, tex); }
  bindBuffer(_t: number, b: unknown) { this.state.set(0x88ef, b); }
  createTexture() { this.created++; return { id: `cube${this.created}` }; }
  texParameteri() {}
  getExtension() { return null; }
  texImage2D(target: number, _l: number, internal: number, w: number, _h: number, _b: number, _f: number, _t: number, data: Uint8Array) {
    this.uploads.push({ target, internal, size: w, bytes: data.length, flipY: this.state.get(0x9240) });
  }
}

type Msg = Record<string, unknown> & { type: string };
interface Plane { planeSpace: unknown; polygon: DOMPointReadOnly[]; orientation: string; lastChangedTime: number }
interface Frame {
  detectedPlanes: Set<Plane>;
  getPose(s: unknown, b: unknown): { transform: { matrix: Float32Array } } | null;
}
interface Probe extends EventTarget { onreflectionchange: ((e: Event) => void) | null }
interface Session {
  updateRenderState(s: Record<string, unknown>): void;
  requestReferenceSpace(t: string): Promise<unknown>;
  requestAnimationFrame(cb: (t: number, f: Frame) => void): number;
  requestLightProbe(o?: { reflectionFormat?: string }): Promise<Probe>;
  end(): Promise<void>;
}
let hw: HoloWebGlobal;
let anchorIds = 0;
const xr = () => (navigator as unknown as { xr: { requestSession(m: string, i?: object): Promise<Session> } }).xr;
const inFrame = <T>(s: Session, fn: (f: Frame) => T) =>
  new Promise<T>((resolve, reject) => s.requestAnimationFrame((_t, f) => { try { resolve(fn(f)); } catch (e) { reject(e); } }));

async function start(features: string[]): Promise<{ session: Session; local: unknown }> {
  const session = await xr().requestSession('immersive-ar', { optionalFeatures: features });
  session.updateRenderState({ layers: [{}] });
  hw.onFrame(1, 'mono', Array.from(mat4.create()), Array.from(mat4.create()), Array.from(mat4.perspective(mat4.create(), 1, 2, 0.01, 100)), null, 'normal');
  const local = await session.requestReferenceSpace('local');
  await inFrame(session, () => undefined);
  return { session, local };
}

beforeAll(async () => {
  (globalThis as Record<string, unknown>).WebGL2RenderingContext = FakeGL2;
  (globalThis as Record<string, unknown>).webkit = {
    messageHandlers: {
      holoweb: {
        postMessage: (m: Msg) =>
          Promise.resolve(m.type === 'requestSession' ? { ok: true, mode: 'mono' } : m.type === 'createAnchor' ? { id: `a${++anchorIds}` } : { ok: true }),
      },
    },
  };
  await import('../src/index.js');
  hw = (globalThis as unknown as { __holoweb: HoloWebGlobal }).__holoweb;
});

describe('plane geometry', () => {
  it('uses the native polygon, else the extent rectangle', () => {
    const plane: NativePlaneData = { id: 1, transform: Array.from(mat4.create()), extent: [2, 1], orientation: 'horizontal' };
    expect(planePolygon(plane)).toEqual([-1, 0, -0.5, -1, 0, 0.5, 1, 0, 0.5, 1, 0, -0.5]);
    expect(planePolygon({ ...plane, polygon: [0, 0, 0, 1, 0, 0, 0, 0, 1] })).toEqual([0, 0, 0, 1, 0, 0, 0, 0, 1]);
  });

  it('hit-tests against the polygon, not just the extent', () => {
    const table = mockPlanes(false, 0).find((p) => p.id === 'mock-table')!; // octagon r=0.4 at (0.6, -0.55, -1.4)
    expect(insideOutline(0, 0, table.polygon!)).toBe(true);
    expect(insideOutline(0.38, 0.38, table.polygon!)).toBe(false); // inside the 0.8 m square extent, outside the octagon
    const down = (x: number, z: number) => raycastPlanes([x, 0, z], [0, -1, 0], [table]);
    expect(down(0.6, -1.4)).toHaveLength(1);
    expect(down(0.6 + 0.38, -1.4 + 0.38)).toHaveLength(0);
  });
});

describe("'plane-detection': frame.detectedPlanes", () => {
  it('reports every plane with pose, polygon and orientation, keeping object identity across frames', async () => {
    const { session, local } = await start(['plane-detection']);
    try {
      hw.onPlanes(mockPlanes(false, 0));
      const first = await inFrame(session, (f) => [...f.detectedPlanes]);
      expect(first).toHaveLength(3);
      const byOrientation = first.map((p) => p.orientation).sort();
      expect(byOrientation).toEqual(['horizontal', 'horizontal', 'vertical']);
      const wall = first.find((p) => p.orientation === 'vertical')!;
      const wallPose = await inFrame(session, (f) => f.getPose(wall.planeSpace, local)!.transform.matrix);
      expect([wallPose[12], wallPose[13], wallPose[14]].map((v) => +v.toFixed(3))).toEqual([0, 0, -3]);
      expect(wallPose[6]).toBeCloseTo(1, 5); // +Y (normal) points towards the viewer (+Z)
      expect(wall.polygon[0]).toBeInstanceOf(DOMPointReadOnly);
      expect(wall.polygon.map((p) => p.y).every((y) => y === 0)).toBe(true);

      const times = new Map(first.map((p) => [p, p.lastChangedTime]));
      await new Promise((r) => setTimeout(r, 5));
      hw.onPlanes(mockPlanes(true, 1234)); // floor grew, others unchanged
      const second = await inFrame(session, (f) => [...f.detectedPlanes]);
      expect(new Set(second)).toEqual(new Set(first)); // same objects
      const floor = second.find((p) => p.polygon.some((pt) => Math.abs(pt.x) === 5))!;
      expect(floor.lastChangedTime).toBeGreaterThan(times.get(floor)!);
      for (const p of second) if (p !== floor) expect(p.lastChangedTime).toBe(times.get(p));

      hw.onPlanes(mockPlanes(true, 1234).filter((p) => p.id !== 'mock-table'));
      expect(await inFrame(session, (f) => f.detectedPlanes.size)).toBe(2);
    } finally {
      await session.end();
    }
  });

  it('is empty for sessions without the feature', async () => {
    const { session } = await start([]);
    try {
      hw.onPlanes(mockPlanes(false, 0));
      expect(await inFrame(session, (f) => f.detectedPlanes.size)).toBe(0);
    } finally {
      await session.end();
    }
  });
});

describe('reflection cube maps (XRWebGLBinding.getReflectionCubeMap)', () => {
  it('fires reflectionchange, uploads sRGB faces once per map into one texture, restores GL state', async () => {
    const { session } = await start(['light-estimation']);
    try {
      const probe = await session.requestLightProbe({ reflectionFormat: 'srgba8' });
      let changes = 0;
      probe.addEventListener('reflectionchange', () => changes++);
      let handler = 0;
      probe.onreflectionchange = () => handler++;
      const gl = new FakeGL2();
      const Binding = (globalThis as unknown as { XRWebGLBinding: new (s: Session, g: unknown) => { getReflectionCubeMap(p: Probe): unknown } }).XRWebGLBinding;
      const binding = new Binding(session, gl);
      expect(binding.getReflectionCubeMap(probe)).toBeNull(); // no map yet

      hw.onEnvironment(mockEnvironment(32, 1, 1));
      expect([changes, handler]).toEqual([1, 1]);
      const cube = binding.getReflectionCubeMap(probe);
      expect(cube).toEqual({ id: 'cube1' });
      expect(gl.uploads).toHaveLength(6);
      expect(gl.uploads.map((u) => u.target - gl.TEXTURE_CUBE_MAP_POSITIVE_X)).toEqual([0, 1, 2, 3, 4, 5]);
      expect(gl.uploads.every((u) => u.internal === gl.SRGB8_ALPHA8 && u.size === 32 && u.bytes === 4096 && u.flipY === false)).toBe(true);
      // engine state restored
      expect(gl.getParameter(gl.TEXTURE_BINDING_CUBE_MAP)).toBe('pageCube');
      expect(gl.getParameter(gl.UNPACK_FLIP_Y_WEBGL)).toBe(true);
      expect(gl.getParameter(gl.UNPACK_ROW_LENGTH)).toBe(7);
      expect(gl.getParameter(gl.PIXEL_UNPACK_BUFFER_BINDING)).toBe('pageBuffer');

      expect(binding.getReflectionCubeMap(probe)).toBe(cube); // no re-upload without a new map
      expect(gl.uploads).toHaveLength(6);
      hw.onEnvironment(mockEnvironment(32, 0.8, 2));
      expect(changes).toBe(2);
      expect(binding.getReflectionCubeMap(probe)).toBe(cube); // updated in place
      expect(gl.uploads).toHaveLength(12);
      expect(gl.created).toBe(1);
    } finally {
      await session.end();
    }
  });

  it('only offers srgba8, and notifies probes created after a map arrived', async () => {
    const { session } = await start(['light-estimation']);
    try {
      expect((session as unknown as { preferredReflectionFormat: string }).preferredReflectionFormat).toBe('srgba8');
      await expect(session.requestLightProbe({ reflectionFormat: 'rgba16f' })).rejects.toMatchObject({ name: 'NotSupportedError' });
      hw.onEnvironment(mockEnvironment(32, 1, 3));
      const probe = await session.requestLightProbe();
      const fired = await new Promise<boolean>((resolve) => {
        probe.addEventListener('reflectionchange', () => resolve(true));
        setTimeout(() => resolve(false), 50);
      });
      expect(fired).toBe(true);
    } finally {
      await session.end();
    }
  });

  it('rejects malformed maps', () => {
    const bad = mockEnvironment(32, 1, 4);
    expect(hw.reflections.update({ ...bad, faces: bad.faces.slice(0, 5) })).toBe(false);
    expect(hw.reflections.update({ ...bad, size: 16 })).toBe(false);
    expect(hw.reflections.update({ ...bad, format: 'rgba16f' })).toBe(false);
  });
});

describe('transient-input hit test (requestHitTestSourceForTransientInput)', () => {
  interface TFrame { getHitTestResultsForTransientInput(s: unknown): { inputSource: { targetRayMode: string; profiles: string[] }; results: { getPose(b: unknown): { transform: { matrix: Float32Array } } }[] }[] }
  it('hit-tests a screen tap against the planes', async () => {
    const session = await xr().requestSession('immersive-ar', { requiredFeatures: ['hit-test'] });
    try {
      session.updateRenderState({ layers: [{}] });
      // camera 1.5 m up looking straight down, floor plane at y = 0
      const down = mat4.fromRotationTranslation(mat4.create(), [-Math.SQRT1_2, 0, 0, Math.SQRT1_2], [0, 1.5, 0]);
      hw.onFrame(1, 'mono', Array.from(down), Array.from(mat4.invert(mat4.create(), down)!), Array.from(mat4.perspective(mat4.create(), 1, 2, 0.01, 100)), null, 'normal');
      hw.onPlanes([{ id: 'f', transform: Array.from(mat4.create()), extent: [4, 4], orientation: 'horizontal' }]);
      const local = await session.requestReferenceSpace('local');
      const source = await (session as unknown as { requestHitTestSourceForTransientInput(o: object): Promise<unknown> }).requestHitTestSourceForTransientInput({ profile: 'generic-touchscreen' });
      await inFrame(session, () => undefined);
      expect(await inFrame(session, (f) => (f as unknown as TFrame).getHitTestResultsForTransientInput(source))).toEqual([]); // no touch yet
      window.dispatchEvent(new PointerEvent('pointerdown', { clientX: innerWidth / 2, clientY: innerHeight / 2 }));
      await inFrame(session, () => undefined);
      const hits = await inFrame(session, (f) =>
        (f as unknown as TFrame).getHitTestResultsForTransientInput(source).map((r) => ({
          mode: r.inputSource.targetRayMode,
          profiles: r.inputSource.profiles,
          points: r.results.map((h) => { const m = h.getPose(local).transform.matrix; return [m[12], m[13], m[14]].map((v) => +v.toFixed(3) + 0); }),
        })),
      );
      expect(hits).toHaveLength(1);
      expect(hits[0].mode).toBe('screen');
      expect(hits[0].profiles).toContain('generic-touchscreen');
      expect(hits[0].points).toEqual([[0, 0, 0]]);
      window.dispatchEvent(new PointerEvent('pointerup'));
    } finally {
      await session.end();
    }
  });
});

describe('G4: XRHitTestResult.createAnchor on a result from an earlier frame', () => {
  interface HFrame { getHitTestResults(s: unknown): { createAnchor(): Promise<unknown> }[]; createAnchor(p: unknown, s: unknown): Promise<unknown> }
  it('creates a native anchor from the stored pose while the session is live; XRFrame.createAnchor stays strict', async () => {
    const session = await xr().requestSession('immersive-ar', { requiredFeatures: ['hit-test', 'anchors'] });
    try {
      session.updateRenderState({ layers: [{}] });
      const down = mat4.fromRotationTranslation(mat4.create(), [-Math.SQRT1_2, 0, 0, Math.SQRT1_2], [0, 1.5, 0]);
      hw.onFrame(1, 'mono', Array.from(down), Array.from(mat4.invert(mat4.create(), down)!), Array.from(mat4.perspective(mat4.create(), 1, 2, 0.01, 100)), null, 'normal');
      hw.onPlanes([{ id: 'f', transform: Array.from(mat4.create()), extent: [4, 4], orientation: 'horizontal' }]);
      const viewer = await session.requestReferenceSpace('viewer');
      const source = await (session as unknown as { requestHitTestSource(o: object): Promise<unknown> }).requestHitTestSource({ space: viewer });
      await inFrame(session, () => undefined);
      const [kept, oldFrame] = await inFrame(session, (f) => [(f as unknown as HFrame).getHitTestResults(source)[0], f as unknown as HFrame] as const);
      await inFrame(session, () => undefined); // the result's frame is no longer active
      const before = hw.anchors.count;
      await expect(kept.createAnchor()).resolves.toBeTruthy();
      expect(hw.anchors.count).toBe(before + 1);
      const Rigid = (globalThis as unknown as { XRRigidTransform: new () => unknown }).XRRigidTransform;
      await expect(oldFrame.createAnchor(new Rigid(), viewer)).rejects.toMatchObject({ name: 'InvalidStateError' });
    } finally {
      await session.end();
    }
  });
});
