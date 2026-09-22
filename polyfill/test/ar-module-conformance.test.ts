// @vitest-environment happy-dom
// WebXR Augmented Reality Module - Level 1 (https://immersive-web.github.io/webxr-ar-module/),
// normative items checked against the polyfill. See README "WebXR AR Module conformance".
import { mat4 } from 'gl-matrix';
import { beforeAll, describe, expect, it } from 'vitest';
import type { HoloWebGlobal } from '../src/index.js';

type Msg = Record<string, unknown> & { type: string };
interface View { eye: string; isFirstPersonObserver: boolean }
interface Source { targetRayMode: string; profiles: string[]; handedness: string; gripSpace?: unknown; gamepad?: unknown; hand?: unknown }
interface Frame { getViewerPose(space: unknown): { views: View[] } }
interface Session extends EventTarget {
  environmentBlendMode: string;
  interactionMode: string;
  enabledFeatures: string[];
  inputSources: Source[];
  updateRenderState(s: Record<string, unknown>): void;
  requestReferenceSpace(t: string): Promise<unknown>;
  requestAnimationFrame(cb: (t: number, f: Frame) => void): number;
  end(): Promise<void>;
}
interface XR {
  isSessionSupported(mode: string): Promise<boolean>;
  requestSession(mode: string, init?: object): Promise<Session>;
}
let hw: HoloWebGlobal;
const posted: Msg[] = [];
const xr = () => (navigator as unknown as { xr: XR }).xr;
const inFrame = <T>(s: Session, fn: (f: Frame) => T = () => undefined as T) =>
  new Promise<T>((resolve, reject) => s.requestAnimationFrame((_t, f) => { try { resolve(fn(f)); } catch (e) { reject(e); } }));
const pose = mat4.fromTranslation(mat4.create(), [0, 1.4, 0]);
const push = (mode: 'mono' | 'stereo') =>
  hw.onFrame(performance.now(), mode, Array.from(pose), Array.from(mat4.invert(mat4.create(), pose)!), Array.from(mat4.perspective(mat4.create(), 1, 0.5, 0.01, 100)), null, 'normal');

async function start(init: object = {}): Promise<{ session: Session; local: unknown }> {
  const session = await xr().requestSession('immersive-ar', init);
  session.updateRenderState({ layers: [{}] });
  push('mono');
  const local = await session.requestReferenceSpace('local');
  await inFrame(session);
  return { session, local };
}

beforeAll(async () => {
  (globalThis as Record<string, unknown>).WebGL2RenderingContext = class {};
  (globalThis as Record<string, unknown>).webkit = {
    messageHandlers: {
      holoweb: {
        postMessage: (m: Msg) => {
          posted.push(m);
          return Promise.resolve(m.type === 'requestSession' ? { ok: true, mode: 'mono' } : { ok: true });
        },
      },
    },
  };
  await import('../src/index.js');
  hw = (globalThis as unknown as { __holoweb: HoloWebGlobal }).__holoweb;
});

describe('WebXR AR Module conformance', () => {
  it('XRSessionMode: immersive-ar is a supported XRSessionMode (immersive-vr too, as opaque VR)', async () => {
    await expect(xr().isSessionSupported('immersive-ar')).resolves.toBe(true);
    await expect(xr().isSessionSupported('immersive-vr')).resolves.toBe(true);
    const { session } = await start();
    await session.end();
  });

  it("XREnvironmentBlendMode: an immersive-vr session is 'opaque' in mono and stereo, and native is told the mode", async () => {
    const session = await xr().requestSession('immersive-vr');
    try {
      session.updateRenderState({ layers: [{}] });
      push('mono');
      await inFrame(session);
      const modes = [session.environmentBlendMode, session.interactionMode];
      push('stereo');
      await inFrame(session);
      modes.push(session.environmentBlendMode, session.interactionMode);
      expect(modes).toEqual(['opaque', 'screen-space', 'opaque', 'world-space']);
      expect(posted.filter((m) => m.type === 'requestSession').at(-1)).toMatchObject({ mode: 'immersive-vr' });
    } finally {
      push('mono');
      await session.end();
    }
  });

  it('XREnvironmentBlendMode: environmentBlendMode reports the compositor: alpha-blend in mono, additive in HoloKit stereo, following mid-session toggles', async () => {
    const { session } = await start();
    try {
      const modes: string[] = [session.environmentBlendMode];
      for (const mode of ['stereo', 'mono', 'stereo'] as const) {
        push(mode);
        await inFrame(session);
        modes.push(session.environmentBlendMode);
      }
      expect(modes).toEqual(['alpha-blend', 'additive', 'alpha-blend', 'additive']);
      expect(modes.every((m) => ['opaque', 'alpha-blend', 'additive'].includes(m))).toBe(true);
      expect(modes).not.toContain('opaque'); // an immersive-ar session never reports opaque
    } finally {
      push('mono');
      await session.end();
    }
  });

  it('XRInteractionMode: interactionMode: screen-space in mono (transient screen input), world-space in stereo (gaze)', async () => {
    const { session } = await start();
    try {
      const modes = [session.interactionMode];
      push('stereo');
      await inFrame(session);
      modes.push(session.interactionMode);
      push('mono');
      await inFrame(session);
      modes.push(session.interactionMode);
      expect(modes).toEqual(['screen-space', 'world-space', 'screen-space']);
    } finally {
      await session.end();
    }
  });

  it('First-person observer: XRView.isFirstPersonObserver exists and is false on every view (mono, stereo, inert view after stereo)', async () => {
    const { session, local } = await start();
    try {
      const all: View[] = [];
      for (const mode of ['mono', 'stereo', 'mono'] as const) {
        push(mode);
        await inFrame(session);
        all.push(...(await inFrame(session, (f) => [...f.getViewerPose(local).views])));
      }
      expect(all.map((v) => v.eye)).toEqual(['none', 'left', 'right', 'none', 'right']);
      expect(all.every((v) => 'isFirstPersonObserver' in v && v.isFirstPersonObserver === false)).toBe(true);
    } finally {
      await session.end();
    }
  });

  it("First-person observer: 'secondary-views' is not granted: optional is dropped, required rejects with NotSupportedError", async () => {
    const { session } = await start({ optionalFeatures: ['secondary-views'] });
    expect(session.enabledFeatures).not.toContain('secondary-views');
    await session.end();
    await expect(xr().requestSession('immersive-ar', { requiredFeatures: ['secondary-views'] })).rejects.toMatchObject({
      name: 'NotSupportedError',
    });
  });

  it("Input (screen-space): a screen tap is a transient input source (targetRayMode 'screen', profile generic-touchscreen) firing selectstart, select, selectend", async () => {
    const { session } = await start();
    try {
      const events: string[] = [];
      for (const t of ['selectstart', 'select', 'selectend']) {
        session.addEventListener(t, (e) => events.push(`${t}:${(e as unknown as { inputSource: Source }).inputSource.targetRayMode}`));
      }
      window.dispatchEvent(new PointerEvent('pointerdown', { clientX: 10, clientY: 10 }));
      await inFrame(session);
      const source = session.inputSources[0];
      expect(source).toMatchObject({ targetRayMode: 'screen', handedness: 'none' });
      expect(source.profiles).toContain('generic-touchscreen');
      // like Chrome Android: no grip, gamepad or hand (three's XRControllerModelFactory skips it; pages that
      // only build visuals for 'tracked-pointer' / 'gaze', e.g. webxr_xr_ballshooter, add nothing)
      expect([source.gripSpace ?? null, source.gamepad ?? null, source.hand ?? null]).toEqual([null, null, null]);
      await inFrame(session);
      window.dispatchEvent(new PointerEvent('pointerup'));
      await inFrame(session);
      await inFrame(session);
      expect(events).toEqual(['selectstart:screen', 'select:screen', 'selectend:screen']);
      expect(session.inputSources).toHaveLength(0); // transient: removed after the select
    } finally {
      await session.end();
    }
  });

  it("Privacy: no camera image APIs ('camera-access' not granted, no XRView.camera / getCameraImage)", async () => {
    const { session, local } = await start({ optionalFeatures: ['camera-access'] });
    try {
      expect(session.enabledFeatures).not.toContain('camera-access');
      const view = await inFrame(session, (f) => f.getViewerPose(local).views[0] as unknown as Record<string, unknown>);
      expect(view.camera).toBeUndefined();
      const Binding = (globalThis as unknown as { XRWebGLBinding: { prototype: object } }).XRWebGLBinding;
      expect('getCameraImage' in Binding.prototype).toBe(false);
    } finally {
      await session.end();
    }
    await expect(xr().requestSession('immersive-ar', { requiredFeatures: ['camera-access'] })).rejects.toMatchObject({
      name: 'NotSupportedError',
    });
  });
});
