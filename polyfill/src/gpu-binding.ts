/**
 * XRGPUBinding polyfill (WebXR/WebGPU binding) over the page's own GPUDevice.
 *
 * Surface matches what three.js XRManager (WebGPU backend) calls:
 *   new XRGPUBinding(session, device), getPreferredColorFormat(),
 *   createProjectionLayer({ colorFormat, textureType? }) -> { textureWidth, textureHeight,
 *   textureArrayLength, ignoreDepthValues }, session.updateRenderState({ layers: [layer] }),
 *   getViewSubImage(layer, view) -> { colorTexture, viewport, getViewDescriptor() }.
 * The session must have been created with the 'webgpu' feature.
 *
 * Layer textures are 2-layer 'texture-array's sized to one view: the full framebuffer in
 * mono, one HoloKit eye rect in stereo. Each view renders into its own array layer with a
 * full-layer viewport, which is what three.js' layered render path assumes.
 */
import { P_DEVICE, P_SESSION, XRSession, XRViewport } from 'iwer';
import type { XRView } from 'iwer';
import { addFrameEndListener, nativeFramebufferSize } from './device.js';
import { GPUPresenter, type LayerBlit } from './gpu-presenter.js';
import type { PixelRect } from './stereo.js';

type Eye = 'left' | 'right' | 'none';

export interface XRGPUProjectionLayerInit {
  colorFormat: GPUTextureFormat;
  depthStencilFormat?: GPUTextureFormat;
  textureType?: 'texture' | 'texture-array';
  scaleFactor?: number;
}

export class XRGPUProjectionLayer extends EventTarget {
  readonly textureArrayLength = 2;
  readonly ignoreDepthValues = true;
  readonly isStatic = false;
  fixedFoveation: number | null = null;
  deltaPose = null;
  /** Views requested through getViewSubImage during the current frame. */
  readonly usedEyes = new Set<Eye>();

  constructor(
    readonly session: XRSession,
    readonly colorTexture: GPUTexture,
    readonly colorFormat: GPUTextureFormat,
  ) {
    super();
  }

  get textureWidth(): number {
    return this.colorTexture.width;
  }

  get textureHeight(): number {
    return this.colorTexture.height;
  }

  destroy(): void {
    this.colorTexture.destroy();
  }
}

export class XRGPUSubImage {
  readonly depthStencilTexture: GPUTexture | null = null;
  readonly motionVectorTexture: GPUTexture | null = null;

  constructor(
    readonly colorTexture: GPUTexture,
    readonly viewport: XRViewport,
    readonly imageIndex: number,
    readonly colorTextureFormat: GPUTextureFormat,
  ) {}

  getViewDescriptor(): GPUTextureViewDescriptor {
    return { dimension: '2d', baseArrayLayer: this.imageIndex, arrayLayerCount: 1, mipLevelCount: 1 };
  }
}

/** Destination rect (canvas pixels, bottom-left origin) for a view in the current mode. */
export function destinationRect(session: XRSession, eye: Eye, fb: { width: number; height: number }): PixelRect {
  const device = session[P_SESSION].device;
  const native = device[P_DEVICE].nativeViewports[eye];
  if (native) return native;
  if (eye === 'none' || !device.stereoEnabled) return { x: 0, y: 0, width: fb.width, height: fb.height };
  const half = Math.floor(fb.width / 2);
  return { x: eye === 'left' ? 0 : half, y: 0, width: half, height: fb.height };
}

/** Per-view texture size for a new layer, from the render mode at creation time. */
function layerSize(session: XRSession, scale: number): { width: number; height: number } {
  const fb = nativeFramebufferSize();
  const eyeRect = session[P_SESSION].device.stereoEnabled ? destinationRect(session, 'left', fb) : null;
  const w = eyeRect ? eyeRect.width : fb.width;
  const h = eyeRect ? eyeRect.height : fb.height;
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}

interface Presentation {
  presenter: GPUPresenter;
  layers: Set<XRGPUProjectionLayer>;
}

const presentations = new WeakMap<XRSession, Presentation>();

function presentFrame(session: XRSession): void {
  const presentation = presentations.get(session);
  if (!presentation) return;
  const fb = nativeFramebufferSize();
  const blits: LayerBlit[] = [];
  for (const layer of session.renderState.layers) {
    if (!(layer instanceof XRGPUProjectionLayer) || layer.usedEyes.size === 0) continue;
    for (const eye of layer.usedEyes) {
      blits.push({ texture: layer.colorTexture, layerIndex: eye === 'right' ? 1 : 0, rect: destinationRect(session, eye, fb) });
    }
    layer.usedEyes.clear();
  }
  if (blits.length > 0) presentation.presenter.present(blits, fb.width, fb.height);
}

export class XRGPUBinding {
  private readonly session: XRSession;

  constructor(session: XRSession, readonly device: GPUDevice) {
    if (!(session instanceof XRSession)) throw new TypeError('XRGPUBinding: not a HoloWeb XRSession');
    if (session[P_SESSION].ended) throw new DOMException('XRSession has ended', 'InvalidStateError');
    if (!session.enabledFeatures.includes('webgpu')) {
      throw new DOMException("XRGPUBinding requires the 'webgpu' session feature", 'InvalidStateError');
    }
    this.session = session;
  }

  get nativeProjectionScaleFactor(): number {
    return 1;
  }

  getPreferredColorFormat(): GPUTextureFormat {
    return navigator.gpu.getPreferredCanvasFormat();
  }

  createProjectionLayer(init: XRGPUProjectionLayerInit): XRGPUProjectionLayer {
    if (init.textureType === 'texture') {
      throw new DOMException("HoloWeb XRGPUBinding supports textureType 'texture-array' only", 'NotSupportedError');
    }
    const session = this.session;
    const size = layerSize(session, init.scaleFactor ?? 1);
    const texture = this.device.createTexture({
      label: 'holoweb-xr-projection-layer',
      size: { width: size.width, height: size.height, depthOrArrayLayers: 2 },
      format: init.colorFormat,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
    });
    const layer = new XRGPUProjectionLayer(session, texture, init.colorFormat);
    this.presentation(init.colorFormat).layers.add(layer);
    return layer;
  }

  getViewSubImage(layer: XRGPUProjectionLayer, view: XRView): XRGPUSubImage {
    if (!(layer instanceof XRGPUProjectionLayer) || layer.session !== this.session) {
      throw new DOMException('Layer was not created by this XRGPUBinding', 'InvalidStateError');
    }
    const eye = view.eye as Eye;
    layer.usedEyes.add(eye);
    const viewport = new XRViewport(0, 0, layer.textureWidth, layer.textureHeight);
    return new XRGPUSubImage(layer.colorTexture, viewport, eye === 'right' ? 1 : 0, layer.colorFormat);
  }

  private presentation(format: GPUTextureFormat): Presentation {
    const session = this.session;
    let presentation = presentations.get(session);
    if (presentation) return presentation;
    const created: Presentation = { presenter: new GPUPresenter(this.device, format), layers: new Set() };
    presentations.set(session, created);
    const removeListener = addFrameEndListener(session[P_SESSION].device, (frame) => {
      if (frame.session === session) presentFrame(session);
    });
    session.addEventListener(
      'end',
      () => {
        removeListener();
        created.presenter.destroy();
        created.layers.forEach((l) => l.destroy());
        presentations.delete(session);
      },
      { once: true },
    );
    presentation = created;
    return presentation;
  }
}

/** Install globalThis.XRGPUBinding (and the layer classes) if WebGPU is present. */
export function installGPUBinding(target: Record<string, unknown> = globalThis as unknown as Record<string, unknown>): boolean {
  if (typeof navigator === 'undefined' || !('gpu' in navigator)) return false;
  target.XRGPUBinding = XRGPUBinding;
  target.XRGPUSubImage = XRGPUSubImage;
  target.XRProjectionLayer = XRGPUProjectionLayer;
  return true;
}
