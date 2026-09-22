// @vitest-environment happy-dom
// G11: native bridge.onVisibility -> session.visibilityState + visibilitychange, input ends while
// not visible, XR callbacks pause while hidden, the session survives.
import { mat4 } from 'gl-matrix';
import { beforeAll, describe, expect, it } from 'vitest';
import type { HoloWebGlobal } from '../src/index.js';

type Msg = Record<string, unknown> & { type: string };
interface Session extends EventTarget {
  visibilityState: string;
  inputSources: unknown[];
  updateRenderState(s: Record<string, unknown>): void;
  requestAnimationFrame(cb: (t: number, f: unknown) => void): number;
  end(): Promise<void>;
}
let hw: HoloWebGlobal;
const xr = () => (navigator as unknown as { xr: { requestSession(m: string, i?: object): Promise<Session> } }).xr;
const nextFrame = (s: Session) => new Promise<void>((r) => s.requestAnimationFrame(() => r()));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  (globalThis as Record<string, unknown>).WebGL2RenderingContext = class {};
  (globalThis as Record<string, unknown>).webkit = {
    messageHandlers: { holoweb: { postMessage: (m: Msg) => Promise.resolve(m.type === 'requestSession' ? { ok: true, mode: 'mono' } : { ok: true }) } },
  };
  await import('../src/index.js');
  hw = (globalThis as unknown as { __holoweb: HoloWebGlobal }).__holoweb;
  hw.onFrame(1, 'mono', Array.from(mat4.create()), Array.from(mat4.create()), Array.from(mat4.perspective(mat4.create(), 1, 2, 0.01, 100)), null, 'normal');
});

describe('native visibility', () => {
  it('maps onVisibility to visibilityState + visibilitychange, ends input, pauses frames while hidden', async () => {
    const session = await xr().requestSession('immersive-ar');
    try {
      session.updateRenderState({ layers: [{}] });
      await nextFrame(session);
      const seen: string[] = [];
      session.addEventListener('visibilitychange', () => seen.push(session.visibilityState));
      const events: string[] = [];
      for (const t of ['selectstart', 'select', 'selectend']) session.addEventListener(t, () => events.push(t));

      // a press in progress
      window.dispatchEvent(new PointerEvent('pointerdown', { clientX: 10, clientY: 10 }));
      await nextFrame(session);
      await nextFrame(session);
      expect(events).toEqual(['selectstart']);

      hw.onVisibility('visible-blurred');
      expect(seen).toEqual(['visible-blurred']); // synchronous, not on the next frame
      await nextFrame(session); // frames continue while blurred
      expect(events).toEqual(['selectstart', 'selectend']); // ended without select
      expect(session.inputSources).toHaveLength(0);
      window.dispatchEvent(new PointerEvent('pointerdown', { clientX: 10, clientY: 10 }));
      await nextFrame(session);
      expect(session.inputSources).toHaveLength(0); // no new input while blurred

      hw.onVisibility('hidden');
      let frames = 0;
      const tick = () => {
        frames++;
        session.requestAnimationFrame(tick);
      };
      session.requestAnimationFrame(tick);
      await wait(100);
      expect(frames).toBe(0); // paused

      hw.onVisibility('visible');
      await wait(100);
      expect(frames).toBeGreaterThan(0); // resumed, same session
      hw.onVisibility('visible'); // no change -> no event
      hw.onVisibility('bogus' as 'visible'); // native sent garbage: ignored
      expect(seen).toEqual(['visible-blurred', 'hidden', 'visible']);
    } finally {
      window.dispatchEvent(new PointerEvent('pointerup'));
      await session.end();
    }
  });
});
