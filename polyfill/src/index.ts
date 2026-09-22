/**
 * HoloWeb polyfill entry. Injected by the iOS app as a WKUserScript at document start
 * (main frame, page world). Installs navigator.xr backed by a HoloKit IWER device and
 * exposes window.__holoweb for native's evaluateJavaScript fallback.
 */
import { P_DEVICE } from 'iwer';
import { NativeAnchors } from './anchors.js';
import { HoloWebBridge, type NativeCallbacks } from './bridge.js';
import { createHoloKitDevice, featuresFor } from './device.js';
import { HandTracking } from './hand-input.js';
import { installGPUBinding, needsPrimingView } from './gpu-binding.js';
import { installWebXRGlobals, missingWebXRGlobals } from './globals.js';
import { PlaneEnvironment } from './hittest.js';
import { installTransientHitTest } from './hittest-transient.js';
import { ScreenInput } from './input.js';
import { createMockTransport } from './mock-native.js';
import { installLightEstimation } from './light.js';
import { MeshTracking } from './meshes.js';
import { PlaneTracking } from './planes.js';
import { installReflectionBinding, ReflectionMaps } from './reflection.js';
import { installFrameHooks, installSessionHooks } from './session.js';
import { installViewCountPolicy } from './views.js';
import { applyVisibility } from './visibility.js';
import { installOpaqueFramebuffer } from './webgl-layer.js';
import { getWebKit, nullTransport, webkitTransport, type Transport } from './webkit.js';

export const VERSION = '0.1.0';

export interface HoloWebGlobal extends NativeCallbacks {
  readonly version: string;
  readonly bridge: HoloWebBridge;
  setMode: HoloWebBridge['setMode'];
  setIpd: HoloWebBridge['setIpd'];
  hitTest: HoloWebBridge['hitTest'];
  /** Stereo pose prediction horizon in ms (default 25, 0 disables). */
  setPrediction: HoloWebBridge['setPrediction'];
  readonly anchors: NativeAnchors;
  readonly hands: HandTracking;
  readonly planes: PlaneTracking;
  readonly meshes: MeshTracking;
  readonly reflections: ReflectionMaps;
  /** WebXR interface globals not installed (should be empty; XRGPUBinding needs WebGPU). */
  missingGlobals(): string[];
}

function selectTransport(): Transport {
  const webkit = webkitTransport();
  if (webkit) return webkit;
  // Desktop development: no WKWebView at all.
  if (!getWebKit()) return createMockTransport();
  return nullTransport();
}

export function install(): HoloWebGlobal {
  const existing = (globalThis as unknown as { __holoweb?: HoloWebGlobal }).__holoweb;
  if (existing?.bridge) return existing;

  const device = createHoloKitDevice();
  device.installSEM(PlaneEnvironment);
  const environment = device.sem as PlaneEnvironment;
  // WKWebView has no navigator.xr; on desktop Chrome replace the native runtime.
  device.installRuntime({ forceInstall: true });

  const bridge = new HoloWebBridge(device, environment, selectTransport());
  const input = new ScreenInput(device);
  const anchors = new NativeAnchors(bridge);
  anchors.install();
  bridge.anchorsHandler = (list) => anchors.update(list);
  const hands = new HandTracking(device);
  bridge.handsHandler = (list) => hands.update(list);
  const planes = new PlaneTracking(device);
  bridge.planeListeners.add((list) => planes.update(list));
  const meshes = new MeshTracking(device);
  bridge.meshesHandler = (update) => meshes.update(update);
  bridge.onCapabilities = (capabilities) => {
    device[P_DEVICE].supportedFeatures = featuresFor(capabilities);
  };
  const reflections = new ReflectionMaps();
  bridge.environmentHandler = (env) => reflections.update(env);
  bridge.visibilityHandler = (state) => applyVisibility(device, state);
  installSessionHooks(device, bridge, input, () => {
    anchors.clear();
    hands.reset();
    planes.clear();
    meshes.clear();
    reflections.clear();
  });
  installFrameHooks(device, bridge);
  installLightEstimation(() => bridge.latest?.light);
  installReflectionBinding(reflections);
  installTransientHitTest(environment);
  installGPUBinding();
  installWebXRGlobals();
  installViewCountPolicy(needsPrimingView);
  installOpaqueFramebuffer();

  const api: HoloWebGlobal = {
    ...bridge.callbacks,
    version: VERSION,
    bridge,
    setMode: (mode) => bridge.setMode(mode),
    setIpd: (ipd) => bridge.setIpd(ipd),
    hitTest: (origin, direction) => bridge.hitTest(origin, direction),
    setPrediction: (ms) => bridge.setPrediction(ms),
    anchors,
    hands,
    planes,
    meshes,
    reflections,
    missingGlobals: () => missingWebXRGlobals(),
  };
  Object.defineProperty(globalThis, '__holoweb', { value: api, configurable: true, writable: false });

  // `ready` is posted lazily on this frame's first WebXR call (installFrameHooks).
  // A back/forward-cache restore does not re-run scripts; native needs a fresh handle.
  globalThis.addEventListener?.('pageshow', (e: Event) => {
    if ((e as PageTransitionEvent).persisted && bridge.readyPosts > 0) {
      bridge.announceReady().catch((err: unknown) => console.warn('HoloWeb: ready failed', err));
    }
  });
  return api;
}

install();
