/**
 * WebXR Hand Input over native hand tracking (Vision hand pose + LiDAR depth, see hands.ts).
 *
 * Drives IWER's two XRHandInput objects (XRInputSource with an XRHand of 25 XRJointSpaces), so
 * frame.getJointPose / fillPoses / fillJointRadii and inputsourceschange come from IWER.
 * - Native sends `onHands({ t, hands })` (t = ARFrame ms; a bare array is accepted too). Each joint
 *   is smoothed with a One Euro filter on that clock; joints whose `depthValid` bit is clear (depth
 *   inferred natively) are filtered harder. Filters restart when a hand reappears.
 * - A hand is connected while native keeps sending it; it is dropped LOST_MS after the last update
 *   or when the app is not visible.
 * - Target ray: origin at the pinch point, direction away from the viewer through it.
 *   Grip: palm centre (wrist + knuckles), wrist orientation.
 * - Gestures use the unfiltered joints (hysteresis, no filter lag); poses use the filtered ones.
 * - Pinch (thresholds scaled by hand size) -> selectstart, then select + selectend on release.
 *   Grab (curl ratio) -> squeezestart, then squeeze + squeezeend; a grab cancels a pinch (selectend
 *   only), because a fist brings the thumb onto the index finger. Events follow spec order; IWER's
 *   gamepad trigger (select on press) is disabled, the 'pinch' button still reports the pinch state.
 * - Joints below MIN_CONFIDENCE keep their last position; a hand without a complete skeleton is ignored.
 * Input sources exist only for sessions with the 'hand-tracking' feature (IWER filters the rest).
 */
import { mat4, quat, vec3 } from 'gl-matrix';
import { P_DEVICE, P_GAMEPAD, P_JOINT_SPACE, P_SPACE, XRDevice, XRInputSourceEvent, XRSession } from 'iwer';
import type { XRHandInput } from 'iwer/lib/device/XRHandInput.js';
import { buildSkeleton, isCompleteHand, JOINTS, palmCenter, pinchPoint, pinchState, squeezeState, VISION_JOINT_COUNT, type Handedness } from './hands.js';
import { HAND_FILTER, HAND_FILTER_INFERRED, OneEuro3 } from './one-euro.js';
import { isVisible } from './visibility.js';

export interface NativeHandData {
  handedness: Handedness;
  /** 21 Vision joints x (x, y, z), ARKit world space, metres. */
  joints: ArrayLike<number>;
  /** Optional per-joint Vision confidence in [0, 1]. */
  confidence?: ArrayLike<number>;
  /** Optional bitmask: bit i set = joint i has measured (not inferred) depth. */
  depthValid?: number;
}

/** `{ t, hands }` (t = source ARFrame timestamp, ms), or a bare array (older native builds). */
export type NativeHandsUpdate = NativeHandData[] | { t?: number; hands: NativeHandData[] };

export const LOST_MS = 250;
export const MIN_CONFIDENCE = 0.3;

type Gesture = 'select' | 'squeeze';
interface Transition {
  gesture: Gesture;
  /** 'cancel': end without the completing event (select / squeeze). */
  to: 'down' | 'up' | 'cancel';
}

interface HandState {
  input: XRHandInput;
  points: Float32Array | null;
  filters: OneEuro3[];
  lastT: number | null;
  lastSeen: number;
  pinching: boolean;
  squeezing: boolean;
  /** Gesture transitions waiting for the next XR frame. */
  pending: Transition[];
  /** A *start event was dispatched and its end is still owed. */
  pressed: Record<Gesture, boolean>;
  framesConnected: number;
}

const FORWARD = vec3.fromValues(0, 0, -1);

function freshState(): Omit<HandState, 'input' | 'filters'> {
  return {
    points: null,
    lastT: null,
    lastSeen: 0,
    pinching: false,
    squeezing: false,
    pending: [],
    pressed: { select: false, squeeze: false },
    framesConnected: 0,
  };
}

export class HandTracking {
  private readonly hands: Record<Handedness, HandState>;
  /** Number of onHands hand updates applied (diagnostics). */
  updates = 0;

  constructor(private readonly device: XRDevice) {
    const make = (input: XRHandInput | undefined): HandState => {
      if (!input) throw new Error('HoloWeb: IWER hand inputs missing');
      input.connected = false;
      // IWER re-applies its canned Oculus hand poses in every onFrameStart; joints come from native here
      input.updateHandPose = () => undefined;
      // spec-ordered select events are dispatched here instead of by IWER's gamepad trigger
      input.inputSource.gamepad![P_GAMEPAD].buttonsMap['pinch']![P_GAMEPAD].eventTrigger = null;
      return { input, filters: Array.from({ length: VISION_JOINT_COUNT }, () => new OneEuro3()), ...freshState() };
    };
    this.hands = { left: make(device.hands.left), right: make(device.hands.right) };
    device.primaryInputMode = 'hand';
    const state = device[P_DEVICE];
    const frameStart = state.onFrameStart;
    state.onFrameStart = (frame) => {
      frameStart(frame);
      this.onFrameStart(frame.session, frame);
    };
  }

  /** Apply a native hands update (Vision rate, typically 30 Hz). */
  update(update: NativeHandsUpdate): void {
    if (!isVisible(this.device)) return; // no input while blurred / hidden
    const list = Array.isArray(update) ? update : (update?.hands ?? []);
    const nativeT = !Array.isArray(update) && typeof update?.t === 'number' ? update.t : undefined;
    const now = performance.now();
    const t = (nativeT ?? now) / 1000;
    for (const data of list) {
      const hand = data && this.hands[data.handedness];
      if (!hand) continue;
      if (!hand.input.connected) {
        hand.filters.forEach((f) => f.reset()); // reappeared: no smoothing across the gap
        hand.lastT = null;
      }
      const merged = this.merge(hand, data);
      if (!merged) continue;
      const points = this.smooth(hand, merged, t, data.depthValid);
      this.apply(hand, points, merged);
      hand.lastSeen = now;
      hand.input.connected = true;
      this.updates++;
    }
  }

  /** Session ended: drop hands and pending events. */
  reset(): void {
    for (const hand of Object.values(this.hands)) {
      hand.input.connected = false;
      hand.filters.forEach((f) => f.reset());
      Object.assign(hand, freshState());
    }
  }

  private merge(hand: HandState, data: NativeHandData): Float32Array | null {
    if (!data.joints || data.joints.length < VISION_JOINT_COUNT * 3) return null;
    const out = Float32Array.from(data.joints);
    for (let i = 0; i < VISION_JOINT_COUNT; i++) {
      const low = data.confidence !== undefined && !(data.confidence[i] >= MIN_CONFIDENCE);
      if (!low) continue;
      if (!hand.points) out[i * 3] = NaN;
      else out.set(hand.points.subarray(i * 3, i * 3 + 3), i * 3);
    }
    return isCompleteHand(out) ? out : null;
  }

  private smooth(hand: HandState, raw: Float32Array, t: number, depthValid: number | undefined): Float32Array {
    const dt = hand.lastT === null ? 0 : t - hand.lastT;
    hand.lastT = t;
    const out = new Float32Array(raw.length);
    for (let i = 0; i < VISION_JOINT_COUNT; i++) {
      const inferred = depthValid !== undefined && (depthValid & (1 << i)) === 0;
      out.set(hand.filters[i].filter(raw.subarray(i * 3, i * 3 + 3), dt, inferred ? HAND_FILTER_INFERRED : HAND_FILTER), i * 3);
    }
    return out;
  }

  /** Poses from the smoothed joints; gestures from the raw ones (hysteresis handles the noise, no filter lag). */
  private apply(hand: HandState, points: Float32Array, raw: Float32Array): void {
    hand.points = raw;
    const handedness = hand.input.inputSource.handedness as Handedness;
    const skeleton = buildSkeleton(points, handedness);

    // target ray: pinch point, pointing away from the viewer
    const origin = pinchPoint(points);
    const dir = vec3.subtract(vec3.create(), origin, this.device.position.vec3);
    if (vec3.length(dir) < 1e-6) vec3.set(dir, 0, 0, -1);
    vec3.normalize(dir, dir);
    const rotation = quat.rotationTo(quat.create(), FORWARD, dir);
    hand.input.position.set(origin[0], origin[1], origin[2]);
    hand.input.quaternion.set(rotation[0], rotation[1], rotation[2], rotation[3]);
    const rayInverse = mat4.invert(mat4.create(), mat4.fromRotationTranslation(mat4.create(), rotation, origin))!;

    // joint and grip spaces are children of the target-ray space in IWER
    const xrHand = hand.input.inputSource.hand!;
    JOINTS.forEach((joint, i) => {
      const space = xrHand.get(joint.name as Parameters<typeof xrHand.get>[0]);
      if (!space) return;
      mat4.multiply(space[P_SPACE].offsetMatrix, rayInverse, skeleton.poses[i]);
      space[P_JOINT_SPACE].radius = skeleton.radii[i];
    });
    const grip = mat4.clone(skeleton.poses[0]);
    const palm = palmCenter(points);
    grip[12] = palm[0];
    grip[13] = palm[1];
    grip[14] = palm[2];
    mat4.multiply(hand.input.inputSource.gripSpace![P_SPACE].offsetMatrix, rayInverse, grip);

    // grab first: a fist also closes thumb and index, so it cancels / suppresses the pinch
    // (the pinch ends before the squeeze starts)
    const squeezing = squeezeState(raw, hand.squeezing);
    const pinching = !squeezing && pinchState(raw, hand.pinching);
    if (pinching !== hand.pinching) {
      hand.pinching = pinching;
      hand.pending.push({ gesture: 'select', to: pinching ? 'down' : squeezing ? 'cancel' : 'up' });
      hand.input.inputSource.gamepad![P_GAMEPAD].buttonsMap['pinch']![P_GAMEPAD].pendingValue = pinching ? 1 : 0;
    }
    if (squeezing !== hand.squeezing) {
      hand.squeezing = squeezing;
      hand.pending.push({ gesture: 'squeeze', to: squeezing ? 'down' : 'up' });
    }
  }

  private onFrameStart(session: XRSession, frame: Parameters<XRDevice[typeof P_DEVICE]['onFrameStart']>[0]): void {
    const now = performance.now();
    const tracking = session.enabledFeatures.includes('hand-tracking');
    for (const hand of Object.values(this.hands)) {
      const source = hand.input.inputSource;
      const fire = (type: string) => tracking && session.dispatchEvent(new XRInputSourceEvent(type, { frame, inputSource: source }));
      if (hand.input.connected && (now - hand.lastSeen > LOST_MS || !isVisible(this.device))) {
        // lost / blurred mid-gesture: end presses without their completing events (source removed)
        if (hand.pressed.select) fire('selectend');
        if (hand.pressed.squeeze) fire('squeezeend');
        this.resetHand(hand);
        continue;
      }
      if (!hand.input.connected) continue;
      // the page learns about the source through inputsourceschange, fired after this hook
      if (++hand.framesConnected < 2) continue;
      for (const { gesture, to } of hand.pending.splice(0)) {
        if (to === 'down' && !hand.pressed[gesture]) {
          hand.pressed[gesture] = true;
          fire(`${gesture}start`);
        } else if (to !== 'down' && hand.pressed[gesture]) {
          hand.pressed[gesture] = false;
          if (to === 'up') fire(gesture);
          fire(`${gesture}end`);
        }
      }
    }
  }

  private resetHand(hand: HandState): void {
    hand.input.connected = false;
    hand.input.inputSource.gamepad![P_GAMEPAD].buttonsMap['pinch']![P_GAMEPAD].pendingValue = 0;
    hand.filters.forEach((f) => f.reset());
    Object.assign(hand, freshState());
  }

  /** Connected hands (diagnostics). */
  get connected(): Handedness[] {
    return (Object.keys(this.hands) as Handedness[]).filter((h) => this.hands[h].input.connected);
  }
}
