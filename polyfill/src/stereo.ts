/**
 * HoloKit X stereo math, ported from holokit-unity-sdk
 * Runtime/HoloKitCameraManager.cs SetupCameraData() and Runtime/DeviceProfile.cs.
 *
 * Conventions:
 * - Projection matrices are column-major Float32Array(16), OpenGL/WebXR clip space
 *   (Unity camera projection matrices use the same convention). Unity P[r,c] maps to index c*4+r.
 * - Viewport rects are framebuffer pixels with a bottom-left origin (WebGL / Unity Camera.rect),
 *   for a landscape canvas that fills the whole screen at native resolution.
 * - cameraToCenterEye is in WebXR camera space (x right, y up, z towards the user), i.e. the
 *   Unity offset CameraOffset + MrOffset with z negated.
 */
import type { PhoneModel, Vec3 } from './phones.js';

export const INCH_TO_METER = 0.0254;

/** HoloKit X optics (DeviceProfile.GetHoloKitModelSpecs, metres). */
export const HOLOKIT_X = {
  opticalAxisDistance: 0.064,
  mrOffset: [0, -0.02894, -0.07055] as Vec3,
  viewportInner: 0.0292,
  viewportOuter: 0.0292,
  viewportTop: 0.02386,
  viewportBottom: 0.02386,
  lensToEye: 0.02497 + 0.03898,
  axisToBottom: 0.0299,
  alignmentMarkerOffset: 0.05075,
} as const;

export const IPD_MIN = 0.054;
export const IPD_MAX = 0.074;
export const IPD_DEFAULT = 0.064;

export interface PixelRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface EyeParams {
  projection: Float32Array;
  viewport: PixelRect;
}

export interface StereoParams {
  left: EyeParams;
  right: EyeParams;
  cameraToCenterEye: [number, number, number];
}

export interface ScreenPx {
  /** Framebuffer width in pixels (long side for landscape). */
  w: number;
  /** Framebuffer height in pixels. */
  h: number;
  /** Device pixel ratio (framebuffer px per CSS px). Informational. */
  scale: number;
}

/** Rewrite entries [10] and [14] of a GL projection for a new depth range (in place). */
export function applyDepthRange(m: Float32Array, near: number, far: number): Float32Array {
  if (far === Infinity) {
    m[10] = -1;
    m[14] = -2 * near;
  } else {
    m[10] = -(far + near) / (far - near);
    m[14] = (-2 * far * near) / (far - near);
  }
  return m;
}

/**
 * Compute per-eye projection matrices, viewport rects and the camera -> centre-eye offset.
 *
 * The frustum shape uses the HoloKit LensToEye distance (as the Unity SDK does); `near`/`far`
 * only set the depth mapping, so any renderState depth range can be applied afterwards.
 */
export function computeStereo(
  phone: PhoneModel,
  screenPx: ScreenPx,
  ipd: number,
  near: number,
  far: number,
): StereoParams {
  const hk = HOLOKIT_X;
  const [resX, resY] = phone.screenResolution;
  const useRuntime = resX === 0 && resY === 0;
  const screenWidthPx = useRuntime ? Math.max(screenPx.w, screenPx.h) : resX;
  const screenHeightPx = useRuntime ? Math.min(screenPx.w, screenPx.h) : resY;
  const screenWidthM = (screenWidthPx / phone.screenDpi) * INCH_TO_METER;
  const screenHeightM = (screenHeightPx / phone.screenDpi) * INCH_TO_METER;

  const viewportWidthM = hk.viewportInner + hk.viewportOuter;
  const viewportHeightM = hk.viewportTop + hk.viewportBottom;
  const lensToEye = hk.lensToEye;
  const fullWidthM = hk.opticalAxisDistance + 2 * hk.viewportOuter;
  const gapM = fullWidthM - 2 * viewportWidthM;

  const left = new Float32Array(16);
  left[0] = (2 * lensToEye) / viewportWidthM; // P[0,0]
  left[5] = (2 * lensToEye) / viewportHeightM; // P[1,1]
  left[8] = (ipd - viewportWidthM - gapM) / viewportWidthM; // P[0,2]
  left[11] = -1; // P[3,2]
  applyDepthRange(left, near, far); // P[2,2], P[2,3]
  const right = new Float32Array(left);
  right[8] = -left[8];

  // Normalised viewport rects (Unity Camera.rect, origin bottom-left).
  const fullWidth = fullWidthM / screenWidthM;
  const width = viewportWidthM / screenWidthM;
  const height = viewportHeightM / screenHeightM;
  const centerX = 0.5;
  const centerY =
    phone.viewportBottomOffset !== 0 || phone.screenBottomBorder === 0
      ? (phone.viewportBottomOffset + viewportHeightM / 2) / screenHeightM
      : (hk.axisToBottom - phone.screenBottomBorder) / screenHeightM;
  const xMinLeft = centerX - fullWidth / 2;
  const xMinRight = centerX + fullWidth / 2 - width;
  const yMin = centerY - height / 2;

  const fbW = Math.max(screenPx.w, screenPx.h);
  const fbH = Math.min(screenPx.w, screenPx.h);
  const toPx = (xMin: number): PixelRect => ({
    x: Math.round(xMin * fbW),
    y: Math.round(yMin * fbH),
    width: Math.round(width * fbW),
    height: Math.round(height * fbH),
  });

  const c = phone.cameraOffset;
  const m = hk.mrOffset;
  return {
    left: { projection: left, viewport: toPx(xMinLeft) },
    right: { projection: right, viewport: toPx(xMinRight) },
    cameraToCenterEye: [c[0] + m[0], c[1] + m[1], -(c[2] + m[2])],
  };
}

export function clampIpd(ipd: number): number {
  return Math.min(IPD_MAX, Math.max(IPD_MIN, ipd));
}

/**
 * How the fixed framebuffer sits relative to HoloKit's physical landscape (UIKit landscapeRight:
 * device top to the left). Stereo no longer rotates the interface, so a session started in
 * portrait keeps a portrait framebuffer; the eyes are laid out in physical landscape and then
 * turned into it.
 * - 0: landscapeRight framebuffer, nothing to do.
 * - 90: portrait framebuffer. Landscape (X right, Y up) -> portrait x = Y, y = H - X.
 * - 180: landscapeLeft framebuffer, upside down relative to HoloKit.
 */
export type FramebufferTurn = 0 | 90 | 180;

export function framebufferTurn(fb: { width: number; height: number }, orientation?: string): FramebufferTurn {
  if (fb.height > fb.width) return 90;
  return orientation === 'landscapeLeft' ? 180 : 0;
}

/** Map a landscape eye viewport (bottom-left origin) into the framebuffer (`fb` = its real size). */
export function turnRect(r: PixelRect, fb: { width: number; height: number }, turn: FramebufferTurn): PixelRect {
  if (turn === 90) return { x: r.y, y: fb.height - r.x - r.width, width: r.height, height: r.width };
  if (turn === 180) return { x: fb.width - r.x - r.width, y: fb.height - r.y - r.height, width: r.width, height: r.height };
  return r;
}

/** Clip-space turn applied after a landscape projection: NDC (u, v) -> (v, -u) or (-u, -v). */
export function turnProjection(p: Float32Array, turn: FramebufferTurn): Float32Array {
  if (turn === 0) return p;
  const out = new Float32Array(p);
  for (let c = 0; c < 4; c++) {
    const x = p[c * 4];
    const y = p[c * 4 + 1];
    out[c * 4] = turn === 90 ? y : -x;
    out[c * 4 + 1] = turn === 90 ? -x : -y;
  }
  return out;
}

/**
 * Column-major rotation taking the display-oriented camera frame of the framebuffer's orientation
 * to HoloKit's landscape camera frame (x = viewer right, y = viewer up): cam * this.
 * Portrait camera: x = device right, y = device top; in landscapeRight the viewer's right is the
 * device bottom and up is the device right.
 */
export function turnCameraBasis(turn: FramebufferTurn): Float32Array {
  const m = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  if (turn === 90) m.set([0, -1, 0, 0, 1, 0, 0, 0]);
  if (turn === 180) m.set([-1, 0, 0, 0, 0, -1, 0, 0]);
  return m;
}
