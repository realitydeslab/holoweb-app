// @vitest-environment happy-dom
// G10: One Euro joint smoothing on the native clock, grab -> squeeze events, pinch suppressed by a
// grab, grip at the palm centre.
import { mat4, vec3 } from 'gl-matrix';
import { beforeAll, describe, expect, it } from 'vitest';
import { curlRatio, palmCenter, pinchState, SQUEEZE_OFF, SQUEEZE_ON, squeezeState } from '../src/hands.js';
import type { HoloWebGlobal } from '../src/index.js';
import { mockHandCameraSpace } from '../src/mock-hands.js';
import { HAND_FILTER, OneEuro3 } from '../src/one-euro.js';

const open = mockHandCameraSpace(0).flat();
const pinched = mockHandCameraSpace(1).flat();
const at = (pts: ArrayLike<number>, i: number) => vec3.fromValues(pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2]);

/** Fingers curled by g in [0, 1] (tips, DIPs, PIPs folded onto the knuckles); thumb tip on the index tip. */
function fist(g: number): number[] {
  const pts = pinched.slice();
  for (const mcp of [5, 9, 13, 17]) {
    const k = at(pts, mcp);
    for (let j = mcp + 1; j <= mcp + 3; j++) {
      const target = vec3.add(vec3.create(), k, [0, 0, -0.02]);
      const p = vec3.lerp(vec3.create(), at(pts, j), target, g);
      pts.splice(j * 3, 3, p[0], p[1], p[2]);
    }
  }
  pts.splice(12, 3, pts[24], pts[25], pts[26]); // thumb tip (4) = index tip (8)
  return pts;
}

describe('One Euro filter', () => {
  it('passes the first sample, converges on a step, and follows fast motion with little lag', () => {
    const f = new OneEuro3();
    expect(f.filter([1, 2, 3], 0.033, HAND_FILTER)).toEqual([1, 2, 3]);
    const out: number[] = [];
    for (let i = 0; i < 60; i++) out.push(f.filter([1.1, 2, 3], 0.033, HAND_FILTER)[0]);
    expect(out[0]).toBeGreaterThan(1); // moves at once
    expect(out[0]).toBeLessThan(1.1); // but smoothed
    expect(Math.abs(out[59] - 1.1)).toBeLessThan(1e-3); // settled within 2 s
    f.reset();
    expect(f.filter([5, 5, 5], 0.033, HAND_FILTER)).toEqual([5, 5, 5]);
  });

  it('cuts jitter on a still joint to a fraction', () => {
    const f = new OneEuro3();
    let seed = 7;
    const noise = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 0.01; // +-5 mm
    const raw: number[] = [];
    const smooth: number[] = [];
    for (let i = 0; i < 300; i++) {
      const x = noise();
      raw.push(x);
      smooth.push(f.filter([x, 0, 0], 1 / 30, HAND_FILTER)[0]);
    }
    const rms = (a: number[]) => Math.sqrt(a.slice(30).reduce((s, v) => s + v * v, 0) / (a.length - 30));
    expect(rms(smooth)).toBeLessThan(rms(raw) * 0.5);
  });
});

describe('squeeze (grab) detection', () => {
  it('uses the curl ratio with hysteresis', () => {
    expect(curlRatio(open)).toBeGreaterThan(SQUEEZE_OFF);
    expect(curlRatio(fist(1))).toBeLessThan(SQUEEZE_ON);
    expect(squeezeState(open, false)).toBe(false);
    expect(squeezeState(fist(1), false)).toBe(true);
    const mid = fist(0.55);
    const c = curlRatio(mid);
    expect(c).toBeGreaterThan(SQUEEZE_ON);
    expect(c).toBeLessThan(SQUEEZE_OFF);
    expect(squeezeState(mid, true)).toBe(true);
    expect(squeezeState(mid, false)).toBe(false);
    expect(pinchState(fist(1), false)).toBe(true); // why a grab must suppress the pinch
  });
});

// ---- integration through a real IWER session ----
type Msg = Record<string, unknown> & { type: string };
interface Source { handedness: string; hand: Map<string, unknown> | null; gripSpace: unknown }
interface Frame {
  getPose(space: unknown, base: unknown): { transform: { matrix: Float32Array } } | null;
  getJointPose(joint: unknown, base: unknown): { transform: { matrix: Float32Array } } | null;
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
let clock = 0;
const identity = mat4.create();
const xr = () => (navigator as unknown as { xr: { requestSession(m: string, i?: object): Promise<Session> } }).xr;
const inFrame = <T>(s: Session, fn: (f: Frame) => T = () => undefined as T) =>
  new Promise<T>((resolve, reject) => s.requestAnimationFrame((_t, f) => { try { resolve(fn(f)); } catch (e) { reject(e); } }));
const hand = (joints: number[], handedness = 'right', depthValid = (1 << 21) - 1) =>
  ({ handedness, joints, confidence: new Array(21).fill(0.9), depthValid });
/** One native update, 33 ms (Vision rate) after the previous one. */
const send = (...hands: ReturnType<typeof hand>[]) => hw.onHands({ t: (clock += 33), hands } as never);

async function start(): Promise<{ session: Session; local: unknown; events: string[] }> {
  const session = await xr().requestSession('immersive-ar', { optionalFeatures: ['hand-tracking'] });
  session.updateRenderState({ layers: [{}] });
  hw.onFrame(performance.now(), 'mono', Array.from(identity), Array.from(identity), Array.from(mat4.perspective(mat4.create(), 1, 2, 0.01, 100)), null, 'normal');
  const local = await session.requestReferenceSpace('local');
  await inFrame(session);
  const events: string[] = [];
  for (const t of ['selectstart', 'select', 'selectend', 'squeezestart', 'squeeze', 'squeezeend']) session.addEventListener(t, () => events.push(t));
  return { session, local, events };
}

beforeAll(async () => {
  (globalThis as Record<string, unknown>).WebGL2RenderingContext = class {};
  (globalThis as Record<string, unknown>).webkit = {
    messageHandlers: { holoweb: { postMessage: (m: Msg) => Promise.resolve(m.type === 'requestSession' ? { ok: true, mode: 'mono' } : { ok: true }) } },
  };
  await import('../src/index.js');
  hw = (globalThis as unknown as { __holoweb: HoloWebGlobal }).__holoweb;
});

describe('hand gestures and smoothing in a session', () => {
  it('fires squeezestart on a grab and squeeze + squeezeend on release', async () => {
    const { session, events } = await start();
    try {
      send(hand(open));
      await inFrame(session);
      await inFrame(session);
      send(hand(fist(1)));
      await inFrame(session);
      expect(events).toEqual(['squeezestart']); // thumb on index inside the fist: no selectstart
      send(hand(open));
      await inFrame(session);
      expect(events).toEqual(['squeezestart', 'squeeze', 'squeezeend']);
    } finally {
      await session.end();
    }
  });

  it('cancels an active pinch when the hand closes into a grab (selectend without select)', async () => {
    const { session, events } = await start();
    try {
      send(hand(open));
      await inFrame(session);
      await inFrame(session);
      send(hand(pinched));
      await inFrame(session);
      send(hand(fist(1)));
      await inFrame(session);
      expect(events).toEqual(['selectstart', 'selectend', 'squeezestart']);
      send(hand(open));
      await inFrame(session);
      expect(events).toEqual(['selectstart', 'selectend', 'squeezestart', 'squeeze', 'squeezeend']);
    } finally {
      await session.end();
    }
  });

  it('smooths joints on the native clock, harder where depth was inferred; grip at the palm centre', async () => {
    const { session, local } = await start();
    try {
      send(hand(open, 'right'), hand(open, 'left', 0));
      await inFrame(session);
      const shifted = open.map((v, i) => (i % 3 === 0 ? v + 0.02 : v)); // whole hand 2 cm to the right
      send(hand(shifted, 'right'), hand(shifted, 'left', 0));
      const moved = await inFrame(session, (f) => {
        const wristX = (h: string) => {
          const s = session.inputSources.find((x) => x.handedness === h && x.hand)!;
          return f.getJointPose(s.hand!.get('wrist'), local)!.transform.matrix[12] - open[0];
        };
        const right = session.inputSources.find((x) => x.handedness === 'right' && x.hand)!;
        return { right: wristX('right'), left: wristX('left'), grip: f.getPose(right.gripSpace, local)!.transform.matrix };
      });
      expect(moved.right).toBeGreaterThan(0.002);
      expect(moved.right).toBeLessThan(0.02); // lags the raw 2 cm step
      expect(moved.left).toBeLessThan(moved.right); // inferred depth: smoother
      // grip sits on the (smoothed) palm centre: the palm of the unshifted hand moved by the same filtered step
      const palm = palmCenter(open);
      expect(moved.grip[12] - palm[0]).toBeCloseTo(moved.right, 4);
      expect(moved.grip[13]).toBeCloseTo(palm[1], 4);
      expect(moved.grip[14]).toBeCloseTo(palm[2], 4);
    } finally {
      await session.end();
    }
  });

  it('accepts the legacy bare-array onHands form', async () => {
    const { session } = await start();
    try {
      hw.onHands([hand(open)] as never);
      await inFrame(session);
      expect(session.inputSources.some((s) => s.hand)).toBe(true);
    } finally {
      await session.end();
    }
  });
});
