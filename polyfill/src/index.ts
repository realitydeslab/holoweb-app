/**
 * HoloWeb polyfill entry. Injected by the iOS app as a WKUserScript at document start
 * (main frame, page world). Installs navigator.xr backed by a HoloKit IWER device and
 * exposes window.__holoweb for native's evaluateJavaScript fallback.
 */
import { HoloWebBridge, type NativeCallbacks } from './bridge.js';
import { createHoloKitDevice } from './device.js';
import { installGPUBinding } from './gpu-binding.js';
import { PlaneEnvironment } from './hittest.js';
import { ScreenInput } from './input.js';
import { createMockTransport } from './mock-native.js';
import { installSessionHooks } from './session.js';
import { installOpaqueFramebuffer } from './webgl-layer.js';
import { getWebKit, nullTransport, webkitTransport, type Transport } from './webkit.js';

export const VERSION = '0.1.0';

export interface HoloWebGlobal extends NativeCallbacks {
  readonly version: string;
  readonly bridge: HoloWebBridge;
  setMode: HoloWebBridge['setMode'];
  setIpd: HoloWebBridge['setIpd'];
  hitTest: HoloWebBridge['hitTest'];
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
  installSessionHooks(device, bridge, input);
  installGPUBinding();
  installOpaqueFramebuffer();

  const api: HoloWebGlobal = {
    ...bridge.callbacks,
    version: VERSION,
    bridge,
    setMode: (mode) => bridge.setMode(mode),
    setIpd: (ipd) => bridge.setIpd(ipd),
    hitTest: (origin, direction) => bridge.hitTest(origin, direction),
  };
  Object.defineProperty(globalThis, '__holoweb', { value: api, configurable: true, writable: false });

  bridge.announceReady().catch((err: unknown) => console.warn('HoloWeb: ready failed', err));
  return api;
}

install();
