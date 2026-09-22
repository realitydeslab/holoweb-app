/**
 * Session lifecycle glue between IWER's XRSystem and the native bridge.
 *
 * - immersive-ar sessions call native `requestSession` (native starts ARKit frames) and
 *   `endSession` when the page or native ends the session, and post `rendered { t }` after each
 *   XR frame. Inline sessions stay JS-only.
 * - Reference spaces follow plan/bridge_protocol.md: `local` = ARKit world origin,
 *   `local-floor` follows FloorTracker (floor.ts), which dispatches `reset` when the floor moves.
 * - While immersive, page content is hidden (as in a real immersive session) except the XR
 *   canvases and the dom-overlay root, and html/body backgrounds are transparent so the native
 *   camera view (mono) or black (stereo) shows through.
 * - dom-overlay: the overlay root is raised above IWER's canvas container.
 * - Native may switch mono <-> stereo at any time (view count 1 <-> 2); sessions keep running.
 *   WebGL pages follow directly; XRGPUBinding sessions rely on the priming view in gpu-binding.ts.
 */
import { mat4 } from 'gl-matrix';
import { P_DEVICE, P_SPACE, XRDevice, XRReferenceSpace, XRSession, XRSystem } from 'iwer';
import type { XRSessionInit, XRSessionMode } from 'iwer/lib/session/XRSession.js';
import type { NativeAnchors } from './anchors.js';
import type { HoloWebBridge } from './bridge.js';
import { addFrameEndListener } from './device.js';
import { FloorTracker } from './floor.js';
import type { ScreenInput } from './input.js';

const OVERLAY_Z_INDEX = '1000';

type SessionOptions = XRSessionInit & { domOverlay?: { root?: Element } };

function patchReferenceSpaces(session: XRSession, floor: FloorTracker): void {
  const original = session.requestReferenceSpace.bind(session);
  session.requestReferenceSpace = async (type) => {
    const space: XRReferenceSpace = await original(type);
    if (type === 'local') {
      // IWER anchors `local` at the viewer pose at request time; ARKit's origin is gravity aligned.
      mat4.identity(space[P_SPACE].offsetMatrix);
    } else if (type === 'local-floor') {
      floor.track(space);
    }
    return space;
  };
}

const IMMERSIVE_CLASS = 'holoweb-immersive';
const IMMERSIVE_CSS = `
html.${IMMERSIVE_CLASS}, html.${IMMERSIVE_CLASS} body { background: transparent !important; }
html.${IMMERSIVE_CLASS} body * { visibility: hidden !important; }
html.${IMMERSIVE_CLASS} [data-holoweb-xr], html.${IMMERSIVE_CLASS} [data-holoweb-xr] *,
html.${IMMERSIVE_CLASS} [data-holoweb-overlay], html.${IMMERSIVE_CLASS} [data-holoweb-overlay] * {
  visibility: visible !important;
}`;

/** Hide page content for the duration of an immersive session; returns the restore function. */
function enterImmersiveStyle(device: XRDevice, overlayRoot: Element | undefined): () => void {
  if (!document.getElementById('holoweb-immersive-style')) {
    const style = document.createElement('style');
    style.id = 'holoweb-immersive-style';
    style.textContent = IMMERSIVE_CSS;
    (document.head ?? document.documentElement).appendChild(style);
  }
  device.canvasContainer.dataset.holowebXr = '';
  overlayRoot?.setAttribute('data-holoweb-overlay', '');
  document.documentElement.classList.add(IMMERSIVE_CLASS);
  return () => {
    document.documentElement.classList.remove(IMMERSIVE_CLASS);
    overlayRoot?.removeAttribute('data-holoweb-overlay');
  };
}

function raiseOverlay(root: Element | undefined): (() => void) | null {
  if (!(root instanceof HTMLElement)) return null;
  const saved = { zIndex: root.style.zIndex, position: root.style.position };
  root.style.zIndex = OVERLAY_Z_INDEX;
  if (getComputedStyle(root).position === 'static') root.style.position = 'relative';
  return () => {
    root.style.zIndex = saved.zIndex;
    root.style.position = saved.position;
  };
}

export function installSessionHooks(
  device: XRDevice,
  bridge: HoloWebBridge,
  input: ScreenInput,
  anchors: NativeAnchors,
): void {
  const xr = device[P_DEVICE].xrSystem;
  if (!(xr instanceof XRSystem)) throw new Error('HoloWeb: installRuntime must run before session hooks');
  const iwerRequestSession = xr.requestSession.bind(xr);

  xr.requestSession = async (mode: XRSessionMode, options: SessionOptions = {}): Promise<XRSession> => {
    const session = await iwerRequestSession(mode, options);
    const floor = new FloorTracker(bridge.environment.planeData);
    patchReferenceSpaces(session, floor);
    if (mode !== 'immersive-ar') return session;

    let endedByNative = false;
    try {
      const reply = await bridge.requestNativeSession('immersive-ar', [...session.enabledFeatures]);
      if (!reply.ok) throw new DOMException(reply.error ?? 'Native AR session refused', 'NotSupportedError');
    } catch (err) {
      endedByNative = true;
      await session.end().catch(() => undefined);
      throw err instanceof DOMException ? err : new DOMException(String(err), 'NotSupportedError');
    }

    const overlayEnabled = session.enabledFeatures.includes('dom-overlay');
    const overlayRoot = overlayEnabled ? options.domOverlay?.root : undefined;
    const restoreOverlay = raiseOverlay(overlayRoot);
    if (restoreOverlay) {
      Object.defineProperty(session, 'domOverlayState', { configurable: true, value: { type: 'screen' } });
    }
    const restoreStyle = enterImmersiveStyle(device, overlayRoot);
    // Native draws the camera image matching the pose used for each XR frame.
    const removeRendered = addFrameEndListener(device, (frame) => {
      if (frame.session === session) bridge.markRendered();
    });
    const onPlanes = (planes: Parameters<FloorTracker['update']>[0]) => floor.update(planes);
    bridge.planeListeners.add(onPlanes);
    input.attach(session, overlayRoot ?? null);

    bridge.onNativeSessionEnded = () => {
      endedByNative = true;
      session.end().catch(() => undefined);
    };
    session.addEventListener(
      'end',
      () => {
        input.detach();
        restoreOverlay?.();
        restoreStyle();
        removeRendered();
        bridge.planeListeners.delete(onPlanes);
        anchors.clear();
        bridge.onNativeSessionEnded = null;
        if (!endedByNative) bridge.endNativeSession().catch((e) => console.warn('HoloWeb endSession', e));
      },
      { once: true },
    );
    return session;
  };
}
