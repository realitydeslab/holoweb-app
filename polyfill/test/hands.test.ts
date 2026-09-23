// @vitest-environment happy-dom
import { mat4, vec3 } from 'gl-matrix';
import { XRHandJoint } from 'iwer/lib/input/XRHand.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildSkeleton, isCompleteHand, JOINTS, METACARPAL_T, pinchState } from '../src/hands.js';
import { LOST_MS } from '../src/hand-input.js';
import type { HoloWebGlobal } from '../src/index.js';
import { mockHand, mockHandCameraSpace } from '../src/mock-hands.js';

const open = mockHandCameraSpace(0).flat();
const pinched = mockHandCameraSpace(1).flat();
const at = (pts: number[], i: number) => vec3.fromValues(pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2]);
const jointIndex = (name: string) => JOINTS.findIndex((j) => j.name === name);
const axis = (m: mat4, c: number) => vec3.fromValues(m[c * 4], m[c * 4 + 1], m[c * 4 + 2]);
const pos = (m: ArrayLike<number>) => vec3.fromValues(m[12], m[13], m[14]);

describe('hand skeleton (Vision 21 -> WebXR 25)', () => {
  it('lists the 25 WebXR joints in XRHand order', () => {
    expect(JOINTS.map((j) => j.name)).toEqual(Object.values(XRHandJoint));
  });

  it('maps positions: thumb 1:1, finger MCP..tip to proximal..tip, metacarpals interpolated', () => {
    const { poses } = buildSkeleton(open, 'right');
    const expectAt = (name: string, p: vec3) => expect(vec3.distance(pos(poses[jointIndex(name)]), p)).toBeLessThan(1e-6);
    expectAt('wrist', at(open, 0));
    expectAt('thumb-metacarpal', at(open, 1));
    expectAt('thumb-tip', at(open, 4));
    expectAt('index-finger-phalanx-proximal', at(open, 5));
    expectAt('index-finger-tip', at(open, 8));
    expectAt('pinky-finger-phalanx-distal', at(open, 19));
    expectAt('middle-finger-metacarpal', vec3.lerp(vec3.create(), at(open, 0), at(open, 9), METACARPAL_T));
  });

  it('orients joints: -Z along the bone to the tip, +Y out of the back of the hand, right-handed', () => {
    // mock right hand: fingers up (+Y), back of the hand facing the camera (+Z)
    const { poses } = buildSkeleton(open, 'right');
    const proximal = poses[jointIndex('index-finger-phalanx-proximal')];
    const bone = vec3.normalize(vec3.create(), vec3.subtract(vec3.create(), at(open, 6), at(open, 5)));
    expect(vec3.dot(vec3.negate(vec3.create(), axis(proximal, 2)), bone)).toBeCloseTo(1, 5);
    expect(axis(proximal, 1)[2]).toBeGreaterThan(0.99);
    for (const m of poses) {
      const [x, y, z] = [axis(m, 0), axis(m, 1), axis(m, 2)];
      expect(vec3.dot(x, y)).toBeCloseTo(0, 5);
      expect(vec3.dot(y, z)).toBeCloseTo(0, 5);
      expect(vec3.dot(vec3.cross(vec3.create(), x, y), z)).toBeCloseTo(1, 5); // det = +1
    }
    // tips continue the last bone
    const tip = poses[jointIndex('index-finger-tip')];
    const lastBone = vec3.normalize(vec3.create(), vec3.subtract(vec3.create(), at(open, 8), at(open, 7)));
    expect(vec3.dot(vec3.negate(vec3.create(), axis(tip, 2)), lastBone)).toBeCloseTo(1, 5);
  });

  it('keeps +Y dorsal for a mirrored left hand', () => {
    const left = open.map((v, i) => (i % 3 === 0 ? -v : v)); // mirror x: left hand, back still facing +Z
    const { poses } = buildSkeleton(left, 'left');
    expect(axis(poses[jointIndex('middle-finger-phalanx-proximal')], 1)[2]).toBeGreaterThan(0.99);
  });

  it('detects pinch with hysteresis and rejects incomplete hands', () => {
    expect(pinchState(open, false)).toBe(false);
    expect(pinchState(pinched, false)).toBe(true);
    const mid = mockHandCameraSpace(0.66).flat(); // thumb-index ~2.8 cm apart
    const d = vec3.distance(at(mid, 4), at(mid, 8));
    expect(d).toBeGreaterThan(0.02);
    expect(d).toBeLessThan(0.035);
    expect(pinchState(mid, true)).toBe(true);
    expect(pinchState(mid, false)).toBe(false);
    expect(isCompleteHand(open)).toBe(true);
    expect(isCompleteHand([...open.slice(0, 60), NaN, 0, 0])).toBe(false);
  });
});

// ---- integration through a real IWER session ----
type Msg = Record<string, unknown> & { type: string };
interface Space { jointName?: string }
interface Source { handedness: string; hand: Map<string, Space> | null; targetRaySpace: unknown }
interface Frame {
  getJointPose(joint: Space, base: unknown): { transform: { matrix: Float32Array }; radius: number } | null;
  fillPoses(spaces: Space[], base: unknown, out: Float32Array): boolean;
  fillJointRadii(spaces: Space[], out: Float32Array): boolean;
}
interface Session {
  inputSources: Source[];
  updateRenderState(s: Record<string, unknown>): void;
  requestReferenceSpace(t: string): Promise<unknown>;
  requestAnimationFrame(cb: (t: number, f: Frame) => void): number;
  addEventListener(t: string, cb: (e: Event & { inputSource?: Source }) => void): void;
  end(): Promise<void>;
}
let hw: HoloWebGlobal;
const identity = mat4.create();
const xr = () => (navigator as unknown as { xr: { requestSession(m: string, i?: object): Promise<Session> } }).xr;
const inFrame = <T>(s: Session, fn: (f: Frame) => T = () => undefined as T) =>
  new Promise<T>((resolve, reject) =>
    s.requestAnimationFrame((_t, f) => {
      try {
        resolve(fn(f));
      } catch (e) {
        reject(e);
      }
    }),
  );
const frame0 = () => hw.onFrame(performance.now(), 'mono', Array.from(identity), Array.from(identity), Array.from(mat4.perspective(mat4.create(), 1, 2, 0.01, 100)), null, 'normal');
const sendHand = (p: 'open' | 'pinched') => hw.onHands([mockHand(identity, p === 'open' ? 1200 : 400)]);

async function start(features: string[]): Promise<{ session: Session; local: unknown }> {
  const session = await xr().requestSession('immersive-ar', { optionalFeatures: features });
  session.updateRenderState({ layers: [{}] });
  frame0();
  const local = await session.requestReferenceSpace('local');
  await inFrame(session);
  return { session, local };
}

beforeAll(async () => {
  (globalThis as Record<string, unknown>).WebGL2RenderingContext = class {};
  (globalThis as Record<string, unknown>).webkit = {
    messageHandlers: { holoweb: { postMessage: (m: Msg) => Promise.resolve(m.type === 'requestSession' ? { ok: true, mode: 'mono' } : { ok: true }) } },
  };
  await import('../src/index.js');
  hw = (globalThis as unknown as { __holoweb: HoloWebGlobal }).__holoweb;
});

describe('WebXR Hand Input over native hands', () => {
  it('exposes a tracked right hand with 25 joint poses, fillPoses and fillJointRadii', async () => {
    const { session, local } = await start(['hand-tracking']);
    try {
    const changes: string[] = [];
    session.addEventListener('inputsourceschange', (e) => changes.push(`+${(e as unknown as { added: Source[] }).added.map((s) => s.handedness)}`));
    sendHand('open');
    await inFrame(session);
    const source = session.inputSources.find((s) => s.hand);
    expect(source?.handedness).toBe('right');
    expect(source?.hand?.size).toBe(25);
    expect(changes).toEqual(['+right']);

    const result = await inFrame(session, (f) => {
      const tip = f.getJointPose(source!.hand!.get('index-finger-tip')!, local)!;
      const joints = [...source!.hand!.values()];
      const poses = new Float32Array(16 * 25);
      const radii = new Float32Array(25);
      return { tip: pos(tip.transform.matrix), radius: tip.radius, filled: f.fillPoses(joints, local, poses) && f.fillJointRadii(joints, radii), poses, radii };
    });
    expect(vec3.distance(result.tip, at(open, 8))).toBeLessThan(1e-5);
    expect(result.radius).toBeCloseTo(0.007, 5);
    expect(result.filled).toBe(true);
    expect(vec3.distance(pos(result.poses.subarray(0, 16)), at(open, 0))).toBeLessThan(1e-5); // wrist
    expect(Array.from(result.radii).every((r) => r > 0)).toBe(true);
    } finally {
      await session.end();
    }
  });

  it('fires selectstart on pinch and select + selectend on release, in order', async () => {
    const { session } = await start(['hand-tracking']);
    try {
    const events: string[] = [];
    for (const t of ['selectstart', 'select', 'selectend']) session.addEventListener(t, (e) => events.push(`${t}:${e.inputSource?.handedness}`));
    sendHand('open');
    await inFrame(session);
    await inFrame(session);
    sendHand('pinched');
    await inFrame(session);
    expect(events).toEqual(['selectstart:right']);
    sendHand('open');
    await inFrame(session);
    expect(events).toEqual(['selectstart:right', 'select:right', 'selectend:right']);
    } finally {
      await session.end();
    }
  });

  it('drops a hand LOST_MS (500 ms) after the last update (selectend only if pinching)', async () => {
    const { session } = await start(['hand-tracking']);
    try {
    const events: string[] = [];
    session.addEventListener('selectend', () => events.push('selectend'));
    session.addEventListener('select', () => events.push('select'));
    sendHand('open');
    await inFrame(session);
    await inFrame(session);
    sendHand('pinched');
    await inFrame(session);
    await new Promise((r) => setTimeout(r, LOST_MS + 50));
    await inFrame(session);
    await inFrame(session);
    expect(session.inputSources.some((s) => s.hand)).toBe(false);
    expect(events).toEqual(['selectend']);
    } finally {
      await session.end();
    }
  });

  it('gives no hand input sources to sessions without hand-tracking', async () => {
    const { session } = await start([]);
    try {
      sendHand('open');
      await inFrame(session);
      await inFrame(session);
      expect(session.inputSources.some((s) => s.hand)).toBe(false);
    } finally {
      await session.end();
    }
  });
});
