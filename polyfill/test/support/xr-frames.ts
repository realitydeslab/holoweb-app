// Frame-loop drivers for happy-dom, which has neither WebGL nor WebGPU. IWER runs an immersive
// session's frames only while a layer can be shown: a WebGL baseLayer, or (in a 'webgpu' session)
// renderState.layers.

interface RenderStateTarget {
  updateRenderState(state: Record<string, unknown>): void;
}

/** A callable stub: every property is another stub, calls return stubs, never thenable, 0 as a number. */
export function stub(overrides: Record<string | symbol, unknown> = {}): never {
  const target = function () {} as unknown as Record<string | symbol, unknown>;
  return new Proxy(target, {
    get: (_t, key) => {
      if (key in overrides) return overrides[key];
      if (key === 'then') return undefined;
      if (key === Symbol.toPrimitive) return () => 0;
      return stub();
    },
    apply: () => stub(),
  }) as never;
}

/** A WebGL2 context stand-in: no-op GL calls, a real canvas, clear values IWER can save and restore. */
export function fakeGL(): WebGL2RenderingContext {
  return stub({
    canvas: document.createElement('canvas'),
    getParameter: () => [0, 0, 0, 0],
    isEnabled: () => false,
    isContextLost: () => false,
  });
}

/** Start the frame loop of a (non-WebGPU) immersive session through a WebGL base layer. */
export function startFrames(session: RenderStateTarget, init: Record<string, unknown> = {}): void {
  const Layer = (globalThis as unknown as { XRWebGLLayer: new (s: unknown, gl: unknown) => unknown }).XRWebGLLayer;
  session.updateRenderState({ ...init, baseLayer: new Layer(session, fakeGL()) });
}

/** navigator.gpu with an adapter, so IWER grants 'webgpu' to sessions that request it. */
export function fakeWebGPU(): void {
  Object.defineProperty(navigator, 'gpu', {
    configurable: true,
    value: { requestAdapter: () => Promise.resolve(stub()), getPreferredCanvasFormat: () => 'bgra8unorm' },
  });
}

/** Start the frame loop of a 'webgpu' session through a plain layer (IWER's compositor skips it). */
export function startGPUFrames(session: RenderStateTarget, init: Record<string, unknown> = {}): void {
  const Layer = (globalThis as unknown as { XRLayer: new () => unknown }).XRLayer;
  session.updateRenderState({ ...init, layers: [new Layer()] });
}
