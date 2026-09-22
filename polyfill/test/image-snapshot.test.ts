// @vitest-environment happy-dom
// Device bugs in WKWebView: (a) the trackedImages snapshot failed silently; (b) 4/6 launches produced a
// valid PNG whose pixels were all RGBA 0 (ARKit: "Invalid reference image"). Failures are logged with
// name + message, an undrawable bitmap falls back to its source element, and a blank read-back is retried
// (source element, then up to 3 animation frames) before the image is scored untrackable.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeTrackedImages, installBitmapSourceTracking, RETRY_FRAMES, snapshotErrors } from '../src/image-snapshot.js';

const broken = { width: 64, height: 32, broken: true } as unknown as ImageBitmap;
const plain = (w = 8, h = 8) => ({ width: w, height: h }) as unknown as ImageBitmap;

/** getImageData results in call order; after the list runs out every read is a real (varied) image. */
let reads: ('blank' | 'image')[] = [];
let contextOptions: unknown[] = [];
let fills = 0;

function pixels(kind: 'blank' | 'image', w: number, h: number): { data: Uint8ClampedArray } {
  const data = new Uint8ClampedArray(w * h * 4);
  if (kind === 'image') for (let i = 0; i < data.length; i++) data[i] = (i * 37) % 256 | (i % 4 === 3 ? 255 : 0);
  return { data };
}

beforeEach(() => {
  reads = [];
  contextOptions = [];
  fills = 0;
  const proto = HTMLCanvasElement.prototype as unknown as Record<string, unknown>;
  proto.getContext = function (_type: string, options?: unknown) {
    contextOptions.push(options);
    return {
      fillStyle: '',
      fillRect: () => { fills++; },
      drawImage: (src: { broken?: boolean }) => {
        if (src.broken) throw new DOMException('The ImageBitmap is not usable', 'InvalidStateError');
      },
      getImageData: (_x: number, _y: number, w: number, h: number) => pixels(reads.shift() ?? 'image', w, h),
    };
  };
  proto.toDataURL = function (this: HTMLCanvasElement) { return `data:image/png;base64,${btoa(`${this.width}x${this.height}`)}`; };
});

describe('trackedImages snapshot', () => {
  it('draws into a CPU-backed canvas over opaque white', async () => {
    const [img] = await encodeTrackedImages([{ image: plain(), widthInMeters: 0.1 }]);
    expect(img).toMatchObject({ width: 8, height: 8 });
    expect(contextOptions[0]).toEqual({ willReadFrequently: true });
    expect(fills).toBe(1);
  });

  it('retries a blank read-back on the next animation frame (device: all RGBA 0)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    reads = ['blank'];
    const [img] = await encodeTrackedImages([{ image: plain(), widthInMeters: 0.1 }]);
    expect(img?.png).toBe(btoa('8x8'));
    expect(warn.mock.calls.at(-1)![0]).toMatch(/blank snapshot recovered on retry 1/);
    warn.mockRestore();
  });

  it('scores untrackable with "blank snapshot" after the retries are used up', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    reads = Array(1 + RETRY_FRAMES).fill('blank');
    expect(await encodeTrackedImages([{ image: plain(), widthInMeters: 0.1 }])).toEqual([null]);
    expect(snapshotErrors.at(-1)).toMatch(/blank snapshot/);
    expect(warn.mock.calls.at(-1)![0]).toMatch(/-> untrackable/);
    warn.mockRestore();
  });

  it('logs the error name and message and scores untrackable when nothing can be drawn', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await encodeTrackedImages([{ image: broken, widthInMeters: 0.1 }])).toEqual([null]);
    expect(warn.mock.calls[0][0]).toMatch(/image 0: image: InvalidStateError: The ImageBitmap is not usable -> untrackable/);
    expect(await encodeTrackedImages([{ image: plain(0, 0), widthInMeters: 0.1 }])).toEqual([null]);
    expect(snapshotErrors.at(-1)).toMatch(/no size \(0x0; closed ImageBitmap\?\)/);
    warn.mockRestore();
  });

  it('falls back to the element an undrawable (or blank) ImageBitmap was created from', async () => {
    const source = document.createElement('canvas');
    source.width = 2048;
    source.height = 1024;
    const target = { createImageBitmap: async () => broken } as unknown as typeof globalThis;
    installBitmapSourceTracking(target);
    const bitmap = await target.createImageBitmap(source);
    const [img] = await encodeTrackedImages([{ image: bitmap, widthInMeters: 0.15 }]);
    expect(img).toMatchObject({ index: 0, width: 1024, height: 512, widthInMeters: 0.15 });
    expect(atob(img!.png)).toBe('1024x512');
  });

  it('takes the first snapshot synchronously in the call', () => {
    let drawn = 0;
    const proto = HTMLCanvasElement.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
    const getContext = proto.getContext;
    proto.getContext = function (this: HTMLCanvasElement, ...a: unknown[]) {
      const ctx = getContext.apply(this, a) as Record<string, unknown>;
      return { ...ctx, drawImage: () => { drawn++; } };
    };
    void encodeTrackedImages([{ image: plain(), widthInMeters: 0.1 }]);
    expect(drawn).toBe(1);
  });

  it('treats an empty toDataURL result ("data:,") as a failure', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    (HTMLCanvasElement.prototype as unknown as Record<string, unknown>).toDataURL = () => 'data:,';
    expect(await encodeTrackedImages([{ image: plain(), widthInMeters: 0.1 }])).toEqual([null]);
    expect(snapshotErrors.at(-1)).toMatch(/toDataURL returned "data:,"/);
    warn.mockRestore();
  });
});
