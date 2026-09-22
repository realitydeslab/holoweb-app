/**
 * WebXR interface globals. WKWebView has none; IWER's installRuntime sets the core ones, feature modules
 * set their own (light, transient hit test, XRGPUBinding, XRWebGLBinding with reflections). This fills
 * in the rest, so pages can construct (new XRRay(...)) and instanceof-check every interface.
 * Dictionaries and enums (XRDOMOverlayState, XRSessionMode, ...) have no global in browsers either.
 */
import { XRAnchor, XRAnchorSet, XRCPUDepthInformation, XRMesh, XRMeshSet, XRPlane, XRPlaneSet, XRRay, XRReferenceSpace, XRWebGLDepthInformation } from 'iwer';
import { XRHitTestResult, XRHitTestSource } from 'iwer/lib/hittest/XRHitTest.js';
import { XRGPUProjectionLayer } from './gpu-binding.js';
import { XRImageTrackingResult } from './image-tracking.js';

/** Every WebXR interface a page may reference by name after install (XRGPUBinding needs navigator.gpu). */
export const WEBXR_GLOBALS = [
  'XRSystem', 'XRSession', 'XRRenderState', 'XRFrame', 'XRView', 'XRViewport',
  'XRSpace', 'XRReferenceSpace', 'XRBoundedReferenceSpace', 'XRJointSpace',
  'XRRigidTransform', 'XRRay', 'XRPose', 'XRViewerPose', 'XRJointPose',
  'XRHand', 'XRInputSource', 'XRInputSourceArray',
  'XRSessionEvent', 'XRInputSourceEvent', 'XRInputSourcesChangeEvent', 'XRReferenceSpaceEvent',
  'XRLayer', 'XRWebGLLayer', 'XRWebGLBinding', 'XRProjectionLayer', 'XRGPUBinding', 'XRGPUSubImage',
  'XRHitTestSource', 'XRHitTestResult', 'XRTransientInputHitTestSource', 'XRTransientInputHitTestResult',
  'XRAnchor', 'XRAnchorSet', 'XRPlane', 'XRPlaneSet', 'XRMesh', 'XRMeshSet',
  'XRLightProbe', 'XRLightEstimate', 'XRCPUDepthInformation', 'XRWebGLDepthInformation',
  'XRImageTrackingResult',
] as const;

/** Never constructed by the polyfill (no bounded-floor); exists for instanceof checks. */
export class XRBoundedReferenceSpace extends XRReferenceSpace {
  get boundsGeometry(): DOMPointReadOnly[] {
    return [];
  }
}

export function installWebXRGlobals(target: Record<string, unknown> = globalThis as unknown as Record<string, unknown>): void {
  const set: Record<string, unknown> = {
    XRRay, XRBoundedReferenceSpace, XRHitTestSource, XRHitTestResult,
    XRAnchor, XRAnchorSet, XRPlane, XRPlaneSet, XRMesh, XRMeshSet,
    XRCPUDepthInformation, XRWebGLDepthInformation, XRImageTrackingResult,
  };
  for (const [name, value] of Object.entries(set)) target[name] = value;
  // without WebGPU the layer class still exists (WebXR Layers name); XRGPUBinding stays WebGPU-gated
  if (!target.XRProjectionLayer) target.XRProjectionLayer = XRGPUProjectionLayer;
}

/** Names from WEBXR_GLOBALS missing on `target` (diagnostics, tests). */
export function missingWebXRGlobals(target: Record<string, unknown> = globalThis as unknown as Record<string, unknown>): string[] {
  return WEBXR_GLOBALS.filter((name) => typeof target[name] !== 'function');
}
