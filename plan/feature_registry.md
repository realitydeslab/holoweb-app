# HoloWeb feature and test registry

Single source of truth for every feature in scope and how it is verified. Updated 2026-09-22.
Specs: `plan/holoweb_plan.md` §9. Wire protocol: `plan/bridge_protocol.md`. Sample analysis: `plan/samples_requirements.md`. Run logs: `plan/notes.md`.

Status: **device** = verified on iPhone 15 Pro, iOS 27 · **headless** = polyfill e2e/unit only · **wip** = being implemented · **planned** = queued · **human** = needs a person holding the phone.
Test sources: **R** = `Scripts/regression.py` (on device) · **U** = `polyfill` unit (`npm test`) · **E** = `polyfill` e2e (`npm run test:e2e`) · **M** = manual.

## A. App, App Clip, shell

| ID | Feature | Status | Tests |
|---|---|---|---|
| A1 | iOS 27 app + App Clip targets build | device | R build.HoloWeb, build.HoloWebClip |
| A2 | Single WKWebView/ARSession state, polyfill injected at document start (all same-origin frames) | device | R bridge.* |
| A3 | Viewer states: browsing (opaque, camera off) → AR mono (Start AR) → AR stereo (top-right toggle) → exit | device | R browsing-without-session, three-*.toggled |
| A4 | Top-right controls: mono/stereo toggle, Exit AR, Gallery, Reload | device | M |
| A5 | Every session starts mono; leaving AR / navigating resets mono + unlocks orientation | device | R three-*.entered-ar |
| A6 | Gallery home page (https://holoweb.app/) + in-app interception of `/launch?url=`, `/c?url=` | device | R in-app-link-interception |
| A7 | App Clip Code short links `holoweb.app/c/<code>` (redirect inside HoloWeb) | device | M (HOLOWEB_URL=/c/13 → Toji) |
| A8 | AASA: team KR9H35SQQ9, `/launch`, `/c`, `/c/*`, appclips | live | M (curl) |
| A9 | App Clip launch via `_XCAppClipURL` / invocation, 2 s default fallback | device | M |
| A10 | App Clip size budget (< 15 MB) | device (476 KB + 171 KB polyfill) | M |
| A11 | Bundled test pages served at `holoweb-app://local/` (file:// blocks local ES modules) | device | R webgpu-check |
| A12 | Debug-only test hooks: HOLOWEB_PAGE, HOLOWEB_URL, HOLOWEB_TEST_TOGGLE, HOLOWEB_TEST_CLICK, HOLOWEB_NO_POLYFILL | device | R |
| A13 | App Store Connect App Clip experience (`/c` prefix), TestFlight invocation, App Clip Code images | planned | human (App Store Connect) |
| A14 | Consent / origin display for third-party pages | planned | product decision pending |

## B. Native ↔ web bridge (`plan/bridge_protocol.md`)

| ID | Feature | Status | Tests |
|---|---|---|---|
| B1 | WKJSHandle transport (iOS 27), window.__holoweb fallback | device | R bridge.jshandle |
| B2 | 60 Hz onFrame, 2 calls in flight, 0 skipped | device (59.9–60/s) | R bridge.frame-rate |
| B3 | One-way latency (p50 0.5 ms) | device | R bridge.latency-p50 |
| B4 | Display-oriented pose, orientation, projection per frame | device | R bridge.frame-args |
| B5 | Camera image matched to rendered pose (`rendered` message, 3-frame ring) | device | M (visual drift check: human) |
| B6 | Main-frame + same-origin iframes accepted; cross-origin rejected; test click searches iframes + shadow roots, `js:` expressions | device | R bridge.iframe-cross-origin-rejected, iframe-same-origin-accepted |
| B7 | Input validation (NaN/Infinity, zero direction, unknown types) | device | R bridge.hit-test-rejects-nan, anchor-rejects-nonfinite, unknown-type-rejected |
| B8 | Lifecycle: reset on commit, ARSession failure → onSessionEnded, stale completions ignored, no retained frames | device | R bridge.end-session-stops-frames |
| B9 | bfcache restore re-announces `ready` | headless | U |
| B10 | Shared device lock for tests (`Scripts/device-lock.py`) | done | R |

## C. Rendering

| ID | Feature | Status | Tests |
|---|---|---|---|
| C1 | WebGL2 (`XRWebGLLayer`) mono + stereo, 60 fps | device | R three-webgl.fps |
| C2 | WebGPU via polyfilled `XRGPUBinding`, mono + stereo, 60 fps | device | R three-webgpu.fps, webgpu-check |
| C3 | Mid-session mono ↔ stereo on WebGPU (three r186 descriptor-cache priming) | device | R three-webgpu.views-follow-mode, U gpu-priming |
| C4 | Old three.js (r110/r111): no stale right eye after stereo → mono | headless (+ user report fixed) | E stale-eye fixture + live Toji |
| C5 | three r130–r173: renderState.layers undefined → XRWebGLLayer path | headless | E three-r152 fixture |
| C6 | HoloKit X stereo math (per-eye projection, viewports, phone table) | headless | U stereo.test |
| C7 | HoloKit optical alignment | planned | human (HoloKit X) |
| C8 | Stereo pose prediction (25 ms, `__holoweb.setPrediction`) | headless | U prediction.test; tuning: human |
| C9 | Mono rotation mid-session | headless | E |
| C10 | immersive-vr: opaque, camera off, mono/stereo (phases vrMono/vrStereo, `ViewerPhase.blendsCamera`) | device (exit-button enters vrMono, 60 fps, black) | R iw-exit-button.entered-ar |

## D. WebXR AR Module conformance ([spec](https://immersive-web.github.io/webxr-ar-module/))

| ID | Item | Status | Tests |
|---|---|---|---|
| D1 | `immersive-ar` supported | device | U ar-module-conformance |
| D2 | `environmentBlendMode`: alpha-blend (mono), additive (stereo), opaque (VR) | headless | U ar-module-conformance (VR opaque case); E exit-button |
| D3 | `interactionMode`: screen-space (mono), world-space (stereo) | headless | U |
| D4 | `XRView.isFirstPersonObserver` = false; `secondary-views` not granted | headless | U |
| D5 | Screen input: transient `screen` source, generic-touchscreen, select events | headless | U |
| D6 | No camera image exposure | headless | U |
| D7 | NotSupportedError for unsupported required features | headless | U |
| D8 | Every WebXR interface global installed (WKWebView has none; XRRay per spec DOMPointInit defaults) | headless (e2e strips Chromium's XR* + navigator.xr) | U globals; E WebXR globals under WKWebView conditions (all 30 cases run stripped) |

## E. AR features ([specs](holoweb_plan.md))

| ID | Feature | Status | Tests |
|---|---|---|---|
| E1 | hit-test (+ transient input for screen taps) | device | R three-hittest; E |
| E2 | anchors (ARKit ARAnchor), createAnchor from earlier hit result | device (raw), headless (samples) | R bridge.anchor-roundtrip, xr.anchor-*; E |
| E3 | plane-detection (polygons, stable XRPlane identity, lastChanged) | device (env-plane-check 5/5 on the laptop screen: vertical plane 0.55x0.20 m, 7-vertex CCW polygon) | R planes.*, three-plane-detection.planes, iw-plane-detection.planes; human (surfaces in view) |
| E4 | mesh-detection (LiDAR ARMeshAnchor, ≤2 Hz, changed only, ~2 MB split, semanticLabel) | native device-built (reconstruction on, no meshes while still); polyfill headless (U meshes, E mesh-detection sample) | R mesh.reconstruction-enabled, mesh.no-errors, mesh.* (when meshes), iw-mesh-detection; human |
| E5 | light-estimation: XRLightProbe, estimate, reflection cube map (32 px sRGB) | device (env map) | R env.*, three-lighting.environment |
| E6 | hand-tracking (Vision + LiDAR, 25 joints, pinch select, grab squeeze, One Euro) | native device (G10 payload `{t, hands}`, 27–60 results/s, Vision 7–11 ms; no hand yet); JS headless (U hands, hand-gestures; E three-ar-hands, immersive-hands) | R hands.tracker-rate, hands.timestamp, hands.log-line, hands.no-errors, hands.* (when a hand), iw-hands.hands, iw-webgpu-hands.hands; human (hand, chirality) |
| E7 | image-tracking ([explainer](https://github.com/immersive-web/image-tracking/blob/main/explainer.md)): trackedImages, scores, results, imageSpace convention (`anchor * Rx(-90°)`) | device (native): marker on laptop screen tracked, 279 results, width 0.150 m, axes orthonormal, +Z·toCamera 0.79, +Y up 0.86; polyfill page wip | R image.scores, image.arkit-detection-images, image.* (when tracked), *-image-tracking.set-tracked-images / image-tracking-run / image-tracked; human |
| E8 | dom-overlay (root = body, beforexrselect) | headless | U dom-overlay; E plane-detection sample |
| E9 | local-floor from lowest plane + reset event | headless | U light-floor |
| E10 | Inline + immersive sessions coexist; inline canvas untouched | headless | U inline-sessions; E anchors, interrupted-ar |
| E11 | Visibility on interruption / background (onVisibility) | device (background via Settings: hidden → visible, streaming resumed at 60 fps); polyfill headless | M (devicectl app switch); R iw-interrupted-ar; U visibility |
| E12 | LiDAR capability in `ready` (`capabilities {lidar, sceneReconstruction, handTracking}`) | native built | U |

## F. Test pages (each must pass; R = device regression entry)

Immersive Web samples:
| ID | Page | Status |
|---|---|---|
| F1 | [hit-test](https://immersive-web.github.io/webxr-samples/hit-test.html) | pass (headless + gallery) |
| F2 | [webgpu/immersive-ar-session](https://immersive-web.github.io/webxr-samples/webgpu/immersive-ar-session.html) | pass |
| F3 | [anchors](https://immersive-web.github.io/webxr-samples/anchors.html) | device pass (R iw-anchors.*) |
| F4 | [hit-test-anchors](https://immersive-web.github.io/webxr-samples/hit-test-anchors.html) | device pass (R iw-hit-test-anchors.*) |
| F5 | [proposals/plane-detection](https://immersive-web.github.io/webxr-samples/proposals/plane-detection.html) | device enters AR; `XRRay` global fixed (D8, headless under WKWebView conditions), device recheck pending; planes need surfaces |
| F6 | [proposals/mesh-detection](https://immersive-web.github.io/webxr-samples/proposals/mesh-detection.html) | native ready; polyfill supports mesh-detection (headless pass, capability-gated on LiDAR), device recheck pending |
| F7 | [immersive-hands](https://immersive-web.github.io/webxr-samples/immersive-hands.html) | device enters, onHands 60/s; hand in view: human |
| F8 | [webgpu/immersive-hands](https://immersive-web.github.io/webxr-samples/webgpu/immersive-hands.html) | device enters, onHands 60/s; hand in view: human |
| F9 | [tests/interrupted-ar](https://immersive-web.github.io/webxr-samples/tests/interrupted-ar.html) | device enters AR (page's intended throw ignored) |
| F10 | [tests/exit-button](https://immersive-web.github.io/webxr-samples/tests/exit-button.html) | device pass in VR (vrMono, 60 fps) |

three.js examples:
| ID | Page | Status |
|---|---|---|
| F11 | [webxr_ar_hittest](https://threejs.org/examples/webxr_ar_hittest.html) | device pass |
| F12 | [webxr_ar_lighting](https://threejs.org/examples/webxr_ar_lighting.html) | device pass |
| F13 | [webxr_ar_plane_detection](https://threejs.org/examples/webxr_ar_plane_detection.html) | device enters AR with plane-detection; planes need surfaces (human) |
| F14 | HoloWeb examples: three-ar, three-ar-webgpu, demo, three-ar-hands, image-tracking | device (first three); hands/image wip |

Image tracking:
| ID | Page | Status |
|---|---|---|
| F15 | `examples/image-tracking.html` + HoloWeb marker (0.15 m, to publish on holoweb.app) | wip (polyfill page); R example-image-tracking.* |
| F16 | [PlayCanvas image tracking](https://playcanv.as/p/PCsSvN5h/) | device enters AR (iframe, js click); image-tracking not requested until polyfill supports it; R playcanvas-image-tracking.* |
| F17 | [Needle image tracking](https://engine.needle.tools/samples/image-tracking/) | the gallery embeds the app in a cross-origin iframe (bridge refuses it); app URL image-tracking-zubckszr0qj2.needle.run enters AR (shadow-DOM button); R needle-image-tracking.* |

Gallery (https://holoweb.app/, 15 entries; each to be opened on device):
| ID | Entry | Status |
|---|---|---|
| G1 | SuperSplat micro PC (splat, 182 MB) | headless verified by curator; device pending |
| G2–G6 | Needle: physics playground, snow globe, musical instrument, collaborative sandbox, diamond ring | device pending (check WebXR vs Quick Look path) |
| G7 | PlayCanvas AR starter (iframe) | device pass (iframe support) |
| G8 | model-viewer AR | device pending |
| G9 | A-Frame model viewer | headless pass (offerSession fix) |
| G10 | three.js ball shooter | device pending |
| G11 | three.js AR lighting | device pass (= F12) |
| G12 | Babylon measure tape | device pending |
| G13 | Toji WebXR particles | device pass (user-tested; stale-eye fixed) |
| G14 | Immersive Web hit test | pass (= F1) |
| G15 | Immersive Web WebGPU AR | pass (= F2) |

## H. Website

| ID | Feature | Status | Tests |
|---|---|---|---|
| H1 | Gallery homepage with tag filters, dark/light, credits | live | M (screenshots) |
| H2 | QR codes (cards, landing pages, link builder) encoding `/c?url=` | live | M (17 codes decoded) |
| H3 | Short links `/c/1`–`/c/15`, `/shortlinks.json`, App Clip Code slots | live | M |
| H4 | Landing pages `/launch`, `/c` showing target origin | live | M |
| H5 | App Clip Code images (`scripts/appclip-codes.sh`) | planned | human (Apple generator) |

## Human-only checks (collected)
1. Hold the phone over floor/table: E3/F5/F13 planes, E4/F6 meshes.
2. Hand in view: E6/F7/F8.
3. Printed or on-screen HoloWeb marker: E7/F15–F17 `tracked` state.
4. HoloKit X headset: C7 alignment, C8 prediction tuning.
5. Visual camera/content alignment in mono: B5.
6. App Store Connect + TestFlight: A13, H5.
