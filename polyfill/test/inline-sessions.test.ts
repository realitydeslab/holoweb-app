// @vitest-environment happy-dom
// G2 + G3: an inline ("magic window") session alongside an immersive one, as the immersive-web
// anchors / interrupted-ar / exit-button samples do.
import { mat4 } from 'gl-matrix';
import { beforeAll, describe, expect, it } from 'vitest';
import type { HoloWebGlobal } from '../src/index.js';

type Msg = Record<string, unknown> & { type: string };
interface Session extends EventTarget {
  updateRenderState(s: Record<string, unknown>): void;
  requestAnimationFrame(cb: (t: number, f: unknown) => void): number;
  end(): Promise<void>;
}
let hw: HoloWebGlobal;
const posted: Msg[] = [];
let refuseNextSession = false;
const xr = () => (navigator as unknown as { xr: { requestSession(m: string, i?: object): Promise<Session> } }).xr;
const frames = (s: Session) => {
  const counter = { n: 0 };
  const tick = () => {
    counter.n++;
    s.requestAnimationFrame(tick);
  };
  s.requestAnimationFrame(tick);
  return counter;
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Minimal WebGL context for XRWebGLLayer (IWER clears the immersive framebuffer each frame). */
function fakeGL(canvas: HTMLCanvasElement) {
  return {
    canvas,
    drawingBufferWidth: canvas.width,
    drawingBufferHeight: canvas.height,
    COLOR_CLEAR_VALUE: 1, DEPTH_CLEAR_VALUE: 2, STENCIL_CLEAR_VALUE: 3, SCISSOR_TEST: 4,
    DEPTH_BUFFER_BIT: 1, COLOR_BUFFER_BIT: 2, STENCIL_BUFFER_BIT: 4,
    getParameter: (p: number) => (p === 1 ? [0, 0, 0, 0] : 0),
    isEnabled: () => false,
    clearColor() {}, clearDepth() {}, clearStencil() {}, clear() {}, enable() {}, disable() {},
  };
}

beforeAll(async () => {
  (globalThis as Record<string, unknown>).WebGL2RenderingContext = class {};
  (globalThis as Record<string, unknown>).webkit = {
    messageHandlers: {
      holoweb: {
        postMessage: (m: Msg) => {
          posted.push(m);
          if (m.type === 'requestSession' && refuseNextSession) {
            refuseNextSession = false;
            return Promise.resolve({ ok: false, error: 'camera unavailable' });
          }
          return Promise.resolve(m.type === 'requestSession' ? { ok: true, mode: 'mono' } : { ok: true });
        },
      },
    },
  };
  await import('../src/index.js');
  hw = (globalThis as unknown as { __holoweb: HoloWebGlobal }).__holoweb;
  hw.onFrame(1, 'mono', Array.from(mat4.create()), Array.from(mat4.create()), Array.from(mat4.perspective(mat4.create(), 1, 2, 0.01, 100)), null, 'normal');
});

describe('inline + immersive sessions', () => {
  it('keeps the inline canvas in the page, parks inline while immersive runs, resumes it after', async () => {
    const Layer = (globalThis as unknown as { XRWebGLLayer: new (s: Session, gl: unknown) => unknown }).XRWebGLLayer;
    const page = document.createElement('div');
    document.body.appendChild(page);
    const inlineCanvas = document.createElement('canvas');
    page.appendChild(inlineCanvas);

    const inline = await xr().requestSession('inline');
    inline.updateRenderState({ baseLayer: new Layer(inline, fakeGL(inlineCanvas)) });
    const inlineFrames = frames(inline);
    await wait(80);
    expect(inlineFrames.n).toBeGreaterThan(0);
    expect(inlineCanvas.parentElement).toBe(page); // G2: not moved into IWER's z-999 container

    const immersiveCanvas = document.createElement('canvas');
    document.body.appendChild(immersiveCanvas);
    const immersive = await xr().requestSession('immersive-ar'); // G3: no "active session exists"
    immersive.updateRenderState({ baseLayer: new Layer(immersive, fakeGL(immersiveCanvas)) });
    expect(posted.some((m) => m.type === 'requestSession' && m.mode === 'immersive-ar')).toBe(true);
    expect(hw.bridge.device.activeSession).toBe(immersive);
    const immersiveFrames = frames(immersive);
    await wait(80);
    const inlineWhileParked = inlineFrames.n;
    await wait(80);
    expect(inlineFrames.n).toBe(inlineWhileParked); // parked: no inline callbacks while presenting
    expect(immersiveFrames.n).toBeGreaterThan(0);
    expect(immersiveCanvas.parentElement).toBe(hw.bridge.device.canvasContainer); // immersive does use the container

    await expect(xr().requestSession('immersive-ar')).rejects.toMatchObject({ name: 'InvalidStateError' });
    expect(hw.bridge.device.activeSession).toBe(immersive);

    await immersive.end();
    expect(hw.bridge.device.activeSession).toBe(inline);
    await wait(80);
    expect(inlineFrames.n).toBeGreaterThan(inlineWhileParked); // resumed
    expect(inlineCanvas.parentElement).toBe(page);
    await inline.end();
    expect(hw.bridge.device.activeSession).toBeUndefined();
  });

  it('an inline session ending while immersive runs leaves the immersive session and its canvas alone', async () => {
    const Layer = (globalThis as unknown as { XRWebGLLayer: new (s: Session, gl: unknown) => unknown }).XRWebGLLayer;
    const inline = await xr().requestSession('inline');
    const immersive = await xr().requestSession('immersive-ar');
    const canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    immersive.updateRenderState({ baseLayer: new Layer(immersive, fakeGL(canvas)) });
    await wait(50);
    expect(canvas.parentElement).toBe(hw.bridge.device.canvasContainer);
    await inline.end();
    expect(hw.bridge.device.activeSession).toBe(immersive);
    expect(canvas.parentElement).toBe(hw.bridge.device.canvasContainer); // not restored by inline's end
    await immersive.end();
    expect(canvas.parentElement).toBe(document.body); // restored by the immersive end
    expect(hw.bridge.device.activeSession).toBeUndefined();
  });

  it('an immersive request refused by native (after parking inline) gives the inline session back', async () => {
    const Layer = (globalThis as unknown as { XRWebGLLayer: new (s: Session, gl: unknown) => unknown }).XRWebGLLayer;
    const inline = await xr().requestSession('inline');
    const canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    inline.updateRenderState({ baseLayer: new Layer(inline, fakeGL(canvas)) }); // IWER runs no callbacks without a layer
    const inlineFrames = frames(inline);
    await wait(50);
    refuseNextSession = true;
    await expect(xr().requestSession('immersive-ar')).rejects.toMatchObject({ name: 'NotSupportedError' });
    expect(hw.bridge.device.activeSession).toBe(inline);
    const before = inlineFrames.n;
    await wait(80);
    expect(inlineFrames.n).toBeGreaterThan(before); // not left parked
    await inline.end();
  });
});
