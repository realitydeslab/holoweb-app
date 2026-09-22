/**
 * WebXR Hand Input over native hand tracking (Vision hand pose + LiDAR depth, see hands.ts).
 *
 * Drives IWER's two XRHandInput objects (XRInputSource with an XRHand of 25 XRJointSpaces), so
 * frame.getJointPose / fillPoses / fillJointRadii and inputsourceschange come from IWER.
 * - A hand is connected while native keeps sending it; it is dropped LOST_MS after the last update.
 * - Target ray: origin at the pinch point (between thumb tip and index tip), direction away from the
 *   viewer through that point, i.e. "point through your hand" on a phone or HoloKit.
 * - Pinch (thumb tip to index tip, hysteresis in hands.ts) -> selectstart, then select + selectend on
 *   release, in spec order. IWER's own gamepad trigger fires `select` on press, so it is disabled; the
 *   'pinch' gamepad button still reports the state.
 * - Joints below MIN_CONFIDENCE keep their last position; a hand without a complete skeleton is ignored.
 * Input sources exist only for sessions with the 'hand-tracking' feature (IWER filters the rest).
 */
import { mat4, quat, vec3 } from 'gl-matrix';
import { P_DEVICE, P_GAMEPAD, P_JOINT_SPACE, P_SPACE, XRDevice, XRInputSourceEvent, XRSession } from 'iwer';
import type { XRHandInput } from 'iwer/lib/device/XRHandInput.js';
import { isVisible } from './visibility.js';
import { buildSkeleton, isCompleteHand, JOINTS, pinchPoint, pinchState, VISION_JOINT_COUNT, type Handedness } from './hands.js';

export interface NativeHandData {
  handedness: Handedness;
  /** 21 Vision joints x (x, y, z), ARKit world space, metres. */
  joints: ArrayLike<number>;
  /** Optional per-joint Vision confidence in [0, 1]. */
  confidence?: ArrayLike<number>;
}

export const LOST_MS = 250;
export const MIN_CONFIDENCE = 0.3;

interface HandState {
  input: XRHandInput;
  points: Float32Array | null;
  lastSeen: number;
  pinching: boolean;
  /** Pinch transitions waiting for the next XR frame. */
  pending: ('down' | 'up')[];
  /** selectstart was dispatched and select/selectend is still owed. */
  pressed: boolean;
  framesConnected: number;
}

const FORWARD = vec3.fromValues(0, 0, -1);

export class HandTracking {
  private readonly hands: Record<Handedness, HandState>;
  /** Number of onHands updates applied (diagnostics). */
  updates = 0;

  constructor(private readonly device: XRDevice) {
    const make = (input: XRHandInput | undefined): HandState => {
      if (!input) throw new Error('HoloWeb: IWER hand inputs missing');
      input.connected = false;
      // IWER re-applies its canned Oculus hand poses in every onFrameStart; joints come from native here
      input.updateHandPose = () => undefined;
      // spec-ordered select events are dispatched here instead of by IWER's gamepad trigger
      input.inputSource.gamepad![P_GAMEPAD].buttonsMap['pinch']![P_GAMEPAD].eventTrigger = null;
      return { input, points: null, lastSeen: 0, pinching: false, pending: [], pressed: false, framesConnected: 0 };
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
  update(list: readonly NativeHandData[]): void {
    if (!isVisible(this.device)) return; // no input while blurred / hidden
    const now = performance.now();
    for (const data of list) {
      const hand = data && this.hands[data.handedness];
      if (!hand) continue;
      const points = this.merge(hand, data);
      if (!points) continue;
      this.apply(hand, points);
      hand.lastSeen = now;
      hand.input.connected = true;
      this.updates++;
    }
  }

  /** Session ended: drop hands and pending events. */
  reset(): void {
    for (const hand of Object.values(this.hands)) {
      hand.input.connected = false;
      Object.assign(hand, { points: null, pinching: false, pending: [], pressed: false, framesConnected: 0 });
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

  private apply(hand: HandState, points: Float32Array): void {
    hand.points = points;
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
    const palm = vec3.lerp(vec3.create(), vec3.fromValues(points[0], points[1], points[2]), vec3.fromValues(points[27], points[28], points[29]), 0.5);
    grip[12] = palm[0];
    grip[13] = palm[1];
    grip[14] = palm[2];
    mat4.multiply(hand.input.inputSource.gripSpace![P_SPACE].offsetMatrix, rayInverse, grip);

    const pinching = pinchState(points, hand.pinching);
    if (pinching !== hand.pinching) {
      hand.pinching = pinching;
      hand.pending.push(pinching ? 'down' : 'up');
      hand.input.inputSource.gamepad![P_GAMEPAD].buttonsMap['pinch']![P_GAMEPAD].pendingValue = pinching ? 1 : 0;
    }
  }

  private onFrameStart(session: XRSession, frame: Parameters<XRDevice[typeof P_DEVICE]['onFrameStart']>[0]): void {
    const now = performance.now();
    const tracking = session.enabledFeatures.includes('hand-tracking');
    for (const hand of Object.values(this.hands)) {
      const source = hand.input.inputSource;
      const fire = (type: string) => tracking && session.dispatchEvent(new XRInputSourceEvent(type, { frame, inputSource: source }));
      if (hand.input.connected && (now - hand.lastSeen > LOST_MS || !isVisible(this.device))) {
        // lost while pinching: end the press without a select (spec: source removed)
        if (hand.pressed) fire('selectend');
        this.resetHand(hand);
        continue;
      }
      if (!hand.input.connected) continue;
      // the page learns about the source through inputsourceschange, fired after this hook
      if (++hand.framesConnected < 2) continue;
      for (const transition of hand.pending.splice(0)) {
        if (transition === 'down' && !hand.pressed) {
          hand.pressed = true;
          fire('selectstart');
        } else if (transition === 'up' && hand.pressed) {
          hand.pressed = false;
          fire('select');
          fire('selectend');
        }
      }
    }
  }

  private resetHand(hand: HandState): void {
    hand.input.connected = false;
    hand.input.inputSource.gamepad![P_GAMEPAD].buttonsMap['pinch']![P_GAMEPAD].pendingValue = 0;
    Object.assign(hand, { points: null, pinching: false, pending: [], pressed: false, framesConnected: 0 });
  }

  /** Connected hands (diagnostics). */
  get connected(): Handedness[] {
    return (Object.keys(this.hands) as Handedness[]).filter((h) => this.hands[h].input.connected);
  }
}
