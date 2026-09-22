/**
 * WebXR Plane Detection ('plane-detection') over ARKit planes from bridge.onPlanes.
 *
 * One IWER XRPlane per native plane id, reused while the plane lives (three.js' XRPlanes keys its
 * meshes by the XRPlane object). Per plane: planeSpace pose = plane transform (+Y = normal),
 * polygon = DOMPointReadOnly[] in plane space (from `polygon`, or the extent rectangle for older
 * native builds), orientation, and lastChangedTime (performance.now() when native's `lastChanged`
 * or the geometry changed). Each XR frame of a session with the feature gets every live plane in
 * frame.detectedPlanes. The same plane data also feeds the JS hit test (hittest.ts).
 */
import { mat4 } from 'gl-matrix';
import { P_DEVICE, P_FRAME, P_PLANE, P_SPACE, XRDevice, XRPlane, XRSpace } from 'iwer';
import { XRPlaneOrientation } from 'iwer/lib/planes/XRPlane.js';
import type { NativePlaneData } from './hittest.js';

/** Plane-space outline: native polygon, or the extent rectangle (counter-clockwise seen from +Y). */
export function planePolygon(plane: NativePlaneData): number[] {
  const p = plane.polygon;
  if (p && p.length >= 9 && p.length % 3 === 0) return Array.from(p);
  const hx = plane.extent[0] / 2;
  const hz = plane.extent[1] / 2;
  return [-hx, 0, -hz, -hx, 0, hz, hx, 0, hz, hx, 0, -hz];
}

function sameNumbers(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

interface Tracked {
  plane: XRPlane;
  transform: Float32Array;
  outline: number[];
  lastChanged: number | undefined;
}

export class PlaneTracking {
  private readonly byId = new Map<string, Tracked>();

  constructor(private readonly device: XRDevice) {
    const state = device[P_DEVICE];
    const frameStart = state.onFrameStart;
    state.onFrameStart = (frame) => {
      frameStart(frame);
      if (!frame.session.enabledFeatures.includes('plane-detection')) return;
      const detected = frame[P_FRAME].detectedPlanes;
      for (const { plane } of this.byId.values()) {
        plane[P_PLANE].frame = frame;
        detected.add(plane);
      }
    };
  }

  get count(): number {
    return this.byId.size;
  }

  /** Apply a full native plane set (planes missing from it are gone). */
  update(list: readonly NativePlaneData[]): void {
    const seen = new Set<string>();
    const now = performance.now();
    for (const data of list) {
      const id = String(data.id);
      seen.add(id);
      const transform = Float32Array.from(data.transform);
      const outline = planePolygon(data);
      const orientation = data.orientation === 'vertical' ? XRPlaneOrientation.Vertical : XRPlaneOrientation.Horizontal;
      const tracked = this.byId.get(id);
      if (!tracked) {
        const space = new XRSpace(this.device[P_DEVICE].globalSpace, transform);
        const plane = new XRPlane(undefined as never, space, toPoints(outline));
        plane[P_PLANE].orientation = orientation;
        plane[P_PLANE].lastChangedTime = now;
        this.byId.set(id, { plane, transform, outline, lastChanged: data.lastChanged });
        continue;
      }
      const changed =
        data.lastChanged !== tracked.lastChanged || !sameNumbers(transform, tracked.transform) || !sameNumbers(outline, tracked.outline);
      if (!changed) continue;
      const state = tracked.plane[P_PLANE];
      mat4.copy(state.planeSpace[P_SPACE].offsetMatrix, transform as unknown as mat4);
      state.polygon = toPoints(outline);
      state.orientation = orientation;
      state.lastChangedTime = now;
      Object.assign(tracked, { transform, outline, lastChanged: data.lastChanged });
    }
    for (const id of [...this.byId.keys()]) if (!seen.has(id)) this.byId.delete(id);
  }

  /** Session ended: planes are per ARSession. */
  clear(): void {
    this.byId.clear();
  }
}

function toPoints(outline: readonly number[]): DOMPointReadOnly[] {
  const points: DOMPointReadOnly[] = [];
  for (let i = 0; i + 2 < outline.length; i += 3) points.push(new DOMPointReadOnly(outline[i], outline[i + 1], outline[i + 2], 1));
  return points;
}
