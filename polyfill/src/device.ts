/**
 * HoloKit XRDevice: IWER device config for an iPhone running ARKit, used in both
 * mono (handheld AR) and stereo (HoloKit X headset) modes.
 */
import { P_DEVICE, P_SESSION, P_WEBGL_LAYER, XRDevice, XRSession, XRWebGLLayer } from 'iwer';
import type { XRDeviceConfig, WebXRFeature } from 'iwer/lib/device/XRDevice.js';
import { XREnvironmentBlendMode, XRInteractionMode } from 'iwer/lib/session/XRSession.js';

export const HOLOKIT_FEATURES: WebXRFeature[] = [
  'viewer',
  'local',
  'local-floor',
  'unbounded',
  'hit-test',
  'dom-overlay',
  'light-estimation',
  'anchors',
  'webgpu',
  'hand-tracking',
  'plane-detection',
];

export function createHoloKitDeviceConfig(userAgent: string): XRDeviceConfig {
  return {
    name: 'HoloKit',
    controllerConfig: undefined,
    // immersive-vr: opaque rendering, native draws black instead of the camera (product decision).
    supportedSessionModes: ['inline', 'immersive-ar', 'immersive-vr'],
    supportedFeatures: HOLOKIT_FEATURES,
    supportedFrameRates: [60],
    isSystemKeyboardSupported: false,
    internalNominalFrameRate: 60,
    environmentBlendModes: {
      'immersive-ar': XREnvironmentBlendMode.AlphaBlend,
      'immersive-vr': XREnvironmentBlendMode.Opaque,
    },
    interactionMode: XRInteractionMode.ScreenSpace,
    // IWER overwrites navigator.userAgent with this value, so keep the real one.
    userAgent,
  };
}

export function devicePixelRatioOrOne(): number {
  const dpr = globalThis.devicePixelRatio;
  return typeof dpr === 'number' && dpr > 0 ? dpr : 1;
}

/** Framebuffer size for a canvas that fills the viewport at native resolution. */
export function nativeFramebufferSize(): { width: number; height: number } {
  const dpr = devicePixelRatioOrOne();
  return {
    width: Math.round(globalThis.innerWidth * dpr),
    height: Math.round(globalThis.innerHeight * dpr),
  };
}

/**
 * Size the app canvas at native resolution while a WebGL base layer is active.
 * IWER sizes it to innerWidth x innerHeight CSS pixels, which is blurry on iPhone and
 * breaks the metre -> pixel viewport math of HoloKit stereo.
 */
function installNativeResolution(device: XRDevice): void {
  const state = device[P_DEVICE];
  const baseLayerSet = state.onBaseLayerSet;
  const sessionEnd = state.onSessionEnd;
  let savedStyle: { canvas: HTMLCanvasElement; width: string; height: string } | null = null;

  state.onBaseLayerSet = (baseLayer) => {
    // Inline sessions render into the page's canvas where the page put it: IWER would move it into
    // its fixed z-index 999 container, covering the page (and its Enter button).
    if (baseLayer && baseLayer[P_WEBGL_LAYER].session[P_SESSION].mode === 'inline') return;
    baseLayerSet(baseLayer);
    if (!baseLayer) return;
    const canvas = baseLayer.context.canvas;
    if (!(canvas instanceof HTMLCanvasElement)) return;
    if (!savedStyle || savedStyle.canvas !== canvas) {
      savedStyle = { canvas, width: canvas.style.width, height: canvas.style.height };
    }
    // Same fixed size three.js read from layer.framebufferWidth/Height (webgl-layer.ts).
    canvas.width = baseLayer.framebufferWidth;
    canvas.height = baseLayer.framebufferHeight;
    canvas.style.width = '100%';
    canvas.style.height = '100%';
  };

  state.onSessionEnd = () => {
    // IWER calls this device-global hook for every session; only an immersive session owns the canvas.
    if (endingInline) return;
    if (savedStyle) {
      savedStyle.canvas.style.width = savedStyle.width;
      savedStyle.canvas.style.height = savedStyle.height;
      savedStyle = null;
    }
    sessionEnd();
  };

  const end = XRSession.prototype.end;
  let endingInline = false;
  XRSession.prototype.end = function (this: XRSession) {
    // XRSession.end runs onSessionEnd synchronously inside its promise executor
    endingInline = this[P_SESSION].mode === 'inline';
    try {
      return end.call(this);
    } finally {
      endingInline = false;
    }
  };

  Object.defineProperty(XRWebGLLayer, 'getNativeFramebufferScaleFactor', {
    configurable: true,
    value: (session: XRSession) => (session[P_SESSION].ended ? 0 : devicePixelRatioOrOne()),
  });
}

type FrameEndListener = NonNullable<XRDevice[typeof P_DEVICE]['onFrameEnd']>;
const frameEndListeners = new WeakMap<XRDevice, Set<FrameEndListener>>();

/** Run `listener` after the page's XR frame callbacks (IWER onFrameEnd hook). Returns an unsubscribe. */
export function addFrameEndListener(device: XRDevice, listener: FrameEndListener): () => void {
  let listeners = frameEndListeners.get(device);
  if (!listeners) {
    const set = new Set<FrameEndListener>();
    frameEndListeners.set(device, set);
    device[P_DEVICE].onFrameEnd = (frame) => set.forEach((l) => l(frame));
    listeners = set;
  }
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function createHoloKitDevice(): XRDevice {
  const device = new XRDevice(createHoloKitDeviceConfig(globalThis.navigator.userAgent), {
    stereoEnabled: false,
    ipd: 0.064,
  });
  // The ARKit world origin is the WebXR origin; start the viewer there until frames arrive.
  device.position.set(0, 0, 0);
  installNativeResolution(device);
  return device;
}
