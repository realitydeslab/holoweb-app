/**
 * Hand skeleton math: 21 Vision hand-pose joints (lifted to 3D world space by native with LiDAR
 * depth) -> the 25 WebXR Hand Input joints with poses and radii, plus pinch detection.
 *
 * Input order (Vision VNHumanHandPoseObservation, same as MediaPipe):
 *   0 wrist
 *   1-4   thumb  CMC, MP, IP, tip
 *   5-8   index  MCP, PIP, DIP, tip
 *   9-12  middle MCP, PIP, DIP, tip
 *   13-16 ring   MCP, PIP, DIP, tip
 *   17-20 little MCP, PIP, DIP, tip
 * WebXR mapping: thumb CMC/MP/IP/tip -> thumb-metacarpal / -phalanx-proximal / -phalanx-distal / -tip;
 * finger MCP/PIP/DIP/tip -> -phalanx-proximal / -intermediate / -distal / -tip. Vision has no finger
 * carpometacarpal joints, so `<finger>-metacarpal` is estimated at METACARPAL_T along wrist -> MCP.
 *
 * Joint orientation (WebXR Hand Input): -Z points along the bone towards the fingertip, +Y points
 * out of the back of the hand; X completes a right-handed frame. Radii are typical adult values.
 */
import { mat4, vec3 } from 'gl-matrix';

export const VISION_JOINT_COUNT = 21;
export const METACARPAL_T = 0.25;
/** Pinch closes below PINCH_ON metres between thumb tip and index tip, opens above PINCH_OFF. */
export const PINCH_ON = 0.02;
export const PINCH_OFF = 0.035;

export type Handedness = 'left' | 'right';

const FINGERS = ['index-finger', 'middle-finger', 'ring-finger', 'pinky-finger'] as const;

/** WebXR joint names in XRHand order, with the source of each joint's position. */
export interface JointSource {
  name: string;
  /** Vision index, or [a, b, t] = lerp(vision[a], vision[b], t). */
  from: number | [number, number, number];
  /** Vision index of the next joint towards the tip (bone direction), or -1 for tips. */
  next: number | [number, number, number];
  radius: number;
}

function fingerJoints(finger: (typeof FINGERS)[number], mcp: number): JointSource[] {
  // spec radius table (samples_requirements.md G10); the pinky is ~15 % thinner
  const k = finger === 'pinky-finger' ? 0.85 : 1;
  return [
    { name: `${finger}-metacarpal`, from: [0, mcp, METACARPAL_T], next: mcp, radius: 0.011 * k },
    { name: `${finger}-phalanx-proximal`, from: mcp, next: mcp + 1, radius: 0.01 * k },
    { name: `${finger}-phalanx-intermediate`, from: mcp + 1, next: mcp + 2, radius: 0.009 * k },
    { name: `${finger}-phalanx-distal`, from: mcp + 2, next: mcp + 3, radius: 0.008 * k },
    { name: `${finger}-tip`, from: mcp + 3, next: -1, radius: 0.007 * k },
  ];
}

export const JOINTS: readonly JointSource[] = [
  { name: 'wrist', from: 0, next: 9, radius: 0.02 },
  { name: 'thumb-metacarpal', from: 1, next: 2, radius: 0.012 },
  { name: 'thumb-phalanx-proximal', from: 2, next: 3, radius: 0.01 },
  { name: 'thumb-phalanx-distal', from: 3, next: 4, radius: 0.009 },
  { name: 'thumb-tip', from: 4, next: -1, radius: 0.008 },
  ...FINGERS.flatMap((finger, i) => fingerJoints(finger, 5 + 4 * i)),
];

function point(points: ArrayLike<number>, src: number | [number, number, number], out: vec3): vec3 {
  if (typeof src === 'number') return vec3.set(out, points[src * 3], points[src * 3 + 1], points[src * 3 + 2]);
  const [a, b, t] = src;
  const pa = vec3.fromValues(points[a * 3], points[a * 3 + 1], points[a * 3 + 2]);
  const pb = vec3.fromValues(points[b * 3], points[b * 3 + 1], points[b * 3 + 2]);
  return vec3.lerp(out, pa, pb, t);
}

/** Unit vector out of the back of the hand, from the wrist and index / pinky knuckles. */
export function dorsalNormal(points: ArrayLike<number>, handedness: Handedness): vec3 {
  const wrist = point(points, 0, vec3.create());
  const index = vec3.subtract(vec3.create(), point(points, 5, vec3.create()), wrist);
  const pinky = vec3.subtract(vec3.create(), point(points, 17, vec3.create()), wrist);
  const n = vec3.normalize(vec3.create(), vec3.cross(vec3.create(), index, pinky));
  // index x pinky points out of the palm for a right hand and out of the back for a left hand
  return handedness === 'right' ? vec3.negate(n, n) : n;
}

export interface HandSkeleton {
  /** World pose per WebXR joint, JOINTS order. */
  poses: mat4[];
  radii: number[];
}

/** Build the 25 WebXR joint poses from 21 world-space points (x, y, z per joint). */
export function buildSkeleton(points: ArrayLike<number>, handedness: Handedness): HandSkeleton {
  const dorsal = dorsalNormal(points, handedness);
  const positions = JOINTS.map((j) => point(points, j.from, vec3.create()));
  const poses = JOINTS.map((joint, i) => {
    const p = positions[i];
    // bone direction: towards the next joint; tips reuse the previous bone of the same chain
    const along =
      joint.next !== -1
        ? vec3.subtract(vec3.create(), point(points, joint.next, vec3.create()), p)
        : vec3.subtract(vec3.create(), p, positions[i - 1]);
    const z = vec3.normalize(vec3.create(), vec3.negate(along, along));
    const y = vec3.scaleAndAdd(vec3.create(), dorsal, z, -vec3.dot(dorsal, z));
    if (vec3.length(y) < 1e-6) vec3.set(y, 0, 1, 0);
    vec3.normalize(y, y);
    const x = vec3.cross(vec3.create(), y, z);
    return mat4.fromValues(x[0], x[1], x[2], 0, y[0], y[1], y[2], 0, z[0], z[1], z[2], 0, p[0], p[1], p[2], 1);
  });
  return { poses, radii: JOINTS.map((j) => j.radius) };
}

/** True when every one of the 21 points is a finite number. */
export function isCompleteHand(points: ArrayLike<number> | null | undefined): points is ArrayLike<number> {
  if (!points || points.length < VISION_JOINT_COUNT * 3) return false;
  for (let i = 0; i < VISION_JOINT_COUNT * 3; i++) if (!Number.isFinite(points[i])) return false;
  return true;
}

/** Wrist to middle knuckle over a typical adult 0.095 m: scales gesture thresholds to the hand. */
export function handScale(points: ArrayLike<number>): number {
  const d = vec3.distance(point(points, 0, vec3.create()), point(points, 9, vec3.create()));
  return d > 0 ? d / 0.095 : 1;
}

/** Thumb-tip to index-tip distance with hysteresis, thresholds scaled by hand size. */
export function pinchState(points: ArrayLike<number>, wasPinching: boolean): boolean {
  const d = vec3.distance(point(points, 4, vec3.create()), point(points, 8, vec3.create()));
  const s = handScale(points);
  return wasPinching ? d < PINCH_OFF * s : d < PINCH_ON * s;
}

/** Squeeze (grab) closes when the curl ratio drops below SQUEEZE_ON and opens above SQUEEZE_OFF. */
export const SQUEEZE_ON = 1.35;
export const SQUEEZE_OFF = 1.55;

/** Mean over index..pinky of |tip - wrist| / |MCP - wrist|: ~2 for an open hand, ~1.1 for a fist. */
export function curlRatio(points: ArrayLike<number>): number {
  const wrist = point(points, 0, vec3.create());
  let sum = 0;
  for (const mcp of [5, 9, 13, 17]) {
    const knuckle = vec3.distance(point(points, mcp, vec3.create()), wrist);
    sum += knuckle > 0 ? vec3.distance(point(points, mcp + 3, vec3.create()), wrist) / knuckle : 2;
  }
  return sum / 4;
}

export function squeezeState(points: ArrayLike<number>, wasSqueezing: boolean): boolean {
  const c = curlRatio(points);
  return wasSqueezing ? c < SQUEEZE_OFF : c < SQUEEZE_ON;
}

/** Palm centre: mean of the wrist and the four finger knuckles. */
export function palmCenter(points: ArrayLike<number>): vec3 {
  const out = vec3.create();
  for (const i of [0, 5, 9, 13, 17]) vec3.add(out, out, point(points, i, vec3.create()));
  return vec3.scale(out, out, 1 / 5);
}

/** Midpoint of thumb tip and index tip (target-ray origin). */
export function pinchPoint(points: ArrayLike<number>): vec3 {
  return vec3.lerp(vec3.create(), point(points, 4, vec3.create()), point(points, 8, vec3.create()), 0.5);
}
