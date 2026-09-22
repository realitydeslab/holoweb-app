/**
 * Native ARKit anchors behind IWER's XRAnchor objects.
 *
 * - XRFrame.createAnchor (and XRHitTestResult.createAnchor, which calls it) posts
 *   `createAnchor { pose }` with the world pose and resolves with an XRAnchor once native
 *   replies `{ id }`.
 * - XRHitTestResult.createAnchor also works on a result kept from an earlier frame while the session
 *   is live (the immersive-web hit-test-anchors sample does this; Chrome accepts it), using the
 *   result's stored world pose. XRFrame.createAnchor keeps the spec's active-frame check.
 * - bridge.onAnchors([{ id, transform }]) moves each anchor's space; `transform: null` means
 *   ARKit lost the anchor: it leaves session/frame trackedAnchors and keeps its last pose.
 * - anchor.delete() posts `deleteAnchor { id }` (not for anchors native already removed).
 * - Persistent handles are rejected: ARKit world origins differ between sessions, so IWER's
 *   localStorage-backed poses would be wrong.
 */
import { mat4 } from 'gl-matrix';
import { P_ANCHOR, P_DEVICE, P_FRAME, P_HIT_TEST, P_SESSION, P_SPACE, XRAnchor, XRFrame, XRSession, XRSpace } from 'iwer';
import { XRHitTestResult } from 'iwer/lib/hittest/XRHitTest.js';
import { XRSpaceUtils } from 'iwer/lib/spaces/XRSpace.js';

export interface NativeAnchorData {
  id: string | number;
  /** World pose, column-major, or null when ARKit removed the anchor. */
  transform: ArrayLike<number> | null;
}

export interface AnchorTransport {
  createNativeAnchor(pose: ArrayLike<number>): Promise<string>;
  deleteNativeAnchor(id: string): Promise<void>;
}

export class NativeAnchors {
  private readonly byId = new Map<string, XRAnchor>();
  private ids = new WeakMap<XRAnchor, string>();

  constructor(private readonly transport: AnchorTransport) {}

  get count(): number {
    return this.byId.size;
  }

  install(): void {
    const anchors = this;
    XRFrame.prototype.createAnchor = function (this: XRFrame, pose, space) {
      return anchors.create(this, pose.matrix, space);
    };
    const hitCreateAnchor = XRHitTestResult.prototype.createAnchor;
    XRHitTestResult.prototype.createAnchor = function (this: XRHitTestResult) {
      const { frame, offsetSpace } = this[P_HIT_TEST];
      if (frame[P_FRAME].active) return hitCreateAnchor.call(this);
      return anchors.createWorld(frame[P_FRAME].session, XRSpaceUtils.calculateGlobalOffsetMatrix(offsetSpace));
    };
    const iwerDelete = XRAnchor.prototype.delete;
    XRAnchor.prototype.delete = function (this: XRAnchor) {
      anchors.forget(this, true);
      iwerDelete.call(this);
    };
    XRAnchor.prototype.requestPersistentHandle = function () {
      return Promise.reject(new DOMException('Persistent anchors are not supported by HoloWeb', 'NotSupportedError'));
    };
  }

  private async create(frame: XRFrame, poseMatrix: Float32Array, space: XRSpace): Promise<XRAnchor> {
    const state = frame[P_FRAME];
    if (!state.active) throw new DOMException('XRFrame is not active', 'InvalidStateError');
    return this.createWorld(state.session, XRSpaceUtils.calculateGlobalOffsetMatrix(new XRSpace(space, poseMatrix)));
  }

  /** Create a native anchor at a world pose for a live session. */
  async createWorld(session: XRSession, world: Float32Array | mat4): Promise<XRAnchor> {
    if (session[P_SESSION].ended) throw new DOMException('XRSession has ended', 'InvalidStateError');
    if (!session.enabledFeatures.includes('anchors')) {
      throw new DOMException("The 'anchors' feature is not enabled", 'NotSupportedError');
    }
    const id = await this.transport.createNativeAnchor(Array.from(world));
    if (session[P_SESSION].ended) {
      this.transport.deleteNativeAnchor(id).catch(() => undefined);
      throw new DOMException('XRSession ended before the anchor was created', 'InvalidStateError');
    }
    const globalSpace = session[P_SESSION].device[P_DEVICE].globalSpace;
    // The XRAnchor constructor adds itself to the session's trackedAnchors.
    const anchor = new XRAnchor(new XRSpace(globalSpace, world), session);
    this.byId.set(id, anchor);
    this.ids.set(anchor, id);
    return anchor;
  }

  /** Apply a native anchor update (<= 10 Hz). */
  update(list: readonly NativeAnchorData[]): void {
    for (const { id, transform } of list) {
      const anchor = this.byId.get(String(id));
      if (!anchor) continue;
      if (transform === null) {
        // Lost: no longer tracked, but the page may still hold and delete() it.
        anchor[P_ANCHOR].session[P_SESSION].trackedAnchors.delete(anchor);
        this.forget(anchor, false);
        continue;
      }
      const space = anchor[P_ANCHOR].anchorSpace;
      if (space && transform.length === 16) mat4.copy(space[P_SPACE].offsetMatrix, transform as unknown as mat4);
    }
  }

  /** Drop all native ids (session ended; native removes its anchors with the ARSession). */
  clear(): void {
    this.byId.clear();
    this.ids = new WeakMap();
  }

  private forget(anchor: XRAnchor, notifyNative: boolean): void {
    const id = this.ids.get(anchor);
    if (id === undefined) return;
    this.ids.delete(anchor);
    this.byId.delete(id);
    if (notifyNative) this.transport.deleteNativeAnchor(id).catch(() => undefined);
  }
}
