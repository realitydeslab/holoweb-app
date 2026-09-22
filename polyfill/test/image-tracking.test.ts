// @vitest-environment happy-dom
// WebXR Image Tracking conformance (https://github.com/immersive-web/image-tracking/blob/main/explainer.md):
// trackedImages snapshot + setTrackedImages before requestSession, getTrackedImageScores, frame
// getImageTrackingResults (frozen, [SameObject] imageSpace, tracked | emulated, untrackable never listed).
import { mat4 } from 'gl-matrix';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { HoloWebGlobal } from '../src/index.js';

type Msg = Record<string, unknown> & { type: string };
interface Result { imageSpace: unknown; index: number; trackingState: string; measuredWidthInMeters: number }
interface Frame { getImageTrackingResults(): readonly Result[]; getPose(s: unknown, b: unknown): { transform: { matrix: Float32Array } } | null }
interface Session {
  enabledFeatures: string[];
  getTrackedImageScores(): Promise<readonly string[]>;
  updateRenderState(s: Record<string, unknown>): void;
  requestReferenceSpace(t: string): Promise<unknown>;
  requestAnimationFrame(cb: (t: number, f: Frame) => void): number;
  end(): Promise<void>;
}
const g = globalThis as unknown as Record<string, unknown>;
let hw: HoloWebGlobal;
let posted: Msg[] = [];
let draws = 0;
const xr = () => (navigator as unknown as { xr: { requestSession(m: string, i?: object): Promise<Session> } }).xr;
const inFrame = <T>(s: Session, fn: (f: Frame) => T) =>
  new Promise<T>((resolve, reject) => s.requestAnimationFrame((_t, f) => { try { resolve(fn(f)); } catch (e) { reject(e); } }));
/** Stand-in ImageBitmap: only its size matters to the (stubbed) canvas. */
const bitmap = (width: number, height: number) => ({ width, height }) as unknown as ImageBitmap;

beforeAll(async () => {
  g.WebGL2RenderingContext = class {};
  // happy-dom has no 2D canvas: count draws, encode the size as the "PNG"
  const proto = HTMLCanvasElement.prototype as unknown as Record<string, unknown>;
  proto.getContext = function () {
    return {
      fillRect: () => undefined,
      drawImage: () => { draws++; },
      // a varied image, so the blank-snapshot check passes
      getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: Uint8ClampedArray.from({ length: w * h * 4 }, (_, i) => (i % 4 === 3 ? 255 : (i * 31) % 256)) }),
    };
  };
  proto.toDataURL = function (this: HTMLCanvasElement) { return `data:image/png;base64,${btoa(`${this.width}x${this.height}`)}`; };
  g.webkit = {
    messageHandlers: {
      holoweb: {
        postMessage: (m: Msg) => {
          posted.push(m);
          if (m.type === 'setTrackedImages') {
            const images = m.images as { width: number; height: number }[];
            return Promise.resolve({ scores: images.map((i) => (i.width * i.height > 1 ? 'trackable' : 'untrackable')) });
          }
          return Promise.resolve(m.type === 'requestSession' ? { ok: true, mode: 'mono' } : { ok: true });
        },
      },
    },
  };
  await import('../src/index.js');
  hw = g.__holoweb as HoloWebGlobal;
  hw.onFrame(1, 'mono', Array.from(mat4.create()), Array.from(mat4.create()), Array.from(mat4.perspective(mat4.create(), 1, 2, 0.01, 100)), null, 'normal');
});

beforeEach(() => {
  posted = [];
  draws = 0;
});

const images = () => [
  { image: bitmap(2048, 1024), widthInMeters: 0.15 }, // scaled to 1024 x 512
  { image: bitmap(1, 1), widthInMeters: 0.1 }, // uniform: blank snapshot, untrackable
  { image: bitmap(64, 64), widthInMeters: 0 }, // no width: untrackable, never sent
];

describe('image-tracking: session setup', () => {
  it("is a supported feature ('image-tracking') and sends setTrackedImages before requestSession", async () => {
    const pending = xr().requestSession('immersive-ar', { requiredFeatures: ['image-tracking'], trackedImages: images() });
    expect(draws).toBe(2); // snapshotted synchronously at the call
    const session = await pending;
    try {
      expect(session.enabledFeatures).toContain('image-tracking');
      const types = posted.map((m) => m.type).filter((t) => t === 'setTrackedImages' || t === 'requestSession');
      expect(types).toEqual(['setTrackedImages', 'requestSession']);
      const sent = posted.find((m) => m.type === 'setTrackedImages')!.images as Record<string, unknown>[];
      // the 1x1 image is a single uniform pixel: a blank snapshot, untrackable without reaching native
      expect(sent.map((i) => [i.index, i.width, i.height, i.widthInMeters])).toEqual([[0, 1024, 512, 0.15]]);
      expect(atob(sent[0].png as string)).toBe('1024x512');
    } finally {
      await session.end();
    }
  });

  it('getTrackedImageScores resolves one frozen score per image, in order', async () => {
    const session = await xr().requestSession('immersive-ar', { requiredFeatures: ['image-tracking'], trackedImages: images() });
    try {
      const scores = await session.getTrackedImageScores();
      expect(scores).toEqual(['trackable', 'untrackable', 'untrackable']);
      expect(Object.isFrozen(scores)).toBe(true);
    } finally {
      await session.end();
    }
  });

  it('without the feature: no upload, scores reject and results throw NotSupportedError', async () => {
    const session = await xr().requestSession('immersive-ar', { trackedImages: images() });
    try {
      expect(posted.some((m) => m.type === 'setTrackedImages')).toBe(false);
      await expect(session.getTrackedImageScores()).rejects.toMatchObject({ name: 'NotSupportedError' });
      session.updateRenderState({ layers: [{}] });
      const err = await inFrame(session, (f) => { try { f.getImageTrackingResults(); return null; } catch (e) { return e as DOMException; } });
      expect(err?.name).toBe('NotSupportedError');
    } finally {
      await session.end();
    }
  });
});

describe('image-tracking: frame results', () => {
  it('lists trackable images only, tracked | emulated, measured width, imageSpace at the native transform', async () => {
    const session = await xr().requestSession('immersive-ar', { requiredFeatures: ['image-tracking'], trackedImages: images() });
    try {
      session.updateRenderState({ layers: [{}] });
      const local = await session.requestReferenceSpace('local');
      await session.getTrackedImageScores();
      // native sends imageSpace convention already (+Y image top, +Z toward viewer): used as is
      const pose = mat4.fromRotationTranslation(mat4.create(), [0.5, 0.5, 0.5, 0.5], [0.1, 0.2, -0.5]);
      hw.onImages([
        { index: 0, transform: Array.from(pose), tracked: true, measuredWidthInMeters: 0.149 },
        { index: 1, transform: Array.from(mat4.create()), tracked: true, measuredWidthInMeters: 0.1 }, // untrackable: dropped
      ]);
      const first = await inFrame(session, (f) => {
        const a = f.getImageTrackingResults();
        const again = f.getImageTrackingResults();
        return { a, same: a === again, matrix: Array.from(f.getPose(a[0].imageSpace, local)!.transform.matrix) };
      });
      expect(first.same).toBe(true); // one frozen array per frame
      expect(Object.isFrozen(first.a)).toBe(true);
      expect(first.a).toHaveLength(1);
      const r = first.a[0];
      expect(r).toBeInstanceOf(g.XRImageTrackingResult as new () => unknown);
      expect([r.index, r.trackingState, r.measuredWidthInMeters]).toEqual([0, 'tracked', 0.149]);
      first.matrix.forEach((v, i) => expect(v).toBeCloseTo(pose[i], 5));

      // out of view: last known pose, 'emulated' (there is no 'untracked'); same imageSpace object
      const moved = mat4.fromTranslation(mat4.create(), [0, 0, -1]);
      hw.onImages([{ index: 0, transform: Array.from(moved), tracked: false, measuredWidthInMeters: 0 }]);
      const second = await inFrame(session, (f) => {
        const [res] = f.getImageTrackingResults();
        return { res, z: f.getPose(res.imageSpace, local)!.transform.matrix[14] };
      });
      expect(second.res.trackingState).toBe('emulated');
      expect(second.res.measuredWidthInMeters).toBe(0);
      expect(second.res.imageSpace).toBe(r.imageSpace); // [SameObject] across frames
      expect(second.z).toBeCloseTo(-1, 5);
    } finally {
      await session.end();
    }
  });

  it('throws InvalidStateError outside the frame callback', async () => {
    const session = await xr().requestSession('immersive-ar', { requiredFeatures: ['image-tracking'], trackedImages: images() });
    try {
      session.updateRenderState({ layers: [{}] });
      const stale = await inFrame(session, (f) => f);
      expect(() => stale.getImageTrackingResults()).toThrow(expect.objectContaining({ name: 'InvalidStateError' }) as Error);
    } finally {
      await session.end();
    }
  });
});
