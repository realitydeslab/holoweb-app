/**
 * WebXR Hit Test for transient input (screen taps), which IWER lacks:
 * session.requestHitTestSourceForTransientInput({ profile, entityTypes?, offsetRay? }) and
 * frame.getHitTestResultsForTransientInput(source) -> [{ inputSource, results: XRHitTestResult[] }].
 * Transient sources are those with targetRayMode 'screen' or 'transient-pointer' (input.ts' touch
 * source, profile 'generic-touchscreen'); results come from the same ARKit-plane raycast as
 * XRHitTestSource (PlaneEnvironment). A-Frame's ar-hit-test uses this API.
 */
import { mat4 } from 'gl-matrix';
import { P_DEVICE, P_FRAME, P_SESSION, XRFrame, XRRay, XRSession, XRSpace } from 'iwer';
import { XRHitTestResult } from 'iwer/lib/hittest/XRHitTest.js';
import { XRSpaceUtils } from 'iwer/lib/spaces/XRSpace.js';
import type { PlaneEnvironment } from './hittest.js';

interface TransientOptions {
  profile: string;
  entityTypes?: string[];
  offsetRay?: XRRay;
}

export class XRTransientInputHitTestSource {
  cancelled = false;
  constructor(
    readonly session: XRSession,
    readonly profile: string,
    readonly offsetRay: XRRay,
  ) {}

  cancel(): void {
    if (this.cancelled) throw new DOMException('Hit test source already cancelled', 'InvalidStateError');
    this.cancelled = true;
  }
}

export class XRTransientInputHitTestResult {
  constructor(
    readonly inputSource: unknown,
    readonly results: readonly XRHitTestResult[],
  ) {}
}

const TRANSIENT_MODES = new Set(['screen', 'transient-pointer']);

export function installTransientHitTest(environment: PlaneEnvironment): void {
  Object.defineProperty(XRSession.prototype, 'requestHitTestSourceForTransientInput', {
    configurable: true,
    writable: true,
    value: async function (this: XRSession, options: TransientOptions): Promise<XRTransientInputHitTestSource> {
      if (this[P_SESSION].ended) throw new DOMException('XRSession has ended', 'InvalidStateError');
      if (!this.enabledFeatures.includes('hit-test')) {
        throw new DOMException("The 'hit-test' feature is not enabled", 'NotSupportedError');
      }
      if (!options || typeof options.profile !== 'string') throw new TypeError('profile is required');
      return new XRTransientInputHitTestSource(this, options.profile, options.offsetRay ?? new XRRay());
    },
  });

  Object.defineProperty(XRFrame.prototype, 'getHitTestResultsForTransientInput', {
    configurable: true,
    writable: true,
    value: function (this: XRFrame, source: XRTransientInputHitTestSource): XRTransientInputHitTestResult[] {
      const state = this[P_FRAME];
      if (!state.active) throw new DOMException('XRFrame is not active', 'InvalidStateError');
      if (!(source instanceof XRTransientInputHitTestSource) || source.session !== state.session || source.cancelled) {
        throw new DOMException('Invalid transient hit test source', 'InvalidStateError');
      }
      const session: XRSession = state.session;
      const globalSpace = session[P_SESSION].device[P_DEVICE].globalSpace;
      const out: XRTransientInputHitTestResult[] = [];
      for (const input of session.inputSources) {
        if (!TRANSIENT_MODES.has(input.targetRayMode)) continue;
        if (source.profile !== '' && !input.profiles.includes(source.profile)) continue;
        const ray = mat4.multiply(mat4.create(), XRSpaceUtils.calculateGlobalOffsetMatrix(input.targetRaySpace), source.offsetRay.matrix);
        const results = environment
          .computeHitTestResults(ray)
          .map((m) => new XRHitTestResult(this, new XRSpace(globalSpace, m)));
        out.push(new XRTransientInputHitTestResult(input, results));
      }
      return out;
    },
  });

  const g = globalThis as unknown as Record<string, unknown>;
  g.XRTransientInputHitTestSource = XRTransientInputHitTestSource;
  g.XRTransientInputHitTestResult = XRTransientInputHitTestResult;
}
