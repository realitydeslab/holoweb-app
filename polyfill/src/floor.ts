/**
 * local-floor tracking: `local` translated down to the floor.
 *
 * Floor height = the lowest horizontal ARKit plane below the origin; before any such plane
 * exists it is DEFAULT_FLOOR_OFFSET below the origin. Once planes define it, the estimate only
 * moves down (a lower plane arrives), so losing the lowest plane does not make the floor jump up.
 * When the estimate moves by more than RESET_THRESHOLD_M, every local-floor space of the session
 * gets the new offset and a `reset` event whose transform maps the old origin to the new one.
 */
import { mat4 } from 'gl-matrix';
import { P_SPACE, XRReferenceSpace, XRReferenceSpaceEvent, XRRigidTransform } from 'iwer';
import type { NativePlaneData } from './hittest.js';

export const DEFAULT_FLOOR_OFFSET = 1.3;
export const RESET_THRESHOLD_M = 0.02;

/** Lowest horizontal plane below the origin (world y), or undefined. */
export function lowestFloorPlane(planes: readonly NativePlaneData[]): number | undefined {
  let floor: number | undefined;
  for (const plane of planes) {
    if (plane.orientation !== 'horizontal') continue;
    const y = plane.transform[13];
    if (y < 0 && (floor === undefined || y < floor)) floor = y;
  }
  return floor;
}

export class FloorTracker {
  private fromPlanes: number | undefined;
  private applied: number;
  private readonly spaces = new Set<XRReferenceSpace>();

  constructor(planes: readonly NativePlaneData[] = []) {
    this.fromPlanes = lowestFloorPlane(planes);
    this.applied = this.height;
  }

  /** Current floor height in world space (negative, metres). */
  get height(): number {
    return this.fromPlanes ?? -DEFAULT_FLOOR_OFFSET;
  }

  /** Register a local-floor space and give it the current offset. */
  track(space: XRReferenceSpace): void {
    mat4.fromTranslation(space[P_SPACE].offsetMatrix, [0, this.applied, 0]);
    this.spaces.add(space);
  }

  /** Feed a new plane set; returns true if the spaces were moved and `reset` dispatched. */
  update(planes: readonly NativePlaneData[]): boolean {
    const lowest = lowestFloorPlane(planes);
    if (lowest !== undefined) {
      this.fromPlanes = this.fromPlanes === undefined ? lowest : Math.min(this.fromPlanes, lowest);
    }
    const next = this.height;
    const delta = next - this.applied;
    if (Math.abs(delta) <= RESET_THRESHOLD_M) return false;
    this.applied = next;
    for (const space of this.spaces) {
      mat4.fromTranslation(space[P_SPACE].offsetMatrix, [0, next, 0]);
      // Pose of the new origin in the previous local-floor space.
      const transform = new XRRigidTransform({ x: 0, y: delta, z: 0, w: 1 });
      space.dispatchEvent(new XRReferenceSpaceEvent('reset', { referenceSpace: space, transform }));
    }
    return true;
  }
}
