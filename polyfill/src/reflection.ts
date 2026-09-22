/**
 * Reflection cube maps for WebXR Lighting Estimation, from native `bridge.onEnvironment`
 * (ARKit AREnvironmentProbeAnchor, 32x32 RGBA8 sRGB faces, +X -X +Y -Y +Z -Z, row 0 = top,
 * OpenGL cube orientation, <= 1 Hz).
 *
 * - The global XRWebGLBinding becomes a subclass of IWER's (depth sensing unchanged) that remembers
 *   its GL context and implements getReflectionCubeMap(probe): one cube texture per GL context,
 *   updated in place when a newer map arrived, null before the first map. No createProjectionLayer,
 *   so three.js keeps using XRWebGLLayer for WebGL and XRGPUBinding for WebGPU.
 * - Each new map fires `reflectionchange` on every light probe of a live session; a probe created
 *   after a map arrived gets one on the next task.
 * - Upload uses SRGB8_ALPHA8 (WebGL2) or EXT_sRGB (WebGL1, RGBA fallback) and restores every piece
 *   of GL state it touches, because engines (three.js) cache that state.
 */
import { P_SESSION, XRSession } from 'iwer';
import { XRWebGLBinding as IWERWebGLBinding } from 'iwer/lib/depth/XRWebGLBinding.js';
import { decodeBase64 } from './base64.js';
import { liveProbes, setProbeCreatedHook, XRLightProbe } from './light.js';

export interface NativeEnvironment {
  size: number;
  format?: string;
  colorSpace?: string;
  /** Six base64 strings of size * size * 4 bytes: +X, -X, +Y, -Y, +Z, -Z. */
  faces: string[];
  timestamp?: number;
}

type GL = WebGLRenderingContext | WebGL2RenderingContext;

/** Latest environment map plus diagnostics. */
export class ReflectionMaps {
  size = 0;
  faces: Uint8Array[] | null = null;
  version = 0;
  /** reflectionchange events fired / non-null getReflectionCubeMap results (diagnostics). */
  fired = 0;
  served = 0;

  constructor() {
    setProbeCreatedHook((probe) => {
      if (this.faces) setTimeout(() => this.fire(probe), 0);
    });
  }

  update(env: NativeEnvironment): boolean {
    const size = env?.size;
    if (!Number.isInteger(size) || size <= 0 || !Array.isArray(env.faces) || env.faces.length !== 6) return false;
    if (env.format !== undefined && env.format !== 'rgba8') return false;
    const faces = env.faces.map(decodeBase64);
    if (faces.some((f) => f.length !== size * size * 4)) return false;
    this.size = size;
    this.faces = faces;
    this.version++;
    for (const probe of liveProbes) this.fire(probe);
    return true;
  }

  private fire(probe: XRLightProbe): void {
    if (probe.session[P_SESSION].ended) return;
    this.fired++;
    probe.notifyReflectionChange();
  }

  clear(): void {
    this.faces = null;
    this.size = 0;
  }
}

interface CubeEntry {
  texture: WebGLTexture;
  version: number;
}

const isWebGL2 = (gl: GL): gl is WebGL2RenderingContext =>
  typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;

function upload(gl: GL, texture: WebGLTexture, maps: ReflectionMaps): void {
  const faces = maps.faces!;
  const gl2 = isWebGL2(gl) ? gl : null;
  const srgb = gl2 ? null : (gl.getExtension('EXT_sRGB') as { SRGB_ALPHA_EXT: number; SRGB8_ALPHA8_EXT: number } | null);
  const internal = gl2 ? gl2.SRGB8_ALPHA8 : srgb ? srgb.SRGB_ALPHA_EXT : gl.RGBA;
  const format = gl2 ? gl.RGBA : srgb ? srgb.SRGB_ALPHA_EXT : gl.RGBA;

  // save state
  const prevCube = gl.getParameter(gl.TEXTURE_BINDING_CUBE_MAP) as WebGLTexture | null;
  const unpack: [number, unknown][] = [gl.UNPACK_FLIP_Y_WEBGL, gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, gl.UNPACK_ALIGNMENT].map((p) => [p, gl.getParameter(p)]);
  const unpack2: [number, number][] = gl2
    ? [gl2.UNPACK_ROW_LENGTH, gl2.UNPACK_SKIP_ROWS, gl2.UNPACK_SKIP_PIXELS].map((p) => [p, gl2.getParameter(p) as number])
    : [];
  const prevUnpackBuffer = gl2 ? (gl2.getParameter(gl2.PIXEL_UNPACK_BUFFER_BINDING) as WebGLBuffer | null) : null;

  gl.bindTexture(gl.TEXTURE_CUBE_MAP, texture);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
  if (gl2) {
    unpack2.forEach(([p]) => gl2.pixelStorei(p, 0));
    gl2.bindBuffer(gl2.PIXEL_UNPACK_BUFFER, null);
  }
  for (let i = 0; i < 6; i++) {
    gl.texImage2D(gl.TEXTURE_CUBE_MAP_POSITIVE_X + i, 0, internal, maps.size, maps.size, 0, format, gl.UNSIGNED_BYTE, faces[i]);
  }
  gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  // restore state
  unpack.forEach(([p, v]) => gl.pixelStorei(p, v as number));
  if (gl2) {
    unpack2.forEach(([p, v]) => gl2.pixelStorei(p, v));
    gl2.bindBuffer(gl2.PIXEL_UNPACK_BUFFER, prevUnpackBuffer);
  }
  gl.bindTexture(gl.TEXTURE_CUBE_MAP, prevCube);
}

/** Replace the global XRWebGLBinding with a reflection-capable subclass of IWER's. */
export function installReflectionBinding(maps: ReflectionMaps, target: Record<string, unknown> = globalThis as unknown as Record<string, unknown>): void {
  const cubes = new WeakMap<GL, CubeEntry>();

  class XRWebGLBinding extends IWERWebGLBinding {
    readonly #context: GL;
    readonly #session: XRSession;

    constructor(session: XRSession, context: GL) {
      if (!(session instanceof XRSession)) throw new TypeError('XRWebGLBinding: not an XRSession');
      if (session[P_SESSION].ended) throw new DOMException('XRSession has ended', 'InvalidStateError');
      super(session, context as WebGL2RenderingContext); // IWER types WebGL2 only; it ignores the context
      this.#context = context;
      this.#session = session;
    }

    get nativeProjectionScaleFactor(): number {
      return 1;
    }

    getReflectionCubeMap(probe: XRLightProbe): WebGLTexture | null {
      if (!(probe instanceof XRLightProbe) || probe.session !== this.#session) {
        throw new DOMException('Light probe belongs to another session', 'InvalidStateError');
      }
      if (!maps.faces) return null;
      const gl = this.#context;
      let entry = cubes.get(gl);
      if (!entry) {
        const texture = gl.createTexture();
        if (!texture) return null;
        entry = { texture, version: 0 };
        cubes.set(gl, entry);
      }
      if (entry.version !== maps.version) {
        upload(gl, entry.texture, maps);
        entry.version = maps.version;
      }
      maps.served++;
      return entry.texture;
    }
  }

  target.XRWebGLBinding = XRWebGLBinding;
}
