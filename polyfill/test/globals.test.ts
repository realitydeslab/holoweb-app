// @vitest-environment happy-dom
// P0 (device: "Can't find variable: XRRay"): WKWebView has no WebXR globals, so the polyfill installs
// every interface a page may reference. XRRay follows the spec's DOMPointInit defaults.
import { beforeAll, describe, expect, it } from 'vitest';
import { WEBXR_GLOBALS } from '../src/globals.js';
import type { HoloWebGlobal } from '../src/index.js';

type Ctor = new (...args: unknown[]) => { origin: DOMPointReadOnly; direction: DOMPointReadOnly; matrix: Float32Array };
const g = globalThis as unknown as Record<string, unknown>;
let hw: HoloWebGlobal;

beforeAll(async () => {
  for (const name of Object.keys(g)) if (name.startsWith('XR')) delete g[name];
  g.WebGL2RenderingContext = class {};
  Object.defineProperty(navigator, 'gpu', { value: {}, configurable: true }); // WKWebView on iOS 27 has WebGPU
  g.webkit = { messageHandlers: { holoweb: { postMessage: () => Promise.resolve({ ok: true }) } } };
  await import('../src/index.js');
  hw = g.__holoweb as HoloWebGlobal;
});

describe('WebXR globals', () => {
  it('installs every WebXR interface as a constructor', () => {
    expect(hw.missingGlobals()).toEqual([]);
    for (const name of WEBXR_GLOBALS) expect(typeof g[name], name).toBe('function');
    expect(navigator.xr).toBeInstanceOf(g.XRSystem as Ctor);
  });

  it('XRRay: DOMPointInit defaults, TypeError on bad input, from an XRRigidTransform, .matrix', () => {
    const XRRay = g.XRRay as Ctor;
    const XRRigidTransform = g.XRRigidTransform as new (p?: object, o?: object) => unknown;
    const d = new XRRay();
    expect([d.origin.w, d.direction.z, d.direction.w]).toEqual([1, -1, 0]);
    const r = new XRRay({ y: 1 }, { z: -2, w: 0 });
    expect([r.origin.x, r.origin.y, r.origin.w, r.direction.z]).toEqual([0, 1, 1, -1]);
    expect(r.matrix).toHaveLength(16);
    expect(() => new XRRay({}, { z: -1 })).toThrow(TypeError); // direction w defaults to 1
    expect(() => new XRRay({}, { w: 0 })).toThrow(TypeError); // zero direction
    expect(() => new XRRay({ w: 0 })).toThrow(TypeError);
    const t = new XRRay(new XRRigidTransform({ x: 1, y: 2, z: 3 }));
    expect([t.origin.x, t.origin.y, t.origin.z, t.direction.z]).toEqual([1, 2, 3, -1]);
  });
});
