# HoloWeb

HoloWeb runs WebXR AR content on iPhone. Safari on iOS has no WebXR; HoloWeb is an iOS app plus an App Clip that loads any web page in a `WKWebView`, injects a WebXR polyfill, and streams ARKit tracking into it at 60 Hz. Pages written for WebXR (three.js, Babylon.js, PlayCanvas, A-Frame, model-viewer, Needle, Unity WebXR exports, raw WebXR) run unchanged.

Two viewing modes, switchable at any time during a session:

- **Handheld AR (mono):** the camera feed shows through the transparent page; content is rendered from the phone's pose.
- **HoloKit stereo:** side-by-side eyes for the [HoloKit X](https://holokit.io) optical see-through headset, with per-eye off-axis projections computed from the phone model.

Requires **iOS 27** (WKJSHandle transport, WebGPU in WKWebView). Developed and verified on an iPhone 15 Pro. LiDAR-only features are noted below.

## Quick start

1. Open https://holoweb.app/ in the app, or scan a HoloWeb QR code / App Clip Code to get the App Clip.
2. Pick an experience and tap the page's own **Start AR** button. Sessions always start in handheld mono.
3. Use the corner controls: **glasses** = switch to HoloKit stereo (the **phone** icon switches back), **✕** = exit the XR session, **grid** = gallery, **↻** = reload.

Invocation links:

| Link | Opens |
|---|---|
| `https://holoweb.app/launch?url=<percent-encoded https URL>` | that page |
| `https://holoweb.app/c?url=<percent-encoded https URL>` | that page (App Clip invocation) |
| `https://holoweb.app/c/<code>` | a gallery short link (App Clip Code target) |

Only `https` targets are accepted. Tapping these links inside HoloWeb opens the target in place.

## Features

### App and App Clip

- One app and one App Clip sharing the same code. The Clip is under 1 MB (about 476 KB plus the 171 KB polyfill) against the 15 MB App Clip limit.
- Viewer states: **browsing** (normal scrollable web page, camera off) → **AR mono** (page started a session) → **AR stereo** (corner toggle) → back to browsing on exit or navigation. `immersive-vr` sessions get their own opaque states (camera off, ARKit used for tracking only).
- Corner controls: one compact capsule pinned to the same **physical** corner of the phone (the portrait bottom-right). With the Dynamic Island on the left (the HoloKit orientation) it sits at the top-right, above the HoloKit eye viewports. Its size never changes between states.
- **Stereo from any orientation:** switching to stereo locks the current interface orientation instead of rotating the screen. The page's framebuffer keeps its session-start size, and the polyfill turns the HoloKit eye layout into it, so stereo works whether the session was started in portrait or landscape.
- Gallery home page (https://holoweb.app/) with 15 curated WebXR experiences, QR codes and short links.
- Associated domains / AASA for `holoweb.app` (`/launch`, `/c`, `/c/*`) and App Clip invocation.

### Native ↔ web bridge

- **WKJSHandle transport** (iOS 27): native calls the polyfill directly with `callAsyncJavaScript` on a JS handle, keeping two calls in flight. Measured on device: 60 frames/s with no skipped frames, one-way latency p50 about 0.5 ms.
- Every frame carries the display-oriented camera pose, view and projection matrices, interface orientation, tracking state and light estimate.
- The camera background is matched to the pose the page actually rendered (a 3-frame ring), so content does not swim against the video in mono.
- Main frame and **same-origin iframes** are served. Cross-origin frames are refused.
- Input validation: non-finite numbers, zero-length rays and unknown message types are rejected.
- Lifecycle: resets on navigation, ends the XR session cleanly on ARKit failure, handles bfcache restores, and pauses and resumes on app interruption (`visibilitychange`).
- **ARKit runs only what the page requested:**
  - plane detection for `plane-detection` / `hit-test` (horizontal and vertical) or `local-floor` (horizontal);
  - environment probes for `light-estimation`;
  - LiDAR scene depth for `hand-tracking`;
  - mesh reconstruction for `mesh-detection`.
- The camera and ARKit are off while browsing.

### Rendering

- **WebGL / WebGL2** through `XRWebGLLayer`, at native resolution, mono and stereo, 60 fps.
- **WebGPU** through a polyfilled `XRGPUBinding` (WebXR/WebGPU binding), mono and stereo, 60 fps. Includes a workaround for three.js r186's render-pass descriptor cache when the view count changes mid-session.
- Mono ↔ stereo switching mid-session on both backends. Old three.js releases with a fixed two-camera `ArrayCamera` (r110/r111) get an inert second view, so no stale right eye is left after switching back to mono.
- **HoloKit X stereo math** ported from the HoloKit Unity SDK: per-phone screen and camera table, per-eye off-axis projection, viewport rects, adjustable IPD (`__holoweb.setIpd`).
- **Stereo pose prediction** (25 ms default, `__holoweb.setPrediction(ms)`). Mono never predicts, because it must match the camera image.
- `immersive-vr`: opaque, camera off, mono or stereo.

### WebXR AR Module conformance ([spec](https://immersive-web.github.io/webxr-ar-module/))

- `immersive-ar` sessions.
- `environmentBlendMode`: `alpha-blend` in mono, `additive` in HoloKit stereo, `opaque` in VR.
- `interactionMode`: `screen-space` in mono, `world-space` in stereo.
- `XRView.isFirstPersonObserver` is always `false`, and `secondary-views` is never granted.
- Screen touches become transient `screen` input sources with `select` events.
- The camera image is never exposed to the page.
- `NotSupportedError` for unsupported required features.
- WKWebView has no WebXR at all, so every WebXR interface global is installed (`XRSession`, `XRFrame`, `XRRay`, `XRRigidTransform`, …) with Chromium-compatible constructor behaviour.

### AR features

| Feature | WebXR API | Backed by |
|---|---|---|
| Hit test | `hit-test`, transient hit test for screen taps | ARKit raycasts against planes and estimated planes |
| Anchors | `anchors`, anchors from hit results | `ARAnchor` |
| Plane detection | `plane-detection`, `XRPlane` polygons with stable identity and `lastChangedTime` | `ARPlaneAnchor` |
| Mesh detection (LiDAR) | `mesh-detection`, `XRMesh` with semantic labels | `ARMeshAnchor`, sent at most 2 Hz, changed meshes only |
| Light estimation | `light-estimation`, `XRLightProbe`, `getLightEstimate`, reflection cube map | ARKit light estimate and environment probe (32 px sRGB cube) |
| Hand tracking (LiDAR) | `hand-tracking`, 25-joint `XRHand`, pinch → `select`, grab → `squeeze`, up to two hands | Vision hand pose at 60 Hz on the upright camera image, lifted to 3D with smoothed scene depth, One Euro filtering; handedness derived from hand geometry |
| Image tracking | `image-tracking` ([explainer](https://github.com/immersive-web/image-tracking/blob/main/explainer.md)): `trackedImages`, `getTrackedImageScores`, `getImageTrackingResults` | `ARReferenceImage` / `ARImageAnchor`, up to 4 images, automatic scale estimation |
| DOM overlay | `dom-overlay` (root = `body`), `beforexrselect` | page DOM over the XR canvas |
| Reference spaces | `viewer`, `local`, `local-floor` (floor from the lowest horizontal plane, with `reset` events), `unbounded` | ARKit world tracking |
| Inline sessions | `inline` next to immersive sessions; the page's inline canvas is left alone | — |

Features the device cannot back (e.g. mesh or hand tracking without LiDAR) are reported as unsupported, so pages can fall back.

### Page-facing API

The polyfill exposes `window.__holoweb` for pages that want HoloWeb-specific control:

```js
__holoweb.version
await __holoweb.setMode('stereo')   // or 'mono'
__holoweb.setIpd(0.064)             // metres, clamped to 0.054–0.074
__holoweb.setPrediction(25)         // stereo pose prediction in ms, 0 disables
await __holoweb.hitTest(origin, direction)
__holoweb.missingGlobals()          // WebXR globals that are not installed (diagnostics)
```

## WebXR API reference

What a page can use in HoloWeb, by interface. Everything is the standard WebXR API; nothing HoloWeb-specific is needed.

| Area | Supported |
|---|---|
| Entry | `navigator.xr.isSessionSupported()`, `navigator.xr.requestSession('immersive-ar' \| 'immersive-vr' \| 'inline', { requiredFeatures, optionalFeatures, domOverlay, trackedImages })` |
| Session | `XRSession.requestAnimationFrame`, `requestReferenceSpace`, `updateRenderState`, `end`, `enabledFeatures`, `inputSources`, `environmentBlendMode`, `interactionMode`, `visibilityState`, `frameRate`; events `end`, `select*`, `squeeze*`, `inputsourceschange`, `visibilitychange` |
| Frame | `XRFrame.getViewerPose`, `getPose`, `getHitTestResults`, `getHitTestResultsForTransientInput`, `createAnchor`, `trackedAnchors`, `detectedPlanes`, `detectedMeshes`, `getLightEstimate`, `getJointPose`, `fillPoses`, `fillJointRadii`, `getImageTrackingResults` |
| Rendering | `XRWebGLLayer` (WebGL / WebGL2), `XRGPUBinding` + `getViewSubImage` (WebGPU), `XRView` (`projectionMatrix`, `transform`, `eye`), `getViewport` |
| Reference spaces | `viewer`, `local`, `local-floor` (with `reset`), `unbounded`, `getOffsetReferenceSpace` |
| Hit test | `requestHitTestSource({ space, offsetRay })`, `requestHitTestSourceForTransientInput({ profile: 'generic-touchscreen' })`, `XRHitTestResult.createAnchor` |
| Anchors | `XRFrame.createAnchor`, `XRAnchor.anchorSpace`, `XRAnchor.delete` |
| Planes / meshes | `XRPlane` (`polygon`, `orientation`, `planeSpace`, `lastChangedTime`), `XRMesh` (`vertices`, `indices`, `meshSpace`, `semanticLabel`) |
| Lighting | `requestLightProbe`, `XRLightEstimate` (spherical harmonics, primary light), `XRWebGLBinding.getReflectionCubeMap`, `reflectionchange` |
| Hands | `XRInputSource.hand` (`XRHand`, 25 `XRJointSpace`s), hand `select` / `squeeze`, target ray from the pinch point |
| Image tracking | `trackedImages: [{ image, widthInMeters }]`, `getTrackedImageScores`, `XRImageTrackingResult` (`imageSpace`, `trackingState`, `measuredWidthInMeters`) |
| Screen input | transient `screen` input source (`generic-touchscreen`), `select` events, DOM overlay `beforexrselect` |

## Examples

### Minimal hit test (plain WebXR)

```js
const session = await navigator.xr.requestSession('immersive-ar', { requiredFeatures: ['hit-test'] });
const gl = canvas.getContext('webgl2', { xrCompatible: true });
session.updateRenderState({ baseLayer: new XRWebGLLayer(session, gl) });
const local = await session.requestReferenceSpace('local');
const viewer = await session.requestReferenceSpace('viewer');
const hitSource = await session.requestHitTestSource({ space: viewer });

session.requestAnimationFrame(function onFrame(t, frame) {
  const hit = frame.getHitTestResults(hitSource)[0];
  if (hit) placeReticle(hit.getPose(local).transform.matrix);
  // ... draw each view of frame.getViewerPose(local) into its viewport
  session.requestAnimationFrame(onFrame);
});
```

### three.js with hands (WebGPU or WebGL)

```js
import * as THREE from 'three/webgpu';
import { ARButton } from 'three/addons/webxr/ARButton.js';
import { XRHandModelFactory } from 'three/addons/webxr/XRHandModelFactory.js';

const renderer = new THREE.WebGPURenderer({ alpha: true });
renderer.xr.enabled = true;
document.body.append(renderer.domElement, ARButton.createButton(renderer, { optionalFeatures: ['hand-tracking'] }));

const hand = renderer.xr.getHand(0);
hand.add(new XRHandModelFactory().createHandModel(hand, 'spheres'));
scene.add(hand);
renderer.xr.addEventListener('sessionstart', () =>
  renderer.xr.getSession().addEventListener('select', (e) => e.inputSource.hand && onPinch(e.inputSource)));
```

### Image tracking

```js
const bitmap = await createImageBitmap(await (await fetch('marker.png')).blob());
const session = await navigator.xr.requestSession('immersive-ar', {
  requiredFeatures: ['image-tracking'],
  trackedImages: [{ image: bitmap, widthInMeters: 0.15 }],
});
const scores = await session.getTrackedImageScores(); // ['trackable'] or ['untrackable']
// per frame:
for (const result of frame.getImageTrackingResults()) {
  if (result.trackingState === 'tracked') placeOnImage(frame.getPose(result.imageSpace, local).transform.matrix);
}
```

### HoloKit stereo from a page

Users switch with the corner glasses button. A page can also do it:

```js
if (window.__holoweb) await __holoweb.setMode('stereo');
session.environmentBlendMode; // 'additive' in stereo: black is transparent in HoloKit
```

### Sharing a page

Any https WebXR page opens in HoloWeb (or the App Clip) through `https://holoweb.app/c?url=<percent-encoded URL>`; put that link in a QR code. The gallery at https://holoweb.app/ builds these links and QR codes.

### Bundled example pages

Debug builds open these with `HOLOWEB_PAGE=examples/<page>`; the sources are in `polyfill/examples/`.

| Page | Shows |
|---|---|
| `demo.html` | WebGPU showcase scene 1 m in front, no surface needed; mono/stereo switching |
| `three-ar.html` | three.js WebGL hit test, anchors and light estimation |
| `three-ar-webgpu.html` | the same on the WebGPU backend |
| `three-ar-hands.html` | 25-joint hand models; pinch drops a cube at the fingertip |
| `three-ar-grab.html` | pinch to grab a cube with either hand; pinch with both hands to stretch it |
| `image-tracking.html` | tracks the HoloWeb marker (`assets/holoweb-marker.png`, 0.15 m wide) |
| `threejs/webxr_ar_hittest.html`, `webxr_ar_lighting.html`, `webxr_ar_plane_detection.html` | the official three.js AR examples, offline |

## Verified content

On device (iPhone 15 Pro, iOS 27) unless noted.

- **Immersive Web samples:**
  - pass: `hit-test`, `webgpu/immersive-ar-session`, `anchors`, `hit-test-anchors`, `proposals/mesh-detection`, `tests/exit-button` (VR).
  - enter AR, pending a full check: `proposals/plane-detection` (planes need real surfaces in view) and `tests/interrupted-ar`.
  - enter VR: `immersive-hands` and `webgpu/immersive-hands`. Hand tracking in VR is granted since the capability fix (unit-tested), but not yet rechecked with real hands on device.
- **three.js examples:** `webxr_ar_hittest`, `webxr_ar_lighting`, `webxr_ar_plane_detection` (live from threejs.org and bundled offline), and `webxr_ar_cones` (live).
- **Image tracking:** the HoloWeb marker (0.15 m), PlayCanvas and Needle image-tracking samples.
- **Gallery:** Toji's WebXR particles, PlayCanvas AR (iframe), model-viewer AR, Babylon.js, three.js lighting, and the Immersive Web samples. Needle, SuperSplat and ball-shooter entries are listed but not fully checked on device yet.

The complete per-feature status lives in [`plan/feature_registry.md`](plan/feature_registry.md).

## Repository layout

```
HoloWeb/                 Swift app + App Clip (shared sources)
  HoloWebState.swift     viewer state machine, ARKit configuration, orientation lock, debug hooks
  ARBridge*.swift        native side of the bridge (frames, planes, anchors, meshes, env map, hit test)
  HandTracker.swift      Vision + LiDAR hand joints
  ImageTracker.swift     reference images, imageSpace poses
  Renderer.swift         Metal camera background
  Web/                   bundled polyfill + example pages (served at holoweb-app://local/)
polyfill/                TypeScript WebXR polyfill (fork of IWER 2.4.0 via patch-package)
  src/                   bridge, device, stereo, session, features (planes, meshes, hands, images, …)
  test/                  vitest unit tests
  examples/              HoloWeb demo pages and bundled three.js examples
Scripts/                 regression runner, device lock, polyfill sync
plan/                    plan, bridge protocol, feature registry, run notes
server/                  apple-app-site-association
```

The website (gallery, QR codes, short links) lives in the separate `holoweb-website` repository.

## Building

```bash
cd polyfill && npm install && npm run build   # builds dist/holoweb-polyfill.js
cd .. && Scripts/sync-polyfill.sh             # copies it (and the examples) into HoloWeb/Web/
open HoloWeb.xcodeproj                        # schemes: HoloWeb, HoloWebClip
```

Always run `Scripts/sync-polyfill.sh` after rebuilding the polyfill; the app ships the copy in `HoloWeb/Web/`.

## Testing

```bash
cd polyfill
npm run typecheck
npm test                   # vitest unit tests (stereo math, bridge, AR module conformance, features)
npm run test:e2e           # headless browser e2e against samples and fixtures (Chromium)
npm run test:e2e:webkit    # same under WebKit

cd ..
Scripts/regression.py                  # polyfill tests + Xcode builds + on-device checks (if an iOS 27 iPhone is connected)
Scripts/regression.py --no-device      # polyfill tests + builds only
Scripts/regression.py --only <groups>  # selected device groups (see Scripts/regression_targets.py)
Scripts/regression.py --device <UDID>  # choose the phone
```

On-device checks load bundled pages and live samples. They fail when:

- the bridge runs below 55 frames/s, or XR below 55 fps;
- the view count doesn't follow mono/stereo;
- the page throws errors;
- a cross-origin frame reaches the bridge;
- non-finite input is accepted;
- frames continue after `endSession`;
- anchor round-trips or the checks for planes, meshes, the environment map, hands or images fail;
- link interception doesn't work.

Device runs are serialized with `Scripts/device-lock.py`.

Debug builds accept launch environment variables for unattended runs:

| Variable | Effect |
|---|---|
| `HOLOWEB_PAGE` / `HOLOWEB_URL` | page to open |
| `HOLOWEB_TEST_CLICK` (+ `HOLOWEB_TEST_CLICK_WAIT`) | click a selector (or a `js:` expression) |
| `HOLOWEB_TEST_TOGGLE` | flip mono/stereo every N seconds |
| `HOLOWEB_NO_POLYFILL` | disable the polyfill |
| `HOLOWEB_AR_DIAG` | ARKit diagnostics |
| `HOLOWEB_ARKIT_ALL` | run the old always-on ARKit configuration, for heat A/B runs |
| `HOLOWEB_TEST_CYCLE` | exit XR and reload every N seconds (session teardown stress loop with an `?autostart` page) |

## Known limitations

- HoloKit optical alignment and stereo prediction tuning have not been checked in a real HoloKit X headset yet.
- Hand tracking in `immersive-vr` (the Immersive Web hands samples) still needs a device recheck with real hands.
- Hand tracking uses the phone's camera: hands closer than about 30 cm, partly out of frame, or in dim light are detected less often, and fingertip depth is mostly inferred from the palm.
- Plane detection needs textured surfaces and some phone movement; a still phone may take 10 s or more to report the first plane.
- AR is thermally heavy. The camera and ARKit tracking use about 1.4 CPU cores even when idle. Rendering WebGL at 2× instead of 3× and lowering the camera format in stereo are the next planned savings.
- The App Store Connect App Clip experience, TestFlight distribution and App Clip Code images are still to be set up.

## Background

Safari on iOS has never shipped WebXR, and Safari on visionOS supports VR sessions but not AR. The previous way to run WebXR AR on iPhone, [Mozilla's WebXR Viewer](https://github.com/mozilla-mobile/webxr-ios/), is no longer maintained and predates WebXR 1.0. HoloWeb fills that gap with a current WebXR implementation (hit test, anchors, planes, meshes, lighting, hands, image tracking, WebGPU) and adds HoloKit stereo for hands-free mixed reality.

## License

MIT, see [LICENSE](LICENSE).
