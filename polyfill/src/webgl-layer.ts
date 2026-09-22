/**
 * Opaque framebuffer for immersive XRWebGLLayer.
 *
 * WebXR gives immersive sessions a non-null opaque `layer.framebuffer`; IWER returns null
 * (the canvas' default framebuffer). three.js' WebGPURenderer WebGL2 backend keys state on
 * that object (WeakMap) and breaks on null. Instead of an offscreen FBO plus a per-frame
 * copy, we hand out a sentinel WebGLFramebuffer and make the context treat binding it as
 * binding the default framebuffer. Only framebuffer-binding calls are wrapped:
 * bindFramebuffer, drawBuffers/readBuffer (COLOR_ATTACHMENT0 -> BACK) and invalidation
 * (skipped, it would discard the canvas contents).
 *
 * framebufferWidth/Height report the native framebuffer size from layer creation on, like a
 * real opaque framebuffer. IWER reports the canvas drawing buffer, which three.js has just
 * shrunk with setPixelRatio(1) before reading it; the canvas itself is resized to native on
 * the first XR frame (device.ts), so both sides agree.
 *
 * The size is fixed per layer for the whole session. three.js sizes its XR render target
 * once and ignores setSize while presenting, so after a rotation in mono the canvas keeps its
 * backing size and CSS stretches it to the new viewport; native's projection already matches
 * the new aspect, so geometry stays correct (only the sampling density changes).
 */
import { P_SESSION, P_WEBGL_LAYER, XRWebGLLayer } from 'iwer';
import { nativeFramebufferSize } from './device.js';

type GL = WebGL2RenderingContext;

interface Sentinel {
  framebuffer: WebGLFramebuffer;
  drawBound: boolean;
  readBound: boolean;
}

const sentinels = new WeakMap<GL, Sentinel>();

function installSentinel(gl: GL): Sentinel {
  const existing = sentinels.get(gl);
  if (existing) return existing;
  const framebuffer = gl.createFramebuffer();
  if (!framebuffer) throw new DOMException('Unable to create XR framebuffer', 'OperationError');
  const s: Sentinel = { framebuffer, drawBound: false, readBound: false };
  sentinels.set(gl, s);

  const bind = gl.bindFramebuffer.bind(gl);
  gl.bindFramebuffer = (target: GLenum, fb: WebGLFramebuffer | null) => {
    const isSentinel = fb === framebuffer;
    if (target === gl.FRAMEBUFFER || target === gl.DRAW_FRAMEBUFFER) s.drawBound = isSentinel;
    if (target === gl.FRAMEBUFFER || target === gl.READ_FRAMEBUFFER) s.readBound = isSentinel;
    bind(target, isSentinel ? null : fb);
  };

  const toBack = (b: GLenum, i: number) => (b === gl.COLOR_ATTACHMENT0 && i === 0 ? gl.BACK : gl.NONE);
  const drawBuffers = gl.drawBuffers.bind(gl);
  gl.drawBuffers = (buffers: Iterable<GLenum>) => {
    drawBuffers(s.drawBound ? Array.from(buffers, toBack) : buffers);
  };
  const readBuffer = gl.readBuffer.bind(gl);
  gl.readBuffer = (src: GLenum) => readBuffer(s.readBound && src === gl.COLOR_ATTACHMENT0 ? gl.BACK : src);

  const boundTo = (target: GLenum) => (target === gl.READ_FRAMEBUFFER ? s.readBound : s.drawBound);
  const invalidate = gl.invalidateFramebuffer.bind(gl);
  gl.invalidateFramebuffer = (target: GLenum, attachments: Iterable<GLenum>) => {
    if (!boundTo(target)) invalidate(target, attachments);
  };
  const invalidateSub = gl.invalidateSubFramebuffer.bind(gl);
  gl.invalidateSubFramebuffer = (target, attachments, x, y, width, height) => {
    if (!boundTo(target)) invalidateSub(target, attachments, x, y, width, height);
  };
  return s;
}

function isWebGL2(ctx: unknown): ctx is GL {
  return typeof WebGL2RenderingContext !== 'undefined' && ctx instanceof WebGL2RenderingContext;
}

const isImmersive = (layer: XRWebGLLayer) => layer[P_WEBGL_LAYER].session[P_SESSION].mode !== 'inline';
const layerSizes = new WeakMap<XRWebGLLayer, { width: number; height: number }>();
const fixedSize = (layer: XRWebGLLayer) => {
  let size = layerSizes.get(layer);
  if (!size) {
    size = nativeFramebufferSize();
    layerSizes.set(layer, size);
  }
  return size;
};

export function installOpaqueFramebuffer(): void {
  Object.defineProperty(XRWebGLLayer.prototype, 'framebufferWidth', {
    configurable: true,
    get(this: XRWebGLLayer): number {
      return isImmersive(this) ? fixedSize(this).width : this.context.drawingBufferWidth;
    },
  });
  Object.defineProperty(XRWebGLLayer.prototype, 'framebufferHeight', {
    configurable: true,
    get(this: XRWebGLLayer): number {
      return isImmersive(this) ? fixedSize(this).height : this.context.drawingBufferHeight;
    },
  });
  Object.defineProperty(XRWebGLLayer.prototype, 'framebuffer', {
    configurable: true,
    get(this: XRWebGLLayer): WebGLFramebuffer | null {
      const { context } = this[P_WEBGL_LAYER];
      // Inline sessions render to the default framebuffer (null) per spec; WebGL1 keeps IWER's null.
      if (!isImmersive(this) || !isWebGL2(context)) return null;
      return installSentinel(context).framebuffer;
    },
  });
}
