// @vitest-environment happy-dom
import { mat4 } from 'gl-matrix';
import { GlobalSpace, P_SPACE, XRReferenceSpace } from 'iwer';
import { XRReferenceSpaceType } from 'iwer/lib/spaces/XRReferenceSpace.js';
import { describe, expect, it } from 'vitest';
import { DEFAULT_FLOOR_OFFSET, FloorTracker, lowestFloorPlane } from '../src/floor.js';
import type { NativePlaneData } from '../src/hittest.js';
import { AMBIENT_SHARE, kelvinToRgb, lightTerms, tintFromKelvin } from '../src/light.js';

describe('Kelvin -> RGB', () => {
  it('is near white at 6500 K and warm at 2700 K, cool at 10000 K', () => {
    const [r, g, b] = kelvinToRgb(6500);
    expect(r).toBeCloseTo(1, 2);
    expect(g).toBeCloseTo(0.996, 2);
    expect(b).toBeCloseTo(0.98, 2);
    const warm = kelvinToRgb(2700);
    expect(warm[0]).toBeGreaterThan(warm[2] + 0.3);
    const cool = kelvinToRgb(10000);
    expect(cool[2]).toBeGreaterThan(cool[0]);
  });

  it('normalises the tint to unit luminance', () => {
    for (const k of [2000, 4000, 6500, 9000]) {
      const [r, g, b] = tintFromKelvin(k);
      expect(0.2126 * r + 0.7152 * g + 0.0722 * b).toBeCloseTo(1, 6);
    }
  });
});

describe('lightTerms (ARKit ambient -> WebXR light estimate)', () => {
  it('maps 1000 lux at 6500 K to neutral L0 SH + directional light from above', () => {
    const t = lightTerms({ ambientIntensity: 1000, ambientColorTemperature: 6500 });
    const tint = tintFromKelvin(6500);
    const c0 = AMBIENT_SHARE * 2 * Math.sqrt(Math.PI);
    for (let i = 0; i < 3; i++) {
      expect(t.sphericalHarmonicsCoefficients[i]).toBeCloseTo(c0 * tint[i], 5);
      expect(t.primaryLightIntensity[i]).toBeCloseTo((1 - AMBIENT_SHARE) * Math.PI * tint[i], 5);
    }
    expect(Array.from(t.sphericalHarmonicsCoefficients.slice(3)).every((v) => v === 0)).toBe(true);
    expect(t.primaryLightDirection).toEqual([0, 1, 0]);
    // Upward-facing white Lambertian surface: ambient L (SH c0 / 2sqrt(pi)) + directional I / pi = k * tint
    const reflected = t.sphericalHarmonicsCoefficients[1] / (2 * Math.sqrt(Math.PI)) + t.primaryLightIntensity[1] / Math.PI;
    expect(reflected).toBeCloseTo(tint[1], 5);
  });

  it('scales linearly with lux and clamps negative input', () => {
    const a = lightTerms({ ambientIntensity: 500, ambientColorTemperature: 6500 });
    const b = lightTerms({ ambientIntensity: 2000, ambientColorTemperature: 6500 });
    expect(b.sphericalHarmonicsCoefficients[0] / a.sphericalHarmonicsCoefficients[0]).toBeCloseTo(4, 5);
    expect(lightTerms({ ambientIntensity: -5, ambientColorTemperature: 6500 }).primaryLightIntensity).toEqual([0, 0, 0]);
  });
});

const plane = (id: number, y: number, orientation: 'horizontal' | 'vertical' = 'horizontal'): NativePlaneData => ({
  id,
  transform: Array.from(mat4.fromTranslation(mat4.create(), [0, y, -1])),
  extent: [1, 1],
  orientation,
});

function floorSpace(): XRReferenceSpace {
  return new XRReferenceSpace(XRReferenceSpaceType.LocalFloor, new GlobalSpace());
}

describe('FloorTracker (local-floor reset)', () => {
  it('uses the lowest horizontal plane below the origin', () => {
    expect(lowestFloorPlane([plane(1, -0.7), plane(2, -1.1), plane(3, -2, 'vertical'), plane(4, 0.4)])).toBeCloseTo(-1.1, 6);
    expect(lowestFloorPlane([])).toBeUndefined();
  });

  it('starts 1.3 m down, then moves to the first floor plane with a reset event', () => {
    const tracker = new FloorTracker();
    const space = floorSpace();
    tracker.track(space);
    expect(space[P_SPACE].offsetMatrix[13]).toBeCloseTo(-DEFAULT_FLOOR_OFFSET, 6);
    const resets: { y: number }[] = [];
    space.addEventListener('reset', (e) => {
      const t = (e as unknown as { transform: { position: DOMPointReadOnly } }).transform;
      resets.push({ y: t.position.y });
    });
    expect(tracker.update([plane(1, -1.0)])).toBe(true);
    expect(space[P_SPACE].offsetMatrix[13]).toBeCloseTo(-1.0, 6);
    expect(resets).toHaveLength(1);
    expect(resets[0].y).toBeCloseTo(0.3, 6); // new origin is 0.3 m above the old one
  });

  it('ignores changes of 2 cm or less, resets for a lower plane, never moves up again', () => {
    const tracker = new FloorTracker([plane(1, -1.0)]);
    const space = floorSpace();
    tracker.track(space);
    let resets = 0;
    space.addEventListener('reset', () => resets++);
    expect(tracker.update([plane(1, -1.0), plane(2, -1.015)])).toBe(false);
    expect(tracker.update([plane(2, -1.08)])).toBe(true);
    expect(space[P_SPACE].offsetMatrix[13]).toBeCloseTo(-1.08, 6);
    expect(tracker.update([plane(3, -0.5)])).toBe(false); // higher plane / lowest plane lost
    expect(tracker.update([])).toBe(false);
    expect(space[P_SPACE].offsetMatrix[13]).toBeCloseTo(-1.08, 6);
    expect(resets).toBe(1);
  });
});
