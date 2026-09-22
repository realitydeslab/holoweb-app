// @vitest-environment happy-dom
// G9 mesh-detection over bridge.onMeshes, G13 capabilities from the ready reply.
import { mat4 } from 'gl-matrix';
import { beforeAll, describe, expect, it } from 'vitest';
import { featuresFor } from '../src/device.js';
import type { HoloWebGlobal } from '../src/index.js';
import { mockMeshes } from '../src/mock-environment.js';

type Msg = Record<string, unknown> & { type: string };
interface Mesh { meshSpace: unknown; vertices: Float32Array; indices: Uint32Array; lastChangedTime: number; semanticLabel?: string }
interface Frame { detectedMeshes: Set<Mesh>; getPose(s: unknown, b: unknown): { transform: { matrix: Float32Array } } | null }
interface Session {
  enabledFeatures: string[];
  updateRenderState(s: Record<string, unknown>): void;
  requestReferenceSpace(t: string): Promise<unknown>;
  requestAnimationFrame(cb: (t: number, f: Frame) => void): number;
  end(): Promise<void>;
}
let hw: HoloWebGlobal;
const xr = () => (navigator as unknown as { xr: { requestSession(m: string, i?: object): Promise<Session> } }).xr;
const inFrame = <T>(s: Session, fn: (f: Frame) => T) =>
  new Promise<T>((resolve, reject) => s.requestAnimationFrame((_t, f) => { try { resolve(fn(f)); } catch (e) { reject(e); } }));

beforeAll(async () => {
  (globalThis as Record<string, unknown>).WebGL2RenderingContext = class {};
  (globalThis as Record<string, unknown>).webkit = {
    messageHandlers: {
      holoweb: {
        postMessage: (m: Msg) =>
          Promise.resolve(
            m.type === 'ready'
              ? { ok: true, capabilities: { sceneReconstruction: true, sceneDepth: true } }
              : m.type === 'requestSession' ? { ok: true, mode: 'mono' } : { ok: true },
          ),
      },
    },
  };
  await import('../src/index.js');
  hw = (globalThis as unknown as { __holoweb: HoloWebGlobal }).__holoweb;
  hw.onFrame(1, 'mono', Array.from(mat4.create()), Array.from(mat4.create()), Array.from(mat4.perspective(mat4.create(), 1, 2, 0.01, 100)), null, 'normal');
});

describe('capabilities (G13)', () => {
  it('advertises mesh-detection only with scene reconstruction, hand-tracking only with scene depth', () => {
    expect(featuresFor({ sceneReconstruction: false, sceneDepth: false })).not.toContain('mesh-detection');
    expect(featuresFor({ sceneReconstruction: false, sceneDepth: false })).not.toContain('hand-tracking');
    const lidar = featuresFor({ sceneReconstruction: true, sceneDepth: true });
    expect(lidar).toContain('mesh-detection');
    expect(lidar).toContain('hand-tracking');
  });

  it('grants a required mesh-detection once ready reports LiDAR', async () => {
    const session = await xr().requestSession('immersive-ar', { requiredFeatures: ['mesh-detection'] });
    expect(session.enabledFeatures).toContain('mesh-detection');
    await session.end();
  });
});

describe("'mesh-detection': frame.detectedMeshes", () => {
  it('exposes stable XRMesh objects with typed geometry, updating in place', async () => {
    const session = await xr().requestSession('immersive-ar', { requiredFeatures: ['mesh-detection'] });
    try {
      session.updateRenderState({ layers: [{}] });
      const local = await session.requestReferenceSpace('local');
      hw.onMeshes(mockMeshes(false, 0) as never);
      const first = await inFrame(session, (f) => [...f.detectedMeshes]);
      expect(first).toHaveLength(2);
      const table = first.find((m) => m.semanticLabel === 'table')!;
      expect(table.vertices).toBeInstanceOf(Float32Array);
      expect(table.vertices).toHaveLength(24); // 8 vertices xyz
      expect(table.indices).toBeInstanceOf(Uint32Array);
      expect(table.indices).toHaveLength(36); // 12 triangles
      const pose = await inFrame(session, (f) => f.getPose(table.meshSpace, local)!.transform.matrix);
      expect([pose[12], pose[13], pose[14]].map((v) => +v.toFixed(3))).toEqual([-0.5, -0.6, -1.5]);

      const t0 = table.lastChangedTime;
      const floor = first.find((m) => m.semanticLabel === 'floor')!;
      const f0 = floor.lastChangedTime;
      await new Promise((r) => setTimeout(r, 5));
      const grown = mockMeshes(true, 1234); // table geometry changes; floor is not in this update
      hw.onMeshes(grown as never);
      const second = await inFrame(session, (f) => [...f.detectedMeshes]);
      expect(new Set(second)).toEqual(new Set(first)); // same objects
      expect(table.lastChangedTime).toBeGreaterThan(t0);
      expect(Math.max(...Array.from(table.vertices).filter((_, i) => i % 3 === 0))).toBeCloseTo(0.4, 5); // 0.8 m wide now
      expect(floor.lastChangedTime).toBe(f0);

      // transform-only update: geometry and lastChangedTime stay
      const moved = { id: 'mesh-table', transform: Array.from(mat4.fromTranslation(mat4.create(), [0, -0.6, -1.5])), lastChanged: 1234 };
      const t1 = table.lastChangedTime;
      const v1 = table.vertices;
      hw.onMeshes({ meshes: [moved] } as never);
      const movedPose = await inFrame(session, (f) => f.getPose(table.meshSpace, local)!.transform.matrix);
      expect(movedPose[12]).toBeCloseTo(0, 5);
      expect(table.vertices).toBe(v1);
      expect(table.lastChangedTime).toBe(t1);

      hw.onMeshes({ removed: ['mesh-floor'] } as never);
      expect(await inFrame(session, (f) => f.detectedMeshes.size)).toBe(1);
    } finally {
      await session.end();
    }
  });

  it('is empty for sessions without the feature', async () => {
    const session = await xr().requestSession('immersive-ar');
    try {
      session.updateRenderState({ layers: [{}] });
      hw.onMeshes(mockMeshes(false, 0) as never);
      expect(await inFrame(session, (f) => f.detectedMeshes.size)).toBe(0);
    } finally {
      await session.end();
    }
  });
});
