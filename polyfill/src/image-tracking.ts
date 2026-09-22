/**
 * WebXR Image Tracking ('image-tracking', https://github.com/immersive-web/image-tracking/blob/main/explainer.md)
 * over ARKit detection images.
 *
 * - requestSession: `init.trackedImages` [{ image: ImageBitmap, widthInMeters }] is snapshotted at the
 *   call (drawn to a canvas, long side <= 1024 px), PNG-encoded and posted as `setTrackedImages` before
 *   native requestSession. Images that cannot be drawn, or have no positive width, are 'untrackable'
 *   without reaching native. session.getTrackedImageScores() resolves with one score per image.
 * - Native `onImages([{ index, transform, tracked, measuredWidthInMeters }])` (every frame while any image
 *   anchor exists; transform already in imageSpace convention: +X right, +Y image top, +Z toward the
 *   viewer) drives frame.getImageTrackingResults(): a frozen array, the same one for the whole frame,
 *   of XRImageTrackingResult { imageSpace ([SameObject] per index), index, trackingState 'tracked' |
 *   'emulated', measuredWidthInMeters }. Untrackable images never appear.
 */
import { mat4 } from 'gl-matrix';
import { P_DEVICE, P_FRAME, P_SPACE, XRDevice, XRFrame, XRSession, XRSpace, XRSystem } from 'iwer';
import { encodeTrackedImages, snapshotErrors, type NativeTrackedImage, type TrackedImageInit } from './image-snapshot.js';

export type { NativeTrackedImage, TrackedImageInit } from './image-snapshot.js';

export type XRImageTrackingScore = 'untrackable' | 'trackable';
export type XRImageTrackingState = 'tracked' | 'emulated';

export interface NativeImageResult {
  index: number;
  transform: ArrayLike<number>;
  tracked: boolean;
  measuredWidthInMeters?: number;
}

const FEATURE = 'image-tracking';

export class XRImageTrackingResult {
  readonly #space: XRSpace;
  readonly #index: number;
  readonly #state: XRImageTrackingState;
  readonly #width: number;

  constructor(space: XRSpace, index: number, state: XRImageTrackingState, width: number) {
    this.#space = space;
    this.#index = index;
    this.#state = state;
    this.#width = width;
  }

  get imageSpace(): XRSpace {
    return this.#space;
  }
  get index(): number {
    return this.#index;
  }
  get trackingState(): XRImageTrackingState {
    return this.#state;
  }
  get measuredWidthInMeters(): number {
    return this.#width;
  }
}

/** Carries the snapshots from the outermost requestSession wrapper to the session hook. */
export const SNAPSHOTS = Symbol('holoweb.trackedImageSnapshots');
export type SnapshotOptions = { trackedImages?: TrackedImageInit[]; requiredFeatures?: string[]; optionalFeatures?: string[]; [SNAPSHOTS]?: Promise<(NativeTrackedImage | null)[]> };

/**
 * Wrap requestSession outermost (install after every other requestSession hook) so images are drawn
 * synchronously in the page's call, before any hook awaits.
 */
export function installImageSnapshot(device: XRDevice): void {
  const xr = device[P_DEVICE].xrSystem;
  if (!(xr instanceof XRSystem)) throw new Error('HoloWeb: installRuntime must run before image tracking');
  const requestSession = xr.requestSession.bind(xr) as (mode: string, options?: SnapshotOptions) => Promise<XRSession>;
  (xr as unknown as { requestSession: typeof requestSession }).requestSession = (mode, options) => {
    const wants = [...(options?.requiredFeatures ?? []), ...(options?.optionalFeatures ?? [])].includes(FEATURE);
    if (!options || mode === 'inline' || !wants) return requestSession(mode, options);
    return requestSession(mode, { ...options, [SNAPSHOTS]: encodeTrackedImages(Array.from(options.trackedImages ?? [])) });
  };
}

/** Normalise native's score reply to one score per requested image. */
export function mergeScores(local: readonly (NativeTrackedImage | null)[], native: unknown): XRImageTrackingScore[] {
  const sent = local.filter((x): x is NativeTrackedImage => x !== null);
  const scores = Array.isArray(native) ? native : [];
  const byIndex = new Map(sent.map((img, i) => [img.index, scores[i] === 'trackable' ? 'trackable' : 'untrackable'] as const));
  return local.map((_, i) => byIndex.get(i) ?? 'untrackable');
}

export class ImageTracking {
  private readonly spaces = new Map<number, XRSpace>();
  private latest: NativeImageResult[] = [];
  private scores: readonly XRImageTrackingScore[] = [];
  private readonly sessionScores = new WeakMap<XRSession, Promise<readonly XRImageTrackingScore[]>>();
  private readonly perFrame = new WeakMap<XRFrame, readonly XRImageTrackingResult[]>();
  /** Diagnostics (e2e, device): page queries, frames with results, the last scores. */
  readonly stats = { resultQueries: 0, framesWithResults: 0, lastScores: [] as readonly XRImageTrackingScore[], snapshotErrors };

  constructor(private readonly device: XRDevice) {
    const self = this;
    Object.defineProperty(XRSession.prototype, 'getTrackedImageScores', {
      configurable: true,
      value: function getTrackedImageScores(this: XRSession): Promise<readonly XRImageTrackingScore[]> {
        if (!(this.enabledFeatures as readonly string[]).includes(FEATURE)) {
          return Promise.reject(new DOMException("'image-tracking' was not enabled for this session", 'NotSupportedError'));
        }
        return self.sessionScores.get(this) ?? Promise.resolve(Object.freeze([]));
      },
    });
    Object.defineProperty(XRFrame.prototype, 'getImageTrackingResults', {
      configurable: true,
      value: function getImageTrackingResults(this: XRFrame): readonly XRImageTrackingResult[] {
        if (!(this.session.enabledFeatures as readonly string[]).includes(FEATURE)) {
          throw new DOMException("'image-tracking' was not enabled for this session", 'NotSupportedError');
        }
        if (!this[P_FRAME].active) throw new DOMException('XRFrame is not active', 'InvalidStateError');
        let results = self.perFrame.get(this);
        if (!results) {
          results = self.results();
          self.perFrame.set(this, results);
          self.stats.resultQueries++;
          if (results.length) self.stats.framesWithResults++;
        }
        return results;
      },
    });
  }

  /** Scores for a session (set before native requestSession resolves). */
  setScores(session: XRSession, scores: Promise<readonly XRImageTrackingScore[]>): void {
    this.sessionScores.set(
      session,
      scores.then((s) => {
        this.scores = s;
        this.stats.lastScores = s;
        return Object.freeze([...s]);
      }),
    );
  }

  update(list: readonly NativeImageResult[]): void {
    if (!Array.isArray(list)) return;
    this.latest = list.filter((r) => r && Number.isInteger(r.index) && r.transform?.length === 16);
    for (const r of this.latest) {
      const space = this.spaces.get(r.index);
      if (space) mat4.copy(space[P_SPACE].offsetMatrix, r.transform as unknown as mat4);
      else this.spaces.set(r.index, new XRSpace(this.device[P_DEVICE].globalSpace, Float32Array.from(r.transform)));
    }
  }

  private results(): readonly XRImageTrackingResult[] {
    return Object.freeze(
      this.latest
        .filter((r) => this.scores[r.index] === 'trackable')
        .map((r) => new XRImageTrackingResult(this.spaces.get(r.index)!, r.index, r.tracked ? 'tracked' : 'emulated', Math.max(0, Number(r.measuredWidthInMeters) || 0))),
    );
  }

  /** Session ended: images are per ARSession. */
  clear(): void {
    this.spaces.clear();
    this.latest = [];
    this.scores = [];
  }
}
