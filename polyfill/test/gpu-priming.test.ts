// @vitest-environment happy-dom
// IWER's XRGPUBinding under HoloWeb: priming view in mono, inert 0x0 sub-image, native layer size and
// the patched compositor regions (mono 'none' view, HoloKit eye rects).
// WebGPU is faked (no GPU in happy-dom); the real GPU path is covered by scripts/e2e.mjs.
import { mat4 } from 'gl-matrix';
import { beforeAll, describe, expect, it } from 'vitest';
import { XRGPUPresenter } from 'iwer/lib/layers/XRGPUPresenter.js';
import type { HoloWebGlobal } from '../src/index.js';
import { PRIME_FRAMES } from '../src/gpu-binding.js';
import { nativeFramebufferSize } from '../src/device.js';
import { fakeWebGPU, stub } from './support/xr-frames.js';

/** A GPUDevice stand-in: real limits, features and a pending `lost`; every other call is a stub. */
const fakeDevice = stub({
  limits: { maxTextureDimension2D: 8192, maxTextureArrayLayers: 256 },
  features: new Set<string>(),
  lost: new Promise(() => {}),
});

type View = { eye: string; projectionMatrix: Float32Array };
interface Frame { getViewerPose(space: unknown): { views: View[] } }
interface Session {
  updateRenderState(s: Record<string, unknown>): void;
  requestReferenceSpace(t: string): Promise<unknown>;
  requestAnimationFrame(cb: (t: number, f: Frame) => void): number;
  end(): Promise<void>;
}
interface Layer { textureWidth: number; textureHeight: number }
interface Binding {
  createProjectionLayer(i: object): Layer;
  getViewSubImage(l: unknown, v: View): { viewport: { width: number; height: number } };
}
let hw: HoloWebGlobal;
let session: Session;
let binding: Binding;
let layer: Layer;
let primed: View[] = [];
let lastViewports: { width: number; height: number }[] = [];

const xr = () => (navigator as unknown as { xr: { requestSession(m: string, i: object): Promise<Session> } }).xr;
const Binding = () => (globalThis as unknown as { XRGPUBinding: new (s: Session, d: unknown) => Binding }).XRGPUBinding;
const pose = mat4.fromTranslation(mat4.create(), [0, 1.5, 0]);
const proj = mat4.perspective(mat4.create(), 1, 0.5, 0.01, 1000);
const push = (mode: 'mono' | 'stereo') =>
  hw.onFrame(performance.now(), mode, Array.from(pose), Array.from(mat4.invert(mat4.create(), pose)!), Array.from(proj), null, 'normal');

/** One XR frame that behaves like three.js: a sub-image per view. */
const frame = (local: unknown) =>
  new Promise<string[]>((resolve) =>
    session.requestAnimationFrame((_t, f) => {
      const views = f.getViewerPose(local).views;
      if (views.length === 2 && primed.length === 0) primed = [...views];
      lastViewports = views.map((v) => binding.getViewSubImage(layer, v).viewport);
      resolve(views.map((v) => v.eye));
    }),
  );

beforeAll(async () => {
  fakeWebGPU();
  (globalThis as Record<string, unknown>).WebGL2RenderingContext = class {};
  (globalThis as Record<string, unknown>).__THREE__ = '186'; // three.js sets this; priming is three-only
  // A fake native transport: without window.webkit the polyfill would start the desktop mock, whose
  // 60 Hz mono frames race with this test's own onFrame pushes (the source of an earlier flake).
  (globalThis as Record<string, unknown>).webkit = {
    messageHandlers: { holoweb: { postMessage: (m: { type: string }) => Promise.resolve(m.type === 'requestSession' ? { ok: true, mode: 'mono' } : { ok: true }) } },
  };
  await import('../src/index.js');
  hw = (globalThis as unknown as { __holoweb: HoloWebGlobal }).__holoweb;
  session = await xr().requestSession('immersive-ar', { optionalFeatures: ['webgpu'] });
  push('mono');
  binding = new (Binding())(session, fakeDevice);
  layer = binding.createProjectionLayer({ colorFormat: 'bgra8unorm' });
  session.updateRenderState({ layers: [layer] });
});

describe('XRGPUBinding mono <-> stereo mid-session', () => {
  it('sizes a mono layer to the native framebuffer', () => {
    const fb = nativeFramebufferSize();
    expect([layer.textureWidth, layer.textureHeight]).toEqual([fb.width, fb.height]);
  });

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

  it('composites the mono view full-screen and the HoloKit eyes at their rects, across a stereo toggle', async () => {
    const local = await session.requestReferenceSpace('local');
    type Region = { eye: string; x: number; y: number; width: number; height: number };
    const presenter = new XRGPUPresenter(hw.bridge.device) as unknown as { viewRegions(s: unknown): Region[] };
    const regions = () => presenter.viewRegions(session).map((r) => [r.eye, r.x, r.y, r.width, r.height]);
    const fb = nativeFramebufferSize();
    await frame(local);
    expect(regions()).toEqual([['none', 0, 0, fb.width, fb.height]]);

    push('stereo');
    expect(await frame(local)).toEqual(['left', 'right']);
    const vp = hw.bridge.device.nativeViewports;
    const topLeft = (r: { x: number; y: number; width: number; height: number }) => [r.x, fb.height - r.y - r.height, r.width, r.height];
    expect(regions()).toEqual([['left', ...topLeft(vp.left!)], ['right', ...topLeft(vp.right!)]]);
    // a layer created in stereo is one eye rect
    const eyeLayer = binding.createProjectionLayer({ colorFormat: 'bgra8unorm' });
    expect([eyeLayer.textureWidth, eyeLayer.textureHeight]).toEqual([vp.left!.width, vp.left!.height]);

    push('mono');
    // the page has seen 2 views: keep the inert 2nd view (views.ts); the compositor shows only 'none'
    expect(await frame(local)).toEqual(['none', 'right']);
    expect(regions().map((r) => r[0])).toEqual(['none']);
    expect(lastViewports[0].width * lastViewports[0].height).toBeGreaterThan(0);
    expect([lastViewports[1].width, lastViewports[1].height]).toEqual([0, 0]); // inert view: 0x0 sub-image
    await session.end();
  });
});

describe('G12: non-three renderers', () => {
  it('gives a non-three page a plain single view in mono (no priming view)', async () => {
    delete (globalThis as Record<string, unknown>).__THREE__;
    const s2 = await xr().requestSession('immersive-ar', { optionalFeatures: ['webgpu'] });
    try {
      push('mono');
      const b2 = new (Binding())(s2, fakeDevice);
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
});
