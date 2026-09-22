/**
 * Viewer pose prediction for HoloKit stereo.
 *
 * In optical see-through stereo there is no camera image to sync with, so the pose is
 * extrapolated from the last two ARKit frames to the expected display time:
 * translation linearly, rotation along the great circle (slerp with factor > 1).
 * Mono never predicts: the native camera background is drawn for the exact ARFrame the
 * page reports through `rendered`, so the virtual content must use that frame's pose.
 */
import { mat4, quat, vec3 } from 'gl-matrix';

/** 1.5 frames at 60 Hz: ARFrame -> page rAF -> WebKit compositor -> display. */
export const DEFAULT_PREDICTION_MS = 25;
/** Largest gap between two ARKit frames still treated as consecutive. */
export const MAX_SAMPLE_GAP_MS = 100;
/** Cap on the extrapolation factor (horizon / sample gap) so a short gap cannot overshoot. */
export const MAX_EXTRAPOLATION = 4;

export interface PoseSample {
  /** ARFrame timestamp, ms. */
  t: number;
  /** Camera-to-world pose, column-major. */
  matrix: ArrayLike<number>;
}

/**
 * Extrapolate `cur` by `horizonMs` using the motion between `prev` and `cur`.
 * Returns a copy of `cur` when prediction is disabled or the samples are unusable.
 */
export function extrapolatePose(prev: PoseSample | null, cur: PoseSample, horizonMs: number, out = mat4.create()): mat4 {
  const m1 = cur.matrix as unknown as mat4;
  if (!prev || horizonMs <= 0) return mat4.copy(out, m1);
  const dt = cur.t - prev.t;
  if (!(dt > 0) || dt > MAX_SAMPLE_GAP_MS) return mat4.copy(out, m1);
  const k = Math.min(horizonMs / dt, MAX_EXTRAPOLATION);
  const m0 = prev.matrix as unknown as mat4;

  const p0 = mat4.getTranslation(vec3.create(), m0);
  const p1 = mat4.getTranslation(vec3.create(), m1);
  const p = vec3.scaleAndAdd(vec3.create(), p1, vec3.subtract(vec3.create(), p1, p0), k);

  const q0 = mat4.getRotation(quat.create(), m0);
  const q1 = mat4.getRotation(quat.create(), m1);
  quat.normalize(q0, q0);
  quat.normalize(q1, q1);
  // slerp(q0, q1, 1 + k) continues the q0 -> q1 rotation for k more sample intervals.
  const q = quat.slerp(quat.create(), q0, q1, 1 + k);
  quat.normalize(q, q);
  return mat4.fromRotationTranslation(out, q, p);
}

/** Keeps the previous sample and produces predicted poses. */
export class PosePredictor {
  horizonMs = DEFAULT_PREDICTION_MS;
  private prev: PoseSample | null = null;

  /** Record `cur` and return its pose extrapolated by the horizon (or unchanged). */
  predict(cur: PoseSample, out = mat4.create()): mat4 {
    const result = extrapolatePose(this.prev, cur, this.horizonMs, out);
    this.prev = { t: cur.t, matrix: Float32Array.from(cur.matrix) };
    return result;
  }

  reset(): void {
    this.prev = null;
  }
}
