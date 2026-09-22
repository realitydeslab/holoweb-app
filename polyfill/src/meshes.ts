/**
 * WebXR Mesh Detection ('mesh-detection') over ARKit scene reconstruction (ARMeshAnchor, LiDAR)
 * from native `bridge.onMeshes({ meshes, removed })` (<= 2 Hz, changed meshes only).
 *
 * One IWER XRMesh per native id, reused while it lives (pages key their geometry by the object).
 * meshSpace follows `transform` in place; vertices (Float32Array xyz, mesh-local) and indices
 * (Uint32Array triangle list) are replaced when native sends new geometry (an entry without geometry
 * is a transform-only update); lastChangedTime changes only with the geometry or native `lastChanged`,
 * so pages rebuild only what changed. semanticLabel is the optional ARKit classification.
 * Each XR frame of a session with the feature gets every live mesh in frame.detectedMeshes.
 */
import { mat4 } from 'gl-matrix';
import { P_DEVICE, P_FRAME, P_MESH, P_SPACE, XRDevice, XRMesh, XRSpace } from 'iwer';
import type { XRSemanticLabels } from 'iwer/lib/labels/labels.js';
import { decodeBase64 } from './base64.js';

export interface NativeMeshData {
  id: string | number;
  transform: ArrayLike<number>;
  /** base64 Float32 xyz, mesh-local metres. */
  vertices?: string;
  /** base64 Uint32 triangle list. */
  indices?: string;
  lastChanged?: number;
  semanticLabel?: string;
}

export interface NativeMeshUpdate {
  meshes?: NativeMeshData[];
  removed?: (string | number)[];
}

function float32(b64: string): Float32Array | null {
  const bytes = decodeBase64(b64);
  return bytes.byteLength % 12 === 0 ? new Float32Array(bytes.buffer) : null;
}

function uint32(b64: string): Uint32Array | null {
  const bytes = decodeBase64(b64);
  return bytes.byteLength % 12 === 0 ? new Uint32Array(bytes.buffer) : null;
}

interface Tracked {
  mesh: XRMesh;
  lastChanged: number | undefined;
}

export class MeshTracking {
  private readonly byId = new Map<string, Tracked>();

  constructor(private readonly device: XRDevice) {
    const state = device[P_DEVICE];
    const frameStart = state.onFrameStart;
    state.onFrameStart = (frame) => {
      frameStart(frame);
      if (!frame.session.enabledFeatures.includes('mesh-detection')) return;
      const detected = frame[P_FRAME].detectedMeshes;
      for (const { mesh } of this.byId.values()) {
        mesh[P_MESH].frame = frame;
        detected.add(mesh);
      }
    };
  }

  get count(): number {
    return this.byId.size;
  }

  update(update: NativeMeshUpdate): void {
    const now = performance.now();
    for (const data of update?.meshes ?? []) {
      const id = String(data.id);
      const tracked = this.byId.get(id);
      const vertices = data.vertices ? float32(data.vertices) : null;
      const indices = data.indices ? uint32(data.indices) : null;
      const label = data.semanticLabel as XRSemanticLabels | undefined;
      if (!tracked) {
        if (!vertices || !indices) continue; // a new mesh needs geometry
        const space = new XRSpace(this.device[P_DEVICE].globalSpace, Float32Array.from(data.transform));
        const mesh = new XRMesh(undefined as never, space, vertices, indices, label);
        mesh[P_MESH].lastChangedTime = now;
        this.byId.set(id, { mesh, lastChanged: data.lastChanged });
        continue;
      }
      const state = tracked.mesh[P_MESH];
      mat4.copy(state.meshSpace[P_SPACE].offsetMatrix, data.transform as unknown as mat4);
      const geometry = vertices !== null && indices !== null;
      if (geometry) {
        state.vertices = vertices;
        state.indices = indices;
      }
      if (label !== undefined) state.semanticLabel = label;
      if (geometry || data.lastChanged !== tracked.lastChanged) {
        state.lastChangedTime = now;
        tracked.lastChanged = data.lastChanged;
      }
    }
    for (const id of update?.removed ?? []) this.byId.delete(String(id));
  }

  /** Session ended: meshes are per ARSession. */
  clear(): void {
    this.byId.clear();
  }
}
