// @vitest-environment happy-dom
// Device bug: in WKWebView the trackedImages snapshot failed silently (scores 'untrackable', nothing sent).
// Failures are now logged with name + message, and a bitmap that cannot be drawn falls back to the
// element it was created from.
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { encodeTrackedImages, installBitmapSourceTracking, snapshotErrors } from '../src/image-snapshot.js';

const broken = { width: 64, height: 32, broken: true } as unknown as ImageBitmap;

beforeAll(() => {
  const proto = HTMLCanvasElement.prototype as unknown as Record<string, unknown>;
  proto.getContext = function () {
    return {
      drawImage: (src: { broken?: boolean }) => {
        if (src.broken) throw new DOMException('The ImageBitmap is not usable', 'InvalidStateError');
      },
    };
  };
  proto.toDataURL = function (this: HTMLCanvasElement) { return `data:image/png;base64,${btoa(`${this.width}x${this.height}`)}`; };
});

describe('trackedImages snapshot', () => {
  it('logs the error name and message and scores untrackable when nothing can be drawn', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(encodeTrackedImages([{ image: broken, widthInMeters: 0.1 }])).toEqual([null]);
    expect(warn.mock.calls[0][0]).toMatch(/image 0: image: InvalidStateError: The ImageBitmap is not usable -> untrackable/);
    expect(snapshotErrors.at(-1)).toMatch(/InvalidStateError/);
    expect(encodeTrackedImages([{ image: { width: 0, height: 0 } as unknown as ImageBitmap, widthInMeters: 0.1 }])).toEqual([null]);
    expect(snapshotErrors.at(-1)).toMatch(/no size \(0x0; closed ImageBitmap\?\)/);
    warn.mockRestore();
  });

  it('falls back to the element an undrawable ImageBitmap was created from', async () => {
    const source = document.createElement('canvas');
    source.width = 2048;
    source.height = 1024;
    const target = { createImageBitmap: async () => broken } as unknown as typeof globalThis;
    installBitmapSourceTracking(target);
    const bitmap = await target.createImageBitmap(source);
    const [img] = encodeTrackedImages([{ image: bitmap, widthInMeters: 0.15 }]);
    expect(img).toMatchObject({ index: 0, width: 1024, height: 512, widthInMeters: 0.15 });
    expect(atob(img!.png)).toBe('1024x512');
  });

  it('treats an empty toDataURL result ("data:,") as a failure', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const proto = HTMLCanvasElement.prototype as unknown as Record<string, unknown>;
    const toDataURL = proto.toDataURL;
    proto.toDataURL = () => 'data:,';
    try {
      expect(encodeTrackedImages([{ image: { width: 8, height: 8 } as unknown as ImageBitmap, widthInMeters: 0.1 }])).toEqual([null]);
      expect(snapshotErrors.at(-1)).toMatch(/toDataURL returned "data:,"/);
    } finally {
      proto.toDataURL = toDataURL;
      warn.mockRestore();
    }
  });
});
