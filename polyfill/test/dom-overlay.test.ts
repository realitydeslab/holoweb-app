// @vitest-environment happy-dom
// G6: dom-overlay with root = document.body (immersive-web plane / mesh detection samples).
import { mat4 } from 'gl-matrix';
import { beforeAll, describe, expect, it } from 'vitest';
import type { HoloWebGlobal } from '../src/index.js';

type Msg = Record<string, unknown> & { type: string };
interface Session extends EventTarget {
  inputSources: { targetRayMode: string }[];
  updateRenderState(s: Record<string, unknown>): void;
  requestAnimationFrame(cb: (t: number, f: unknown) => void): number;
  end(): Promise<void>;
}
let hw: HoloWebGlobal;
const xr = () => (navigator as unknown as { xr: { requestSession(m: string, i?: object): Promise<Session> } }).xr;
const nextFrame = (s: Session) => new Promise<void>((r) => s.requestAnimationFrame(() => r()));

beforeAll(async () => {
  (globalThis as Record<string, unknown>).WebGL2RenderingContext = class {};
  (globalThis as Record<string, unknown>).webkit = {
    messageHandlers: { holoweb: { postMessage: (m: Msg) => Promise.resolve(m.type === 'requestSession' ? { ok: true, mode: 'mono' } : { ok: true }) } },
  };
  await import('../src/index.js');
  hw = (globalThis as unknown as { __holoweb: HoloWebGlobal }).__holoweb;
  hw.onFrame(1, 'mono', Array.from(mat4.create()), Array.from(mat4.create()), Array.from(mat4.perspective(mat4.create(), 1, 2, 0.01, 100)), null, 'normal');
});

describe('dom-overlay with root = document.body', () => {
  it('puts XR layers behind the overlay and routes taps through beforexrselect', async () => {
    const header = document.createElement('header');
    const button = document.createElement('button');
    header.appendChild(button);
    const content = document.createElement('div');
    document.body.append(header, content);
    header.addEventListener('beforexrselect', (e) => e.preventDefault()); // the samples' pattern

    const session = await xr().requestSession('immersive-ar', { optionalFeatures: ['dom-overlay'], domOverlay: { root: document.body } });
    try {
      session.updateRenderState({ layers: [{}] });
      await nextFrame(session);
      expect((session as unknown as { domOverlayState: { type: string } }).domOverlayState.type).toBe('screen');
      expect(document.documentElement.classList.contains('holoweb-xr-behind')).toBe(true);

      let beforeFired = 0;
      document.body.addEventListener('beforexrselect', () => beforeFired++);
      button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 10, clientY: 10 }));
      await nextFrame(session);
      expect(beforeFired).toBe(1); // bubbled from the button through the header to body
      expect(session.inputSources).toHaveLength(0); // cancelled by the header: no XR input
      window.dispatchEvent(new PointerEvent('pointerup'));

      content.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 100, clientY: 100 }));
      await nextFrame(session);
      expect(beforeFired).toBe(2);
      expect(session.inputSources.map((s) => s.targetRayMode)).toEqual(['screen']); // not cancelled: XR input
      window.dispatchEvent(new PointerEvent('pointerup'));
    } finally {
      await session.end();
    }
    expect(document.documentElement.classList.contains('holoweb-xr-behind')).toBe(false);
  });

  it('keeps XR layers in place for an overlay root that is not the body', async () => {
    const overlay = document.createElement('div');
    document.body.appendChild(overlay);
    const session = await xr().requestSession('immersive-ar', { optionalFeatures: ['dom-overlay'], domOverlay: { root: overlay } });
    try {
      expect(document.documentElement.classList.contains('holoweb-xr-behind')).toBe(false);
      expect(overlay.style.zIndex).toBe('1000');
    } finally {
      await session.end();
    }
  });
});
