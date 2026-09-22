/**
 * JS-side hit testing against the ARKit plane set received through bridge.onPlanes.
 *
 * IWER routes XRSession.requestHitTestSource / XRFrame.getHitTestResults through its
 * Synthetic Environment Module (SEM) interface: every frame it calls
 * sem.computeHitTestResults(rayMatrix) for each hit-test source. PlaneEnvironment
 * implements that interface over the latest ARKit planes, so hit-test results are
 * produced synchronously inside the XR frame with zero native round trips.
 *
 * Precise one-shot raycasts (ARSession.raycast) go through the native `hitTest`
 * message instead, see HoloWebBridge.hitTest (one IPC round trip, ~1 frame).
 */
import { mat4, vec3 } from 'gl-matrix';
import type { NativeMesh, NativePlane, XRDevice } from 'iwer';
import type { SyntheticEnvironmentModule } from 'iwer/lib/device/XRDevice.js';
import type { DepthSensingData } from 'iwer/lib/depth/XRDepthInformation.js';

export interface NativePlaneData {
  id: string | number;
  /** Plane centre pose in ARKit world, column-major; local +Y is the plane normal. */
  transform: ArrayLike<number>;
  /** Plane size along local X and Z, metres. */
  extent: [number, number] | ArrayLike<number>;
  orientation: 'horizontal' | 'vertical';
  /** Outline in plane space: flat x, y (= 0), z triples, counter-clockwise seen from +Y. */
  polygon?: ArrayLike<number>;
  /** Native timestamp (ms) of the plane's last update. */
  lastChanged?: number;
}

/** Point-in-polygon on the plane's local XZ outline (even-odd rule). */
export function insideOutline(x: number, z: number, outline: ArrayLike<number>): boolean {
  let inside = false;
  const n = Math.floor(outline.length / 3);
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = outline[i * 3], zi = outline[i * 3 + 2];
    const xj = outline[j * 3], zj = outline[j * 3 + 2];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

export interface Hit {
  distance: number;
  matrix: mat4;
  planeId: string | number;
}

const EPS = 1e-6;
const scratch = {
  origin: vec3.create(),
  dir: vec3.create(),
  normal: vec3.create(),
  xAxis: vec3.create(),
  zAxis: vec3.create(),
  center: vec3.create(),
  hit: vec3.create(),
  rel: vec3.create(),
};

function column(out: vec3, m: ArrayLike<number>, c: number): vec3 {
  return vec3.set(out, m[c * 4], m[c * 4 + 1], m[c * 4 + 2]);
}

/** Intersect a world-space ray with finite planes; nearest hit first. */
export function raycastPlanes(
  origin: ArrayLike<number>,
  direction: ArrayLike<number>,
  planes: readonly NativePlaneData[],
): Hit[] {
  const o = vec3.set(scratch.origin, origin[0], origin[1], origin[2]);
  const d = vec3.normalize(scratch.dir, vec3.set(scratch.dir, direction[0], direction[1], direction[2]));
  const hits: Hit[] = [];
  for (const plane of planes) {
    const m = plane.transform;
    const n = vec3.normalize(scratch.normal, column(scratch.normal, m, 1));
    const c = column(scratch.center, m, 3);
    const denom = vec3.dot(d, n);
    if (Math.abs(denom) < EPS) continue;
    const t = vec3.dot(vec3.subtract(scratch.rel, c, o), n) / denom;
    if (t <= 0) continue;
    const h = vec3.scaleAndAdd(scratch.hit, o, d, t);
    vec3.subtract(scratch.rel, h, c);
    const x = vec3.normalize(scratch.xAxis, column(scratch.xAxis, m, 0));
    const z = vec3.normalize(scratch.zAxis, column(scratch.zAxis, m, 2));
    const lx = vec3.dot(scratch.rel, x);
    const lz = vec3.dot(scratch.rel, z);
    if (plane.polygon && plane.polygon.length >= 9) {
      if (!insideOutline(lx, lz, plane.polygon)) continue;
    } else if (Math.abs(lx) > plane.extent[0] / 2 || Math.abs(lz) > plane.extent[1] / 2) {
      continue;
    }
    // Pose: plane orientation (Y = normal) at the hit point.
    const out = mat4.fromValues(
      x[0], x[1], x[2], 0,
      n[0], n[1], n[2], 0,
      z[0], z[1], z[2], 0,
      h[0], h[1], h[2], 1,
    );
    hits.push({ distance: t, matrix: out, planeId: plane.id });
  }
  return hits.sort((a, b) => a.distance - b.distance);
}

/** Ray origin and direction from an IWER ray matrix (origin = translation, direction = -Z). */
export function rayFromMatrix(rayMatrix: mat4): { origin: vec3; direction: vec3 } {
  const origin = vec3.fromValues(rayMatrix[12], rayMatrix[13], rayMatrix[14]);
  const direction = vec3.fromValues(-rayMatrix[8], -rayMatrix[9], -rayMatrix[10]);
  return { origin, direction: vec3.normalize(direction, direction) };
}

/** IWER SEM backed by ARKit planes. Only hit testing is implemented. */
export class PlaneEnvironment implements SyntheticEnvironmentModule {
  readonly version = 'holoweb-planes-1';
  planesVisible = false;
  boundingBoxesVisible = false;
  meshesVisible = false;
  private planes: NativePlaneData[] = [];
  private readonly canvas: HTMLCanvasElement;
  private readonly emptyPlanes = new Set<NativePlane>();
  private readonly emptyMeshes = new Set<NativeMesh>();

  constructor(_device?: XRDevice) {
    // IWER appends this canvas to its container during a session; keep it inert.
    this.canvas = document.createElement('canvas');
    this.canvas.width = 1;
    this.canvas.height = 1;
    this.canvas.style.display = 'none';
  }

  setPlanes(planes: readonly NativePlaneData[]): void {
    this.planes = planes.slice();
  }

  get planeData(): readonly NativePlaneData[] {
    return this.planes;
  }

  get environmentCanvas(): HTMLCanvasElement {
    return this.canvas;
  }

  // plane-detection is not advertised, so IWER never reads these sets
  get trackedPlanes(): Set<NativePlane> {
    return this.emptyPlanes;
  }

  get trackedMeshes(): Set<NativeMesh> {
    return this.emptyMeshes;
  }

  render(_time: number): void {}
  loadEnvironment(_json: unknown): void {}
  loadDefaultEnvironment(_envId: string): void {}

  deleteAll(): void {
    this.planes = [];
  }

  /** Hit-test queries that returned at least one hit (diagnostics). */
  hitQueries = 0;

  computeHitTestResults(rayMatrix: mat4): mat4[] {
    const { origin, direction } = rayFromMatrix(rayMatrix);
    const hits = raycastPlanes(origin, direction, this.planes).map((h) => h.matrix);
    if (hits.length > 0) this.hitQueries++;
    return hits;
  }

  computeDepthBuffer(): DepthSensingData | null {
    return null;
  }
}
