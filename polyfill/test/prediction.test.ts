import { mat4, quat, vec3 } from 'gl-matrix';
import { describe, expect, it } from 'vitest';
import { DEFAULT_PREDICTION_MS, extrapolatePose, MAX_EXTRAPOLATION, PosePredictor } from '../src/prediction.js';

const FRAME = 1000 / 60;
const deg = (d: number) => (d * Math.PI) / 180;

function pose(yawDeg: number, pos: [number, number, number], axis: [number, number, number] = [0, 1, 0]): Float32Array {
  const q = quat.setAxisAngle(quat.create(), axis, deg(yawDeg));
  return mat4.fromRotationTranslation(new Float32Array(16), q, pos) as Float32Array;
}

/** Signed rotation angle (degrees) of a pose about `axis`. */
function angleAbout(m: mat4, axis: [number, number, number]): number {
  const q = mat4.getRotation(quat.create(), m);
  const out = vec3.create();
  const a = quat.getAxisAngle(out, q);
  const sign = vec3.dot(out, axis) < 0 ? -1 : 1;
  const d = (sign * a * 180) / Math.PI;
  return d > 180 ? d - 360 : d;
}

describe('extrapolatePose', () => {
  it('extrapolates translation linearly by horizon / sample gap', () => {
    const prev = { t: 0, matrix: pose(0, [0, 1.5, 0]) };
    const cur = { t: FRAME, matrix: pose(0, [0.01, 1.5, -0.02]) };
    const out = extrapolatePose(prev, cur, 25);
    const k = 25 / FRAME; // 1.5
    expect(out[12]).toBeCloseTo(0.01 + 0.01 * k, 6);
    expect(out[13]).toBeCloseTo(1.5, 6);
    expect(out[14]).toBeCloseTo(-0.02 - 0.02 * k, 6);
  });

  it('continues a constant angular velocity (2 deg/frame -> +3 deg over 1.5 frames)', () => {
    const prev = { t: 100, matrix: pose(10, [0, 0, 0]) };
    const cur = { t: 100 + FRAME, matrix: pose(12, [0, 0, 0]) };
    expect(angleAbout(extrapolatePose(prev, cur, 25), [0, 1, 0])).toBeCloseTo(15, 3);
  });

  it('handles fast rotation about a tilted axis (30 deg/frame)', () => {
    const axis = vec3.normalize(vec3.create(), [1, 2, 0.5]) as unknown as [number, number, number];
    const prev = { t: 0, matrix: pose(0, [0, 0, 0], axis) };
    const cur = { t: FRAME, matrix: pose(30, [0, 0, 0], axis) };
    expect(angleAbout(extrapolatePose(prev, cur, 25), axis)).toBeCloseTo(75, 2);
  });

  it('keeps the rotation orthonormal', () => {
    const out = extrapolatePose({ t: 0, matrix: pose(0, [0, 0, 0]) }, { t: FRAME, matrix: pose(20, [1, 0, 0]) }, 25);
    const x = vec3.fromValues(out[0], out[1], out[2]);
    const y = vec3.fromValues(out[4], out[5], out[6]);
    expect(vec3.length(x)).toBeCloseTo(1, 5);
    expect(vec3.length(y)).toBeCloseTo(1, 5);
    expect(vec3.dot(x, y)).toBeCloseTo(0, 5);
  });

  it('takes the short way through 180 deg (quaternion hemisphere flip)', () => {
    // 175 -> 185 deg is +10 deg/frame; extracted quaternions lie on opposite hemispheres
    const prev = { t: 0, matrix: pose(175, [0, 0, 0]) };
    const cur = { t: FRAME, matrix: pose(185, [0, 0, 0]) };
    expect(angleAbout(extrapolatePose(prev, cur, 25), [0, 1, 0])).toBeCloseTo(-160, 2); // 200 deg
  });

  it('returns the current pose when disabled or the samples are unusable', () => {
    const prev = { t: 0, matrix: pose(0, [0, 0, 0]) };
    const cur = { t: FRAME, matrix: pose(10, [0.1, 0, 0]) };
    for (const out of [
      extrapolatePose(prev, cur, 0),
      extrapolatePose(null, cur, 25),
      extrapolatePose({ ...prev, t: FRAME }, cur, 25), // dt = 0
      extrapolatePose({ ...prev, t: 2 * FRAME }, cur, 25), // out of order
      extrapolatePose({ ...prev, t: FRAME - 150 }, cur, 25), // gap > 100 ms (tracking dropout)
    ]) {
      for (let i = 0; i < 16; i++) expect(out[i]).toBeCloseTo(cur.matrix[i], 6);
    }
  });

  it('caps the extrapolation factor for very short sample gaps', () => {
    const out = extrapolatePose({ t: 0, matrix: pose(0, [0, 0, 0]) }, { t: 2, matrix: pose(0, [0.001, 0, 0]) }, 25);
    expect(out[12]).toBeCloseTo(0.001 * (1 + MAX_EXTRAPOLATION), 6);
  });
});

describe('PosePredictor', () => {
  it('defaults to 25 ms (1.5 frames) and predicts from the previous sample', () => {
    const p = new PosePredictor();
    expect(p.horizonMs).toBe(DEFAULT_PREDICTION_MS);
    const first = p.predict({ t: 0, matrix: pose(0, [0, 0, 0]) });
    expect(first[12]).toBe(0);
    const second = p.predict({ t: FRAME, matrix: pose(0, [0.02, 0, 0]) });
    expect(second[12]).toBeCloseTo(0.05, 6);
  });

  it('does not keep a reference to the caller buffer', () => {
    const p = new PosePredictor();
    const buf = pose(0, [0, 0, 0]);
    p.predict({ t: 0, matrix: buf });
    buf[12] = 5; // caller reuses its buffer
    expect(p.predict({ t: FRAME, matrix: pose(0, [0, 0, 0]) })[12]).toBeCloseTo(0, 6);
  });

  it('reset() forgets the previous sample', () => {
    const p = new PosePredictor();
    p.predict({ t: 0, matrix: pose(0, [0, 0, 0]) });
    p.reset();
    expect(p.predict({ t: FRAME, matrix: pose(0, [0.02, 0, 0]) })[12]).toBeCloseTo(0.02, 6);
  });
});
