/**
 * Screen-tap input: a transient XRInputSource per touch, as handheld AR browsers do.
 *
 * Mono: targetRayMode 'screen', ray from the camera through the touched pixel.
 * Stereo (HoloKit): targetRayMode 'gaze', ray straight ahead from the centre eye.
 *
 * Sequence (one event per XR frame, dispatched in IWER's onFrameStart so the frame is active):
 *   pointerdown -> source appears; IWER emits inputsourceschange (added) after onFrameStart
 *   next frame  -> selectstart (the page already knows the source)
 *   pointerup   -> select, selectend, source removed (inputsourceschange removed)
 */
import { mat4, quat, vec3, vec4 } from 'gl-matrix';
import { P_DEVICE, P_SESSION, P_SPACE, XRDevice, XRInputSource, XRInputSourceEvent, XRSession, XRSessionEvent, XRSpace } from 'iwer';
import { XRHandedness, XRTargetRayMode } from 'iwer/lib/input/XRInputSource.js';
import { XREye } from 'iwer/lib/views/XRView.js';
import { isVisible } from './visibility.js';

type Phase = 'new' | 'announced' | 'pressed';

interface Touch {
  source: XRInputSource;
  phase: Phase;
  releasePending: boolean;
  ndc: [number, number];
}

const FORWARD = vec3.fromValues(0, 0, -1);

/** Ray (origin + rotation) in viewer space through an NDC point of a projection. */
export function screenRayMatrix(projection: ArrayLike<number>, ndcX: number, ndcY: number): mat4 {
  const inv = mat4.invert(mat4.create(), projection as unknown as mat4);
  if (!inv) return mat4.create();
  const unproject = (z: number): vec3 => {
    const p = vec4.transformMat4(vec4.create(), vec4.fromValues(ndcX, ndcY, z, 1), inv);
    return vec3.fromValues(p[0] / p[3], p[1] / p[3], p[2] / p[3]);
  };
  const near = unproject(-1);
  const dir = vec3.normalize(vec3.create(), vec3.subtract(vec3.create(), unproject(1), near));
  const rotation = quat.rotationTo(quat.create(), FORWARD, dir);
  return mat4.fromRotationTranslation(mat4.create(), rotation, near);
}

export class ScreenInput {
  private touch: Touch | null = null;
  private session: XRSession | null = null;
  private overlayRoot: Element | null = null;

  constructor(private readonly device: XRDevice) {
    const proto = Object.getOwnPropertyDescriptor(XRDevice.prototype, 'inputSources');
    const baseGetter = proto?.get;
    Object.defineProperty(device, 'inputSources', {
      configurable: true,
      get: () => {
        const base: XRInputSource[] = baseGetter ? baseGetter.call(device) : [];
        return this.touch ? [...base, this.touch.source] : base;
      },
    });
    const state = device[P_DEVICE];
    const frameStart = state.onFrameStart;
    state.onFrameStart = (frame) => {
      frameStart(frame);
      this.onFrameStart(frame);
    };
  }

  attach(session: XRSession, overlayRoot: Element | null): void {
    this.session = session;
    this.overlayRoot = overlayRoot;
    window.addEventListener('pointerdown', this.onDown, true);
    window.addEventListener('pointerup', this.onUp, true);
    window.addEventListener('pointercancel', this.onUp, true);
  }

  detach(): void {
    window.removeEventListener('pointerdown', this.onDown, true);
    window.removeEventListener('pointerup', this.onUp, true);
    window.removeEventListener('pointercancel', this.onUp, true);
    this.session = null;
    this.touch = null;
  }

  private readonly onDown = (e: PointerEvent): void => {
    if (!this.session || this.touch || !isVisible(this.device)) return;
    // DOM Overlays: a touch on overlay content is XR input unless the page cancels `beforexrselect`.
    if (this.overlayRoot && e.target instanceof Node && this.overlayRoot.contains(e.target)) {
      const event = new XRSessionEvent('beforexrselect', { session: this.session, bubbles: true, cancelable: true });
      e.target.dispatchEvent(event);
      if (event.defaultPrevented) return;
    }
    const ndc: [number, number] = [(e.clientX / innerWidth) * 2 - 1, 1 - (e.clientY / innerHeight) * 2];
    const stereo = this.device.stereoEnabled;
    const space = new XRSpace(this.device.viewerSpace);
    const source = new XRInputSource(
      XRHandedness.None,
      stereo ? XRTargetRayMode.Gaze : XRTargetRayMode.Screen,
      stereo ? [] : ['generic-touchscreen'],
      space,
    );
    this.touch = { source, phase: 'new', releasePending: false, ndc };
    this.updateRay(this.touch);
  };

  private readonly onUp = (): void => {
    if (this.touch) this.touch.releasePending = true;
  };

  private updateRay(touch: Touch): void {
    const space = touch.source.targetRaySpace;
    const session = this.session;
    if (!session || this.device.stereoEnabled) {
      mat4.identity(space[P_SPACE].offsetMatrix);
      return;
    }
    const projection = session[P_SESSION].getProjectionMatrix(XREye.None);
    mat4.copy(space[P_SPACE].offsetMatrix, screenRayMatrix(projection, touch.ndc[0], touch.ndc[1]));
  }

  private onFrameStart(frame: Parameters<XRDevice[typeof P_DEVICE]['onFrameStart']>[0]): void {
    const touch = this.touch;
    const session = this.session;
    if (!touch || !session || frame.session !== session) return;
    const fire = (type: string) =>
      session.dispatchEvent(new XRInputSourceEvent(type, { frame, inputSource: touch.source }));
    if (!isVisible(this.device)) {
      // blurred / hidden: the press ends without a select, and the source goes away
      if (touch.phase === 'pressed') fire('selectend');
      this.touch = null;
      return;
    }
    this.updateRay(touch);
    if (touch.phase === 'new') {
      touch.phase = 'announced';
      return;
    }
    if (touch.phase === 'announced') {
      touch.phase = 'pressed';
      fire('selectstart');
    }
    if (touch.releasePending && touch.phase === 'pressed') {
      fire('select');
      fire('selectend');
      this.touch = null;
    }
  }
}
