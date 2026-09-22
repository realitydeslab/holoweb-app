/**
 * WebXR Lighting Estimation from ARKit's basic light estimate.
 *
 * Input (onFrame `light`): ambientIntensity in lux (ARKit: 1000 = neutral lighting) and
 * ambientColorTemperature in kelvin (6500 = neutral white).
 *
 * Conversion (documented, not measured):
 * - brightness k = ambientIntensity / 1000
 * - tint = kelvinToRgb(K), normalised to unit Rec.709 luminance, so k carries brightness
 * - the estimate is split between an ambient and a directional term so that an upward-facing
 *   white Lambertian surface reflects radiance k * tint in total under three.js' model
 *   (ambient radiance L contributes L; a directional light of intensity I contributes I / pi):
 *     sphericalHarmonicsCoefficients: L0 only, c0 = AMBIENT_SHARE * k * tint * 2 * sqrt(pi)
 *       (projection of constant radiance onto Y00; L1/L2 are zero, ARKit has no direction)
 *     primaryLightIntensity = (1 - AMBIENT_SHARE) * pi * k * tint, from straight above
 *     primaryLightDirection = (0, 1, 0) (towards the light)
 */
import { P_DEVICE, P_FRAME, P_SESSION, XRFrame, XRSession, XRSpace } from 'iwer';
import type { LightEstimate } from './bridge.js';

export const NEUTRAL_LUX = 1000;
export const AMBIENT_SHARE = 0.5;
const SH_Y00_PROJECTION = 2 * Math.sqrt(Math.PI);

/** Kelvin to linear-ish RGB in [0, 1] (Tanner Helland's fit of blackbody colours, 1000-40000 K). */
export function kelvinToRgb(kelvin: number): [number, number, number] {
  const t = Math.min(40000, Math.max(1000, kelvin)) / 100;
  const r = t <= 66 ? 255 : 329.698727446 * Math.pow(t - 60, -0.1332047592);
  const g = t <= 66 ? 99.4708025861 * Math.log(t) - 161.1195681661 : 288.1221695283 * Math.pow(t - 60, -0.0755148492);
  const b = t >= 66 ? 255 : t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  const c = (v: number) => Math.min(255, Math.max(0, v)) / 255;
  return [c(r), c(g), c(b)];
}

/** Colour of the estimate with unit luminance (brightness is carried separately). */
export function tintFromKelvin(kelvin: number): [number, number, number] {
  const [r, g, b] = kelvinToRgb(kelvin);
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return luminance > 0 ? [r / luminance, g / luminance, b / luminance] : [1, 1, 1];
}

export interface LightTerms {
  sphericalHarmonicsCoefficients: Float32Array;
  primaryLightIntensity: [number, number, number];
  primaryLightDirection: [number, number, number];
}

export function lightTerms(light: LightEstimate): LightTerms {
  const k = Math.max(0, light.ambientIntensity) / NEUTRAL_LUX;
  const tint = tintFromKelvin(light.ambientColorTemperature || 6500);
  const sh = new Float32Array(27);
  for (let i = 0; i < 3; i++) sh[i] = AMBIENT_SHARE * k * tint[i] * SH_Y00_PROJECTION;
  const primary = tint.map((v) => (1 - AMBIENT_SHARE) * Math.PI * k * v) as [number, number, number];
  return { sphericalHarmonicsCoefficients: sh, primaryLightIntensity: primary, primaryLightDirection: [0, 1, 0] };
}

/** Probes of live sessions, for `reflectionchange` (reflection.ts). */
export const liveProbes = new Set<XRLightProbe>();

export class XRLightProbe extends EventTarget {
  #onreflectionchange: ((e: Event) => void) | null = null;
  constructor(
    readonly session: XRSession,
    readonly probeSpace: XRSpace,
  ) {
    super();
  }

  // Event handler attribute, registered as a listener (same pattern as IWER's XRSession.onend).
  get onreflectionchange(): ((e: Event) => void) | null {
    return this.#onreflectionchange;
  }

  set onreflectionchange(handler: ((e: Event) => void) | null) {
    if (this.#onreflectionchange) this.removeEventListener('reflectionchange', this.#onreflectionchange);
    this.#onreflectionchange = typeof handler === 'function' ? handler : null;
    if (this.#onreflectionchange) this.addEventListener('reflectionchange', this.#onreflectionchange);
  }

  /** Fire `reflectionchange`. */
  notifyReflectionChange(): void {
    this.dispatchEvent(new Event('reflectionchange'));
  }
}

export class XRLightEstimate {
  readonly sphericalHarmonicsCoefficients: Float32Array;
  readonly primaryLightDirection: DOMPointReadOnly;
  readonly primaryLightIntensity: DOMPointReadOnly;
  constructor(terms: LightTerms) {
    this.sphericalHarmonicsCoefficients = terms.sphericalHarmonicsCoefficients;
    const [dx, dy, dz] = terms.primaryLightDirection;
    const [r, g, b] = terms.primaryLightIntensity;
    this.primaryLightDirection = new DOMPointReadOnly(dx, dy, dz, 0);
    this.primaryLightIntensity = new DOMPointReadOnly(r, g, b, 1);
  }
}

let onProbeCreated: ((probe: XRLightProbe) => void) | null = null;
/** Hook for reflection.ts: a probe created after a map arrived still gets `reflectionchange`. */
export function setProbeCreatedHook(hook: (probe: XRLightProbe) => void): void {
  onProbeCreated = hook;
}

/** Install session.requestLightProbe and frame.getLightEstimate over a light source. */
export function installLightEstimation(latestLight: () => LightEstimate | null | undefined): void {
  let cached: { light: LightEstimate; estimate: XRLightEstimate } | null = null;

  Object.defineProperty(XRSession.prototype, 'preferredReflectionFormat', {
    configurable: true,
    get: () => 'srgba8',
  });
  Object.defineProperty(XRSession.prototype, 'requestLightProbe', {
    configurable: true,
    writable: true,
    value: async function (this: XRSession, options: { reflectionFormat?: string } = {}): Promise<XRLightProbe> {
      if (this[P_SESSION].ended) throw new DOMException('XRSession has ended', 'InvalidStateError');
      if (!this.enabledFeatures.includes('light-estimation')) {
        throw new DOMException("The 'light-estimation' feature is not enabled", 'NotSupportedError');
      }
      // Only the preferred format is offered: 8-bit sRGB cube maps.
      if (options.reflectionFormat !== undefined && options.reflectionFormat !== 'srgba8') {
        throw new DOMException(`Reflection format ${options.reflectionFormat} is not supported`, 'NotSupportedError');
      }
      const globalSpace = this[P_SESSION].device[P_DEVICE].globalSpace;
      const probe = new XRLightProbe(this, new XRSpace(globalSpace));
      liveProbes.add(probe);
      this.addEventListener('end', () => liveProbes.delete(probe), { once: true });
      onProbeCreated?.(probe);
      return probe;
    },
  });
  Object.defineProperty(XRFrame.prototype, 'getLightEstimate', {
    configurable: true,
    writable: true,
    value: function (this: XRFrame, probe: XRLightProbe): XRLightEstimate | null {
      if (!this[P_FRAME].active) throw new DOMException('XRFrame is not active', 'InvalidStateError');
      if (!(probe instanceof XRLightProbe) || probe.session !== this[P_FRAME].session) {
        throw new DOMException('Light probe belongs to another session', 'InvalidStateError');
      }
      const light = latestLight();
      if (!light) return null;
      if (!cached || cached.light !== light) cached = { light, estimate: new XRLightEstimate(lightTerms(light)) };
      return cached.estimate;
    },
  });
  const g = globalThis as unknown as Record<string, unknown>;
  g.XRLightProbe = XRLightProbe;
  g.XRLightEstimate = XRLightEstimate;
}
