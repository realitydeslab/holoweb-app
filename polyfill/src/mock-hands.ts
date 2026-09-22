/**
 * Synthetic right hand for the desktop mock: held ~35 cm in front of the camera, fingers up, back of
 * the hand towards the camera, pinching for PINCH_MS of every PERIOD_MS. Joints are produced in the
 * Vision order native sends (hands.ts) and transformed to world space with the camera pose.
 */
import { mat4, vec3 } from 'gl-matrix';
import type { NativeHandData } from './hand-input.js';

export const PERIOD_MS = 2400;
export const PINCH_MS = 800;

type P = [number, number, number];
// camera space (x right, y up, -z forward), relative to the wrist
const OPEN: P[] = [
  [0, 0, 0],
  [-0.02, 0.02, -0.005], [-0.04, 0.045, -0.01], [-0.05, 0.07, -0.015], [-0.055, 0.09, -0.02],
  [-0.025, 0.08, 0], [-0.027, 0.12, 0], [-0.028, 0.145, 0], [-0.029, 0.165, 0],
  [-0.005, 0.085, 0], [-0.005, 0.13, 0], [-0.005, 0.155, 0], [-0.005, 0.175, 0],
  [0.015, 0.08, 0], [0.017, 0.12, 0], [0.018, 0.143, 0], [0.019, 0.16, 0],
  [0.032, 0.07, 0], [0.036, 0.1, 0], [0.038, 0.12, 0], [0.04, 0.135, 0],
];
const PINCH_TARGET: P = [-0.04, 0.115, -0.03];
const WRIST_IN_CAMERA: P = [0.08, -0.12, -0.35];

/** Joint positions in camera space for a pinch amount p in [0, 1]. */
export function mockHandCameraSpace(p: number): P[] {
  return OPEN.map((joint, i) => {
    const moved: P = i === 4 || i === 8 ? [
      joint[0] + (PINCH_TARGET[0] - joint[0]) * p,
      joint[1] + (PINCH_TARGET[1] - joint[1]) * p,
      joint[2] + (PINCH_TARGET[2] - joint[2]) * p,
    ] : joint;
    return [moved[0] + WRIST_IN_CAMERA[0], moved[1] + WRIST_IN_CAMERA[1], moved[2] + WRIST_IN_CAMERA[2]];
  });
}

/** Pinch amount over time: eased in and out, fully closed in the middle of the pinch window. */
export function pinchAmount(ms: number): number {
  const t = ms % PERIOD_MS;
  if (t >= PINCH_MS) return 0;
  return Math.min(1, Math.sin((t / PINCH_MS) * Math.PI) * 1.6);
}

export function mockHand(cameraPose: mat4, ms: number): NativeHandData {
  const joints: number[] = [];
  for (const p of mockHandCameraSpace(pinchAmount(ms))) {
    const w = vec3.transformMat4(vec3.create(), p, cameraPose);
    joints.push(w[0], w[1], w[2]);
  }
  return { handedness: 'right', joints, confidence: new Array(21).fill(0.9), depthValid: (1 << 21) - 1 };
}
