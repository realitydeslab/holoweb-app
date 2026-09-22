// @vitest-environment happy-dom
// Device gap: the immersive-web hands samples entered VR without hand-tracking. With native's ready
// reporting capabilities.sceneDepth, an immersive-vr session asking for optional 'hand-tracking' is
// granted it, native's requestSession carries it (so the Vision tracker starts), and onHands arrives.
import { mat4 } from 'gl-matrix';
import { beforeAll, describe, expect, it } from 'vitest';
import type { HoloWebGlobal } from '../src/index.js';
import { mockHand } from '../src/mock-hands.js';

type Msg = Record<string, unknown> & { type: string };
interface Session {
  enabledFeatures: string[];
  environmentBlendMode: string;
  inputSources: { hand: Map<string, unknown> | null; handedness: string }[];
  updateRenderState(s: Record<string, unknown>): void;
  requestReferenceSpace(t: string): Promise<unknown>;
  requestAnimationFrame(cb: (t: number, f: unknown) => void): number;
  end(): Promise<void>;
}
const g = globalThis as unknown as Record<string, unknown>;
let hw: HoloWebGlobal;
const posted: Msg[] = [];
const xr = () => (navigator as unknown as { xr: { requestSession(m: string, i?: object): Promise<Session> } }).xr;
const nextFrame = (s: Session) => new Promise<void>((r) => s.requestAnimationFrame(() => r()));

beforeAll(async () => {
  g.WebGL2RenderingContext = class {};
  g.webkit = {
    messageHandlers: {
      holoweb: {
        postMessage: (m: Msg) => {
          posted.push(m);
          // native commit 1ea696e: sceneDepth alongside the protocol's names
          if (m.type === 'ready') return Promise.resolve({ ok: true, capabilities: { lidar: true, sceneReconstruction: true, sceneDepth: true } });
          return Promise.resolve(m.type === 'requestSession' ? { ok: true, mode: 'mono' } : { ok: true });
        },
      },
    },
  };
  await import('../src/index.js');
  hw = g.__holoweb as HoloWebGlobal;
});

describe('immersive-vr + hand-tracking', () => {
  it('grants optional hand-tracking with capabilities.sceneDepth, tells native, and receives onHands', async () => {
    // the samples' own request: immersive-vr, optionalFeatures ['local-floor', 'hand-tracking']
    const session = await xr().requestSession('immersive-vr', { optionalFeatures: ['local-floor', 'hand-tracking'] });
    try {
      expect(posted.some((m) => m.type === 'ready')).toBe(true);
      expect(session.enabledFeatures).toContain('hand-tracking');
      expect(session.environmentBlendMode).toBe('opaque');
      const request = posted.filter((m) => m.type === 'requestSession').at(-1)!;
      expect(request).toMatchObject({ mode: 'immersive-vr' });
      expect(request.features).toContain('hand-tracking');

      session.updateRenderState({ layers: [{}] });
      hw.onFrame(performance.now(), 'mono', Array.from(mat4.create()), Array.from(mat4.create()), Array.from(mat4.perspective(mat4.create(), 1, 2, 0.01, 100)), null, 'normal');
      await nextFrame(session);
      hw.onHands({ t: 1000, hands: [mockHand(mat4.create(), 1200)] });
      await nextFrame(session);
      const hands = session.inputSources.filter((s) => s.hand);
      expect(hands.map((s) => s.handedness)).toEqual(['right']);
      expect(hands[0].hand!.size).toBe(25);
    } finally {
      await session.end();
    }
  });
});
