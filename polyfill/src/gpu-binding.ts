/**
 * HoloWeb side of IWER's XRGPUBinding (IWER 2.7.0 from PR #208: WebXR/WebGPU binding, WebGPU layers
 * and a compositor that draws them onto an IWER-owned canvas in the device's canvas container).
 * installRuntime sets XRGPUBinding, XRProjectionLayer and XRGPUSubImage; this module adapts them:
 *
 * - Native resolution. The compositor canvas is the native framebuffer (patched presentationSize hook),
 *   and a projection layer's views are sized to one view: the full framebuffer in mono, one HoloKit eye
 *   rect in stereo (getRecommendedViewResolution, read when the layer is created). The patched
 *   compositor draws each eye at its nativeViewports rect and shows the 'none' view in mono.
 *
 * - Mid-session mono <-> stereo (1 <-> 2 views): three.js r186's WebGPU backend caches the render
 *   pass descriptor of its intermediate (tone-mapping / colour-space) target under a key without
 *   the ArrayCamera size, and builds one colour attachment per camera on first use. A descriptor
 *   first built with 1 camera crashes when a 2nd camera appears (_createArrayCameraLayerDescriptors
 *   reads colorAttachments[1]); one built with 2 cameras serves 1 or 2. So a mono session primes it:
 *   until the page has rendered two views for PRIME_FRAMES frames, views.ts appends its inert
 *   'right' view. A session that stays mono is a true single view after that.
 *
 * - The inert view's sub-image has a 0x0 viewport, like XRWebGLLayer.getViewport for it. IWER's
 *   compositor never shows it in mono (it draws only the 'none' view there).
 *
 * - IWER's first compositor canvas is tagged data-holoweb="xr-gpu-presenter" (diagnostics, e2e).
 */
import { P_DEVICE, XRGPUBinding, XRProjectionLayer, XRSession, XRViewport } from 'iwer';
import type { XRDevice } from 'iwer';
import { XRGPUPresenter } from 'iwer/lib/layers/XRGPUPresenter.js';
import { addFrameEndListener, nativeFramebufferSize } from './device.js';

/** Frames with two rendered views after which three.js' descriptor cache is primed. */
export const PRIME_FRAMES = 3;

interface LayerUse {
  /** Eyes the page asked sub-images for in the current frame. */
  readonly eyes: Set<string>;
  /** Frames in which the page rendered two views into the layer. */
  twoViewFrames: number;
}

const layerUse = new WeakMap<XRProjectionLayer, LayerUse>();

function useOf(layer: XRProjectionLayer): LayerUse {
  let use = layerUse.get(layer);
  if (!use) {
    use = { eyes: new Set(), twoViewFrames: 0 };
    layerUse.set(layer, use);
  }
  return use;
}

/** Per-view texture size for a new projection layer, from the render mode at creation time. */
export function recommendedViewResolution(device: XRDevice): { width: number; height: number } {
  const fb = nativeFramebufferSize();
  if (!device.stereoEnabled) return fb;
  const left = device[P_DEVICE].nativeViewports.left;
  return left ? { width: left.width, height: left.height } : { width: Math.floor(fb.width / 2), height: fb.height };
}

/** Size IWER's WebGPU layers and compositor natively, and track views for three.js priming. */
export function installGPUBinding(device: XRDevice): void {
  const state = device[P_DEVICE];
  state.presentationSize = nativeFramebufferSize;
  state.getRecommendedViewResolution = () => recommendedViewResolution(device);

  const getViewSubImage = XRGPUBinding.prototype.getViewSubImage;
  XRGPUBinding.prototype.getViewSubImage = function (this: XRGPUBinding, layer, view) {
    const subImage = getViewSubImage.call(this, layer, view);
    useOf(layer).eyes.add(view.eye);
    if (view.eye === 'right' && !device.stereoEnabled) {
      Object.defineProperty(subImage, 'viewport', { configurable: true, value: new XRViewport(0, 0, 0, 0) });
    }
    return subImage;
  };

  type Surfaces = { surface(index: number): { canvas: HTMLCanvasElement } };
  const presenter = XRGPUPresenter.prototype as unknown as Surfaces;
  const surface = presenter.surface;
  presenter.surface = function (this: Surfaces, index) {
    const created = surface.call(this, index);
    if (index === 0) created.canvas.dataset.holoweb = 'xr-gpu-presenter';
    return created;
  };

  addFrameEndListener(device, (frame) => {
    for (const layer of frame.session.renderState.layers ?? []) {
      const use = layer instanceof XRProjectionLayer ? layerUse.get(layer) : undefined;
      if (!use) continue;
      if (use.eyes.size >= 2) use.twoViewFrames++;
      use.eyes.clear();
    }
  });
}

/** True while three.js' WebGPU descriptor cache may still hold a 1-view descriptor (views.ts). */
export function needsPrimingView(session: XRSession): boolean {
  // three.js-specific (it sets globalThis.__THREE__); other WebGPU renderers get a plain single view.
  if (typeof (globalThis as { __THREE__?: unknown }).__THREE__ === 'undefined') return false;
  return (session.renderState.layers ?? []).some(
    (l) => l instanceof XRProjectionLayer && (layerUse.get(l)?.twoViewFrames ?? 0) < PRIME_FRAMES,
  );
}
