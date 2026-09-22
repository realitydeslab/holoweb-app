// @vitest-environment happy-dom
// XRGPUBinding mid-session mode toggle: priming view in mono, presenter eye filtering.
// WebGPU is faked (no GPU in happy-dom); the real GPU path is covered by scripts/e2e.mjs.
import { mat4 } from 'gl-matrix';
import { beforeAll, describe, expect, it } from 'vitest';
import type { HoloWebGlobal } from '../src/index.js';
import { PRIME_FRAMES } from '../src/gpu-binding.js';

interface FakeBlit { layer: number; x: number; y: number; w: number; h: number }
const copies: FakeBlit[] = [];
let submits = 0;

const fakeTexture = (d: { size: { width: number; height: number } }) => ({
  width: d.size.width,
  height: d.size.height,
  destroy() {},
  createView: () => ({}),
});
const fakeDevice = {
  createTexture: fakeTexture,
  createCommandEncoder: () => ({
    beginRenderPass: () => ({ end() {}, setPipeline() {}, setViewport() {}, setScissorRect() {}, setBindGroup() {}, draw() {} }),
    copyTextureToTexture: (src: { origin: { z: number } }, dst: { origin: { x: number; y: number } }, size: { width: number; height: number }) =>
      copies.push({ layer: src.origin.z, x: dst.origin.x, y: dst.origin.y, w: size.width, h: size.height }),
    finish: () => ({}),
  }),
  createShaderModule: () => ({}),
  createRenderPipeline: () => ({ getBindGroupLayout: () => ({}) }),
  createSampler: () => ({}),
  createBindGroup: () => ({}),
  queue: { submit: () => submits++ },
};

type View = { eye: string; projectionMatrix: Float32Array };
interface Frame { getViewerPose(space: unknown): { views: View[] } }
interface Session {
  updateRenderState(s: Record<string, unknown>): void;
  requestReferenceSpace(t: string): Promise<unknown>;
  requestAnimationFrame(cb: (t: number, f: Frame) => void): number;
  end(): Promise<void>;
}
let hw: HoloWebGlobal;
let session: Session;
let binding: { createProjectionLayer(i: object): unknown; getViewSubImage(l: unknown, v: View): unknown };
let layer: unknown;
let primed: View[] = [];
let lastViewports: { width: number; height: number }[] = [];

const pose = mat4.fromTranslation(mat4.create(), [0, 1.5, 0]);
const proj = mat4.perspective(mat4.create(), 1, 0.5, 0.01, 1000);
const push = (mode: 'mono' | 'stereo') =>
  hw.onFrame(performance.now(), mode, Array.from(pose), Array.from(mat4.invert(mat4.create(), pose)!), Array.from(proj), null, 'normal');

/** One XR frame that behaves like three.js: sub-image per view, then (after callbacks) present. */
const frame = (local: unknown) =>
  new Promise<string[]>((resolve) =>
    session.requestAnimationFrame((_t, f) => {
      const views = f.getViewerPose(local).views;
      if (views.length === 2 && primed.length === 0) primed = [...views];
      lastViewports = views.map((v) => (binding.getViewSubImage(layer, v) as { viewport: { width: number; height: number } }).viewport);
      resolve(views.map((v) => v.eye));
    }),
  );

beforeAll(async () => {
  Object.defineProperty(navigator, 'gpu', { configurable: true, value: { getPreferredCanvasFormat: () => 'bgra8unorm' } });
  (globalThis as Record<string, unknown>).GPUTextureUsage = { RENDER_ATTACHMENT: 16, TEXTURE_BINDING: 4, COPY_SRC: 1, COPY_DST: 2 };
  (globalThis as Record<string, unknown>).WebGL2RenderingContext = class {};
  (globalThis as Record<string, unknown>).__THREE__ = '186'; // three.js sets this; priming is three-only
  // A fake native transport: without window.webkit the polyfill would start the desktop mock, whose
  // 60 Hz mono frames race with this test's own onFrame pushes (the source of an earlier flake).
  (globalThis as Record<string, unknown>).webkit = {
    messageHandlers: { holoweb: { postMessage: (m: { type: string }) => Promise.resolve(m.type === 'requestSession' ? { ok: true, mode: 'mono' } : { ok: true }) } },
  };
  const getContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, kind: string, ...rest: unknown[]) {
    if (kind === 'webgpu') return { configure() {}, unconfigure() {}, getCurrentTexture: () => fakeTexture({ size: { width: this.width, height: this.height } }) };
    return (getContext as (...a: unknown[]) => unknown).call(this, kind, ...rest);
  } as typeof getContext;
  await import('../src/index.js');
  hw = (globalThis as unknown as { __holoweb: HoloWebGlobal }).__holoweb;
  const xr = (navigator as unknown as { xr: { requestSession(m: string, i: object): Promise<Session> } }).xr;
  session = await xr.requestSession('immersive-ar', { optionalFeatures: ['webgpu'] });
  push('mono');
  const Binding = (globalThis as unknown as { XRGPUBinding: new (s: Session, d: unknown) => typeof binding }).XRGPUBinding;
  binding = new Binding(session, fakeDevice);
  layer = binding.createProjectionLayer({ colorFormat: 'bgra8unorm' });
  session.updateRenderState({ layers: [layer] });
});

describe('XRGPUBinding mono <-> stereo mid-session', () => {
  it(`adds a zero-fragment priming view for the first ${PRIME_FRAMES} mono frames, then renders one view`, async () => {
    const local = await session.requestReferenceSpace('local');
    await frame(local); // pending render state (layers) applies
    const eyes: string[][] = [];
    for (let i = 0; i < PRIME_FRAMES + 2; i++) eyes.push(await frame(local));
    expect(eyes.slice(0, PRIME_FRAMES - 1).every((e) => e.join() === 'none,right')).toBe(true);
    expect(eyes.at(-1)).toEqual(['none']);
    const views = await new Promise<View[]>((r) => session.requestAnimationFrame((_t, f) => r(f.getViewerPose(local).views)));
    expect(views).toHaveLength(1);
  });

  it('priming view: same pose as the mono view, rasterises nothing, keeps three.js union inputs', () => {
    const [mono, priming] = primed as (View & { transform: { matrix: Float32Array } })[];
    expect(priming.eye).toBe('right');
    expect(Array.from(priming.transform.matrix)).toEqual(Array.from(mono.transform.matrix)); // ipd 0 -> union = mono frustum
    const p = priming.projectionMatrix;
    for (const i of [0, 5, 8, 10, 11, 14]) expect(p[i]).toBe(mono.projectionMatrix[i]); // three's union reads these
    const yNdc = (y: number, z: number) => (p[5] * y + p[9] * z + p[13]) / -z;
    for (const [y, z] of [[0, -0.1], [2, -1], [-5, -50]]) expect(yNdc(y, z)).toBeLessThan(-1000);
  });

  it('presents only the views of the current mode, and follows a stereo toggle without ending the session', async () => {
    const local = await session.requestReferenceSpace('local');
    copies.length = 0;
    await frame(local);
    expect(copies.map((c) => c.layer)).toEqual([0]); // mono: layer 0 only (full framebuffer)

    push('stereo');
    const before = submits;
    expect(await frame(local)).toEqual(['left', 'right']);
    expect(submits).toBe(before + 1);

    push('mono');
    copies.length = 0;
    // the page has seen 2 views: keep the inert 2nd view (views.ts), but present only the mono view
    expect(await frame(local)).toEqual(['none', 'right']);
    expect(copies.map((c) => c.layer)).toEqual([0]);
    expect(lastViewports[0].width * lastViewports[0].height).toBeGreaterThan(0);
    expect([lastViewports[1].width, lastViewports[1].height]).toEqual([0, 0]); // inert view: 0x0 sub-image
    await session.end();
  });
});

describe('G12: non-three renderers and depthStencilTexture', () => {
  it('gives a non-three page a plain single view in mono (no priming view)', async () => {
    delete (globalThis as Record<string, unknown>).__THREE__;
    const xr = (navigator as unknown as { xr: { requestSession(m: string, i: object): Promise<Session> } }).xr;
    const s2 = await xr.requestSession('immersive-ar', { optionalFeatures: ['webgpu'] });
    try {
      push('mono');
      const Binding = (globalThis as unknown as { XRGPUBinding: new (s: Session, d: unknown) => typeof binding }).XRGPUBinding;
      const b2 = new Binding(s2, fakeDevice);
      s2.updateRenderState({ layers: [b2.createProjectionLayer({ colorFormat: 'bgra8unorm' })] });
      const local = await s2.requestReferenceSpace('local');
      await new Promise<void>((r) => s2.requestAnimationFrame(() => r()));
      const eyes = await new Promise<string[]>((r) => s2.requestAnimationFrame((_t, f) => r(f.getViewerPose(local).views.map((v) => v.eye))));
      expect(eyes).toEqual(['none']);
    } finally {
      (globalThis as Record<string, unknown>).__THREE__ = '186';
      await s2.end();
    }
  });

  it('allocates a 2-layer depthStencilTexture only when the page asks for one', async () => {
    const xr = (navigator as unknown as { xr: { requestSession(m: string, i: object): Promise<Session> } }).xr;
    const s3 = await xr.requestSession('immersive-ar', { optionalFeatures: ['webgpu'] });
    try {
      const Binding = (globalThis as unknown as { XRGPUBinding: new (s: Session, d: unknown) => { createProjectionLayer(i: object): unknown; getViewSubImage(l: unknown, v: View): { depthStencilTexture: { width: number } | null } } }).XRGPUBinding;
      const b3 = new Binding(s3, fakeDevice);
      const withDepth = b3.createProjectionLayer({ colorFormat: 'bgra8unorm', depthStencilFormat: 'depth24plus' });
      const without = b3.createProjectionLayer({ colorFormat: 'bgra8unorm' });
      const view = { eye: 'none', projectionMatrix: new Float32Array(16) } as View;
      expect(b3.getViewSubImage(withDepth, view).depthStencilTexture?.width).toBeGreaterThan(0);
      expect(b3.getViewSubImage(without, view).depthStencilTexture).toBeNull();
    } finally {
      await s3.end();
    }
  });
});
