/**
 * HoloWeb polyfill entry. Injected by the iOS app as a WKUserScript at document start
 * (main frame, page world). Installs navigator.xr backed by a HoloKit IWER device and
 * exposes window.__holoweb for native's evaluateJavaScript fallback.
 */
import { NativeAnchors } from './anchors.js';
import { HoloWebBridge, type NativeCallbacks } from './bridge.js';
import { createHoloKitDevice } from './device.js';
import { installGPUBinding, needsPrimingView } from './gpu-binding.js';
import { PlaneEnvironment } from './hittest.js';
import { ScreenInput } from './input.js';
import { createMockTransport } from './mock-native.js';
import { installLightEstimation } from './light.js';
import { installSessionHooks } from './session.js';
import { installViewCountPolicy } from './views.js';
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
  installSessionHooks(device, bridge, input, anchors);
  installLightEstimation(() => bridge.latest?.light);
  installGPUBinding();
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
  };
  Object.defineProperty(globalThis, '__holoweb', { value: api, configurable: true, writable: false });

  bridge.announceReady().catch((err: unknown) => console.warn('HoloWeb: ready failed', err));
  // A back/forward-cache restore does not re-run scripts; native needs a fresh handle.
  globalThis.addEventListener?.('pageshow', (e: Event) => {
    if ((e as PageTransitionEvent).persisted) {
      bridge.announceReady().catch((err: unknown) => console.warn('HoloWeb: ready failed', err));
    }
  });
  return api;
}

install();
