/**
 * XR visibility from native `bridge.onVisibility(state)`:
 *   willResignActive / .inactive / ARSession interruption -> 'visible-blurred'
 *   background                                          -> 'hidden'
 *   didBecomeActive / interruption ended                -> 'visible'
 * Sets session.visibilityState and dispatches `visibilitychange` right away (IWER only applies a
 * pending state at the next frame, which never comes while hidden). While not 'visible', input
 * sources end without `select` (input.ts, hand-input.ts); while 'hidden', immersive frame loops idle
 * (session.ts). The session stays alive across interruptions.
 */
import { P_DEVICE, XRDevice, XRSessionEvent } from 'iwer';

export type VisibilityState = 'visible' | 'visible-blurred' | 'hidden';

const STATES = new Set<string>(['visible', 'visible-blurred', 'hidden']);

export function isVisible(device: XRDevice): boolean {
  return device[P_DEVICE].visibilityState === 'visible';
}

/** Apply a native visibility state; returns true if it changed. */
export function applyVisibility(device: XRDevice, state: unknown): boolean {
  if (typeof state !== 'string' || !STATES.has(state)) return false;
  const deviceState = device[P_DEVICE];
  deviceState.pendingVisibilityState = null;
  if (deviceState.visibilityState === state) return false;
  deviceState.visibilityState = state as VisibilityState;
  const session = device.activeSession;
  if (session) session.dispatchEvent(new XRSessionEvent('visibilitychange', { session }));
  return true;
}
