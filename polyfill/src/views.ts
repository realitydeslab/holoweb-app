/**
 * View-count policy for mid-session mono <-> stereo switches.
 *
 * Engines size per-view state from the views they have seen and do not always shrink it:
 * three.js <= r111 WebXRManager renders a fixed ArrayCamera [cameraL, cameraR] and only updates
 * cameras[i] for i < views.length, so after stereo -> mono cameraR keeps rendering the stale
 * right eye. three.js r186's WebGPU backend caches one colour attachment per camera from the
 * first frames (see gpu-binding.ts). So within a session the reported view count never drops
 * below the maximum the page has seen:
 *
 * - mono after stereo: views = [mono view, inert 'right' view]
 * - mono in an XRGPUBinding session not yet primed: the same, for a few frames
 * - a session that has only ever been mono: one view
 *
 * The inert view has the mono pose (so three's union frustum equals the mono frustum), a 0x0
 * viewport (XRWebGLLayer.getViewport via nativeViewports.right, XRGPUSubImage.viewport in
 * gpu-binding.ts), so pages that skip empty viewports skip it, and a projection pushed far
 * below the viewport, so it rasterises nothing in engines that draw it anyway. Presenters ignore it.
 */
import { P_FRAME, XRFrame, XRSession, XRView, XRViewerPose } from 'iwer';
import { XREye } from 'iwer/lib/views/XRView.js';

/** Vertical off-centre term of the inert view: every vertex in front lands at y_ndc ~ -1e4. */
export const INERT_OFFSET = 1e4;
/** Viewport of the inert view (framebuffer pixels). */
export const INERT_VIEWPORT = Object.freeze({ x: 0, y: 0, width: 0, height: 0 });

const maxRealViews = new WeakMap<XRSession, number>();

export function inertView(base: XRView, session: XRSession): XRView {
  const projection = new Float32Array(base.projectionMatrix);
  projection[9] = INERT_OFFSET;
  return new XRView(XREye.Right, projection, base.transform, session);
}

/** Largest number of real (non-inert) views reported to the page in this session. */
export function maxViewsSeen(session: XRSession): number {
  return maxRealViews.get(session) ?? 0;
}

/**
 * Wrap XRFrame.getViewerPose. `extraReason(session)` can request the inert view for other
 * reasons (XRGPUBinding priming).
 */
export function installViewCountPolicy(extraReason: (session: XRSession) => boolean): void {
  // WebXR AR Module: HoloWeb has no secondary (observer) views.
  Object.defineProperty(XRView.prototype, 'isFirstPersonObserver', { configurable: true, get: () => false });
  const getViewerPose = XRFrame.prototype.getViewerPose;
  XRFrame.prototype.getViewerPose = function (this: XRFrame, referenceSpace) {
    const pose = getViewerPose.call(this, referenceSpace);
    if (!pose) return pose;
    const session = this[P_FRAME].session;
    const real = pose.views.length;
    const seen = Math.max(maxViewsSeen(session), real);
    maxRealViews.set(session, seen);
    if (real !== 1 || (seen < 2 && !extraReason(session))) return pose;
    const views = [pose.views[0], inertView(pose.views[0], session)];
    return new XRViewerPose(pose.transform, views, pose.emulatedPosition);
  };
}
