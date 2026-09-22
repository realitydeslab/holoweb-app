/**
 * Presents XRGPUBinding projection layers: after the page's XR frame callback, each
 * used array layer is copied into a polyfill-owned, full-screen, transparent WebGPU canvas
 * at the mono / HoloKit viewport rect.
 *
 * Fast path: copyTextureToTexture when the layer size equals the destination rect.
 * Fallback: a textured-triangle blit (scales), used when the destination rect no longer
 * matches the layer size (e.g. the phone model / screen info arrived after layer creation).
 */
import type { PixelRect } from './stereo.js';

export interface LayerBlit {
  texture: GPUTexture;
  layerIndex: number;
  /** Destination in canvas pixels, bottom-left origin (WebXR / GL viewport convention). */
  rect: PixelRect;
}

const BLIT_WGSL = /* wgsl */ `
struct VSOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };
@vertex fn vs(@builtin(vertex_index) i: u32) -> VSOut {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  var o: VSOut;
  o.pos = vec4f(p * 2.0 - 1.0, 0.0, 1.0);
  o.uv = vec2f(p.x, 1.0 - p.y);
  return o;
}
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
@fragment fn fs(in: VSOut) -> @location(0) vec4f { return textureSample(src, samp, in.uv); }
`;

export class GPUPresenter {
  readonly canvas: HTMLCanvasElement;
  private readonly context: GPUCanvasContext;
  private pipeline: GPURenderPipeline | null = null;
  private sampler: GPUSampler | null = null;
  private readonly bindGroups = new WeakMap<GPUTexture, GPUBindGroup[]>();

  constructor(
    private readonly device: GPUDevice,
    private readonly format: GPUTextureFormat,
  ) {
    const canvas = document.createElement('canvas');
    canvas.dataset.holoweb = 'xr-gpu-presenter';
    canvas.dataset.holowebXr = '';
    Object.assign(canvas.style, {
      position: 'fixed',
      left: '0',
      top: '0',
      width: '100%',
      height: '100%',
      zIndex: '999',
      pointerEvents: 'none',
    });
    const context = canvas.getContext('webgpu');
    if (!context) throw new DOMException('WebGPU canvas context unavailable', 'NotSupportedError');
    this.canvas = canvas;
    this.context = context;
    (document.body ?? document.documentElement).appendChild(canvas);
  }

  private configure(width: number, height: number): void {
    if (this.canvas.width === width && this.canvas.height === height && this.canvas.dataset.configured) return;
    this.canvas.width = width;
    this.canvas.height = height;
    this.context.configure({
      device: this.device,
      format: this.format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_DST,
      alphaMode: 'premultiplied',
    });
    this.canvas.dataset.configured = '1';
  }

  present(blits: readonly LayerBlit[], width: number, height: number): void {
    this.configure(width, height);
    const target = this.context.getCurrentTexture();
    const encoder = this.device.createCommandEncoder({ label: 'holoweb-xr-present' });
    const clamp = (b: LayerBlit) => {
      const x = Math.max(0, Math.min(b.rect.x, width));
      const top = Math.max(0, Math.min(height - b.rect.y - b.rect.height, height));
      return { x, top, w: Math.min(b.rect.width, width - x), h: Math.min(b.rect.height, height - top) };
    };
    const copyable = blits.every((b) => b.texture.width === b.rect.width && b.texture.height === b.rect.height);
    this.canvas.dataset.path = copyable ? 'copy' : 'blit';

    if (copyable) {
      encoder
        .beginRenderPass({
          colorAttachments: [{ view: target.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }],
        })
        .end();
      for (const b of blits) {
        const r = clamp(b);
        if (r.w <= 0 || r.h <= 0) continue;
        encoder.copyTextureToTexture(
          { texture: b.texture, origin: { x: 0, y: 0, z: b.layerIndex } },
          { texture: target, origin: { x: r.x, y: r.top, z: 0 } },
          { width: r.w, height: r.h, depthOrArrayLayers: 1 },
        );
      }
    } else {
      const pass = encoder.beginRenderPass({
        colorAttachments: [{ view: target.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }],
      });
      pass.setPipeline(this.blitPipeline());
      for (const b of blits) {
        const r = clamp(b);
        if (r.w <= 0 || r.h <= 0) continue;
        pass.setViewport(r.x, r.top, r.w, r.h, 0, 1);
        pass.setScissorRect(r.x, r.top, r.w, r.h);
        pass.setBindGroup(0, this.bindGroup(b.texture, b.layerIndex));
        pass.draw(3);
      }
      pass.end();
    }
    this.device.queue.submit([encoder.finish()]);
  }

  private blitPipeline(): GPURenderPipeline {
    if (this.pipeline) return this.pipeline;
    const module = this.device.createShaderModule({ label: 'holoweb-blit', code: BLIT_WGSL });
    this.pipeline = this.device.createRenderPipeline({
      label: 'holoweb-blit',
      layout: 'auto',
      vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: 'fs', targets: [{ format: this.format }] },
      primitive: { topology: 'triangle-list' },
    });
    this.sampler = this.device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    return this.pipeline;
  }

  private bindGroup(texture: GPUTexture, layerIndex: number): GPUBindGroup {
    let groups = this.bindGroups.get(texture);
    if (!groups) {
      groups = [];
      this.bindGroups.set(texture, groups);
    }
    let group = groups[layerIndex];
    if (!group) {
      group = this.device.createBindGroup({
        layout: this.blitPipeline().getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: texture.createView({ dimension: '2d', baseArrayLayer: layerIndex, arrayLayerCount: 1 }) },
          { binding: 1, resource: this.sampler as GPUSampler },
        ],
      });
      groups[layerIndex] = group;
    }
    return group;
  }

  destroy(): void {
    try {
      this.context.unconfigure();
    } catch {
      // context already lost
    }
    this.canvas.remove();
  }
}
