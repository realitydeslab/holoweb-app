/**
 * Snapshot + PNG encoding of XRSessionInit.trackedImages (image-tracking.ts). Runs synchronously in the
 * page's requestSession call (the explainer: later changes to the source have no effect).
 *
 * Each image is drawn to a DOM <canvas> (long side <= MAX_IMAGE_PX) and encoded with toDataURL. If that
 * fails for the ImageBitmap itself (WKWebView device report: ImageBitmaps from holoweb-app:// images),
 * the element the page created it from is drawn instead: installBitmapSourceTracking remembers the
 * source of every uncropped createImageBitmap(element). Every failure is logged with the error's name
 * and message and kept in `snapshotErrors` (__holoweb.images.stats); the image is then 'untrackable'.
 */

export interface TrackedImageInit {
  image: ImageBitmap;
  widthInMeters: number;
}

/** One `setTrackedImages` entry. */
export interface NativeTrackedImage {
  index: number;
  widthInMeters: number;
  width: number;
  height: number;
  /** base64 PNG */
  png: string;
}

export const MAX_IMAGE_PX = 1024;
const MAX_ERRORS = 10;

type Drawable = CanvasImageSource & { width: number | SVGAnimatedLength; height: number | SVGAnimatedLength };

/** Recent snapshot failures, newest last (diagnostics). */
export const snapshotErrors: string[] = [];
const bitmapSources = new WeakMap<object, Drawable>();

const describe = (err: unknown): string => (err instanceof Error || err instanceof DOMException ? `${err.name}: ${err.message}` : String(err));

function isElementSource(v: unknown): v is Drawable {
  const g = globalThis as unknown as Record<string, (new () => unknown) | undefined>;
  return ['HTMLImageElement', 'HTMLCanvasElement', 'HTMLVideoElement', 'SVGImageElement', 'OffscreenCanvas'].some(
    (name) => typeof g[name] === 'function' && v instanceof (g[name] as new () => unknown),
  );
}

/** Remember which element each uncropped, option-less createImageBitmap(element) came from. */
export function installBitmapSourceTracking(target: typeof globalThis = globalThis): void {
  const original = target.createImageBitmap;
  if (typeof original !== 'function') return;
  const wrapped = function (this: unknown, source: ImageBitmapSource, ...rest: unknown[]): Promise<ImageBitmap> {
    const promise = (original as (...a: unknown[]) => Promise<ImageBitmap>).call(this ?? target, source, ...rest);
    if (rest.length > 0 || !isElementSource(source)) return promise;
    return promise.then((bitmap) => {
      bitmapSources.set(bitmap, source);
      return bitmap;
    });
  };
  target.createImageBitmap = wrapped as typeof target.createImageBitmap;
}

function sizeOf(source: Drawable): [number, number] {
  const el = source as unknown as { naturalWidth?: number; naturalHeight?: number; videoWidth?: number; videoHeight?: number; width: unknown; height: unknown };
  const w = el.naturalWidth || el.videoWidth || (typeof el.width === 'number' ? el.width : 0);
  const h = el.naturalHeight || el.videoHeight || (typeof el.height === 'number' ? el.height : 0);
  return [w, h];
}

/** Draw `source` into a fresh canvas and PNG-encode it; throws with the reason. */
function drawAndEncode(source: Drawable, width: number, height: number): string {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas 2d context unavailable');
  ctx.drawImage(source, 0, 0, width, height);
  const url = canvas.toDataURL('image/png');
  const png = url.startsWith('data:image/png') ? url.slice(url.indexOf(',') + 1) : '';
  if (!png) throw new Error(`toDataURL returned "${url.slice(0, 24)}"`);
  return png;
}

function record(index: number, why: string): null {
  const line = `image ${index}: ${why}`;
  console.warn(`HoloWeb image-tracking: ${line} -> untrackable`);
  snapshotErrors.push(line);
  if (snapshotErrors.length > MAX_ERRORS) snapshotErrors.shift();
  return null;
}

function encodeOne(init: TrackedImageInit | undefined, index: number): NativeTrackedImage | null {
  const image = init?.image as Drawable | undefined;
  if (!image) return record(index, 'no image');
  const widthInMeters = Number(init?.widthInMeters);
  if (!(widthInMeters > 0)) return record(index, `widthInMeters must be > 0 (got ${String(init?.widthInMeters)})`);
  const reasons: string[] = [];
  for (const [label, source] of [['image', image], ['bitmap source element', bitmapSources.get(image)]] as const) {
    if (!source) continue;
    const [w, h] = sizeOf(source);
    if (!(w > 0 && h > 0)) {
      reasons.push(`${label}: no size (${w}x${h}; closed ImageBitmap?)`);
      continue;
    }
    const scale = Math.min(1, MAX_IMAGE_PX / Math.max(w, h));
    const width = Math.max(1, Math.round(w * scale));
    const height = Math.max(1, Math.round(h * scale));
    try {
      return { index, widthInMeters, width, height, png: drawAndEncode(source, width, height) };
    } catch (err) {
      reasons.push(`${label}: ${describe(err)}`);
    }
  }
  return record(index, reasons.join('; '));
}

/** Snapshot every image synchronously; null entries are untrackable (reason logged). */
export function encodeTrackedImages(images: readonly TrackedImageInit[]): (NativeTrackedImage | null)[] {
  return images.map((init, index) => encodeOne(init, index));
}
