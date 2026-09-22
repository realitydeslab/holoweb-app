import { mat4 } from 'gl-matrix';
import { describe, expect, it } from 'vitest';
import { lookupPhone, PHONES } from '../src/phones.js';
import { applyDepthRange, computeStereo, HOLOKIT_X } from '../src/stereo.js';

// Golden values for iPhone14,2 (ScreenDpi 460, CameraOffset (0.042005,-0.05809,-0.00727),
// ScreenBottomBorder 0.00347, runtime screen 2532x1170), ipd 0.064, near 0.06395, far 1000.
// Computed independently from HoloKitCameraManager.SetupCameraData (Python transcription,
// see plan/notes.md "Polyfill execution log").
const GOLDEN = {
  P00: 2.1900684931506853,
  P11: 2.6802179379715008,
  P22: -1.000127908179728,
  P23: -0.12790817972809362,
  P02_ipd070: 0.10273972602739723,
  left: { x: 158, y: 47, width: 1058, height: 864 },
  right: { x: 1317, y: 47, width: 1058, height: 864 },
  cameraToCenterEye: [0.042005, -0.08703, 0.07782],
};

const iphone13Pro = lookupPhone('iPhone14,2').phone;
const screen = { w: 2532, h: 1170, scale: 3 };
const NEAR = 0.06395;
const FAR = 1000;

// Unity P[r,c] -> column-major index
const at = (m: Float32Array, r: number, c: number) => m[c * 4 + r];

describe('computeStereo (HoloKit X, iPhone14,2)', () => {
  const s = computeStereo(iphone13Pro, screen, 0.064, NEAR, FAR);

  it('uses LensToEye 0.06395 as the frustum near plane', () => {
    expect(HOLOKIT_X.lensToEye).toBeCloseTo(NEAR, 10);
  });

  it('matches the Unity projection entries [0,0], [1,1], [0,2], [2,2], [2,3], [3,2]', () => {
    for (const eye of [s.left, s.right]) {
      const p = eye.projection;
      expect(at(p, 0, 0)).toBeCloseTo(GOLDEN.P00, 5);
      expect(at(p, 1, 1)).toBeCloseTo(GOLDEN.P11, 5);
      expect(at(p, 0, 2)).toBeCloseTo(0, 6); // eyes on the optical axes at ipd 0.064
      expect(at(p, 2, 2)).toBeCloseTo(GOLDEN.P22, 6);
      expect(at(p, 2, 3)).toBeCloseTo(GOLDEN.P23, 6);
      expect(at(p, 3, 2)).toBe(-1);
      expect(at(p, 3, 3)).toBe(0);
      expect(at(p, 1, 2)).toBe(0);
    }
  });

  it('flips the sign of [0,2] for the right eye', () => {
    const wide = computeStereo(iphone13Pro, screen, 0.07, NEAR, FAR);
    expect(at(wide.left.projection, 0, 2)).toBeCloseTo(GOLDEN.P02_ipd070, 5);
    expect(at(wide.right.projection, 0, 2)).toBeCloseTo(-GOLDEN.P02_ipd070, 5);
    // viewports are fixed by the optics, not by the IPD
    expect(wide.left.viewport).toEqual(GOLDEN.left);
  });

  it('produces the Unity viewport rects in framebuffer pixels', () => {
    expect(s.left.viewport).toEqual(GOLDEN.left);
    expect(s.right.viewport).toEqual(GOLDEN.right);
    // symmetric about the screen centre
    expect(s.left.viewport.x + s.right.viewport.x + s.right.viewport.width).toBeCloseTo(screen.w, -1);
  });

  it('accepts portrait-ordered screen sizes', () => {
    const p = computeStereo(iphone13Pro, { w: 1170, h: 2532, scale: 3 }, 0.064, NEAR, FAR);
    expect(p.left.viewport).toEqual(GOLDEN.left);
  });

  it('converts CameraOffset + MrOffset to WebXR camera space (z towards the user)', () => {
    s.cameraToCenterEye.forEach((v, i) => expect(v).toBeCloseTo(GOLDEN.cameraToCenterEye[i], 9));
  });

  it('uses the asset ScreenResolution when present (iPhone16,1)', () => {
    const phone = lookupPhone('iPhone16,1').phone;
    const fromAsset = computeStereo(phone, { w: 2556, h: 1179, scale: 3 }, 0.064, NEAR, FAR);
    // same physical screen size, half the framebuffer: rects scale, metres do not
    const half = computeStereo(phone, { w: 1278, h: 589.5, scale: 1.5 }, 0.064, NEAR, FAR);
    expect(half.left.viewport.width).toBeCloseTo(fromAsset.left.viewport.width / 2, -1);
  });
});

describe('applyDepthRange (mono [10]/[14] rewrite)', () => {
  it('turns an ARKit-style projection into mat4.perspective with the session depth range', () => {
    const fovy = 1.1;
    const aspect = 0.46;
    const arkit = mat4.perspective(new Float32Array(16), fovy, aspect, 0.01, 1000) as Float32Array;
    const rewritten = applyDepthRange(new Float32Array(arkit), 0.1, 20);
    const expected = mat4.perspective(new Float32Array(16), fovy, aspect, 0.1, 20) as Float32Array;
    for (let i = 0; i < 16; i++) expect(rewritten[i]).toBeCloseTo(expected[i], 6);
  });

  it('keeps off-centre terms of the native projection', () => {
    const off = new Float32Array(16);
    off.set([1.5, 0, 0, 0, 0, 3.2, 0, 0, 0.02, -0.01, -1, -1, 0, 0, -0.02, 0]);
    const out = applyDepthRange(new Float32Array(off), 0.05, 100);
    expect(out[8]).toBeCloseTo(0.02, 6);
    expect(out[9]).toBeCloseTo(-0.01, 6);
    expect(out[10]).toBeCloseTo(-(100 + 0.05) / (100 - 0.05), 6);
    expect(out[14]).toBeCloseTo((-2 * 100 * 0.05) / (100 - 0.05), 6);
  });

  it('supports an infinite far plane', () => {
    const out = applyDepthRange(new Float32Array(16), 0.1, Infinity);
    expect(out[10]).toBe(-1);
    expect(out[14]).toBeCloseTo(-0.2, 6);
  });
});

describe('lookupPhone', () => {
  it('finds the test devices exactly', () => {
    expect(lookupPhone('iPhone16,1').match).toBe('exact');
    expect(lookupPhone('iPhone17,1').phone.description).toBe('iPhone 16 Pro');
  });

  it('falls back to the nearest screen size, then to the SDK default', () => {
    const near = lookupPhone('iPhone99,9', { w: 1206, h: 2622 });
    expect(near.match).toBe('nearest');
    expect(near.phone.identifier).toBe('iPhone17,1');
    expect(lookupPhone(undefined).phone.identifier).toBe('iPhone14,2');
  });

  it('has 24 entries ported from the asset', () => {
    expect(PHONES).toHaveLength(24);
  });
});
