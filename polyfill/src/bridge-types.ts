/** Native <-> JS bridge protocol types (plan/bridge_protocol.md) and small parsing helpers. */
import type { NativeAnchorData } from './anchors.js';
import { devicePixelRatioOrOne } from './device.js';
import type { NativeHandData } from './hand-input.js';
import type { NativePlaneData } from './hittest.js';
import type { NativeEnvironment } from './reflection.js';
import type { PixelRect } from './stereo.js';
import { isRecord } from './webkit.js';

export type RenderMode = 'mono' | 'stereo';
export type TrackingState = 'normal' | 'limited' | 'notAvailable';
export type InterfaceOrientation = 'portrait' | 'portraitUpsideDown' | 'landscapeLeft' | 'landscapeRight';

export interface LightEstimate {
  ambientIntensity: number;
  ambientColorTemperature: number;
}

export interface DeviceInfo {
  model: string;
  screenWidthPx: number;
  screenHeightPx: number;
  scale: number;
  dpi: number;
}

export interface SessionReply {
  ok: boolean;
  mode?: RenderMode;
  frameRate?: number;
  error?: string;
}

export interface HitTestHit {
  pose: number[];
  type: 'plane' | 'estimated';
}

export interface FramePacket {
  t: number;
  mode: RenderMode;
  transform: Float32Array;
  view: Float32Array;
  proj: Float32Array;
  light: LightEstimate | null;
  tracking: TrackingState;
  orientation: InterfaceOrientation | undefined;
  /** Native send time, epoch ms (diagnostics). */
  sentAt: number | undefined;
  /** One-way native -> page delivery latency, ms (undefined without sentAt). */
  latencyMs: number | undefined;
}

/** The object native calls into (passed to native as a WKJSHandle). */
export interface NativeCallbacks {
  onFrame(
    t: number,
    mode: RenderMode,
    transform: ArrayLike<number>,
    view: ArrayLike<number>,
    proj: ArrayLike<number>,
    light: LightEstimate | null,
    tracking: TrackingState,
    orientation?: InterfaceOrientation,
    sentAt?: number,
  ): void;
  onTracking(tracking: TrackingState): void;
  onPlanes(planes: NativePlaneData[]): void;
  onAnchors(anchors: NativeAnchorData[]): void;
  onHands(hands: NativeHandData[]): void;
  onEnvironment(environment: NativeEnvironment): void;
  onVisibility(state: 'visible' | 'visible-blurred' | 'hidden'): void;
  onSessionEnded(reason?: string): void;
}

export const isMode = (v: unknown): v is RenderMode => v === 'mono' || v === 'stereo';

export function isTopFrame(): boolean {
  try {
    return globalThis.top === globalThis.self; // identity comparison is allowed cross-origin
  } catch {
    return false;
  }
}

export function parseDeviceInfo(v: unknown): DeviceInfo | undefined {
  if (!isRecord(v)) return undefined;
  const { model, screenWidthPx, screenHeightPx, scale, dpi } = v;
  if (typeof screenWidthPx !== 'number' || typeof screenHeightPx !== 'number') return undefined;
  return {
    model: typeof model === 'string' ? model : '',
    screenWidthPx,
    screenHeightPx,
    scale: typeof scale === 'number' ? scale : devicePixelRatioOrOne(),
    dpi: typeof dpi === 'number' ? dpi : 0,
  };
}

export function scaleRect(r: PixelRect, sx: number, sy: number): PixelRect {
  if (sx === 1 && sy === 1) return r;
  return {
    x: Math.round(r.x * sx),
    y: Math.round(r.y * sy),
    width: Math.round(r.width * sx),
    height: Math.round(r.height * sy),
  };
}
