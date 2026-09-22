# HoloWeb Implementation Plan

> Complete list of every feature and test with current status: **`plan/feature_registry.md`** (keep it updated whenever a feature or test is added).

Date: 2026-09-22. Toolchain: Xcode 27.0 (27A266a), iOS 26.5 + 27.0 runtimes, deployment target iOS 26.0.
Evidence for every claim below is in `plan/notes.md`.

## 0. Conclusions first

| Question | Answer | Consequence |
|---|---|---|
| Does WKWebView on iOS 26/27 expose WebGPU? | Yes. WebGPU is on by default in WebKit since iOS 26.0; Apple confirmed WKWebView gets it once it is default. iOS 27 (Safari 27.0, 2026-09-17) adds WGSL `clip_distances` and WebXR Layers texture arrays but still no WebXR on iOS Safari. | Keep deployment target 26.0. No feature flag work. Verify on device in M1. |
| Can a WebGPU page run WebXR through our polyfill? | Yes, after M4. three.js `WebGPURenderer` does XR only through `XRGPUBinding`, and that API is polyfillable in pure JS over the page's `GPUDevice` (verified against three.js dev `XRManager.js`). | M3 ships WebGL2 (`XRWebGLLayer`) first; M4 adds `XRGPUBinding` so the default WebGPU backend works without `forceWebGL`. |
| Which polyfill base? | Fork IWER 2.4.0 core (`iwer`, MIT, maintained by Meta) and patch two points: per-eye projection override and per-eye viewport override. | Retire `webxr2.0.js` (2020 Mozilla fork, broken stereo viewport) and `webxr-polyfill.js`. Keep Google webxr-polyfill `CustomXRDevice` as fallback design if the IWER patch turns out larger than ~150 lines. |
| App Clip feasible? | Yes. ARKit, camera, WebKit, Metal are all available. Size cap is 100 MB on iOS 17+ if we only use digital invocation (link/Spotlight); 15 MB if we want QR/NFC/App Clip Codes. CoreMotion is unavailable in App Clips. | App Clip embeds the same polyfill + bridge. Low-latency gyro prediction is full-app only. |
| Rendering modes | Mono (handheld, camera background) and HoloKit stereo (optical see-through, black background, off-axis per-eye projection). | Both are driven by the same bridge; stereo math ported from the HoloKit Unity SDK constants. |

Assumption: "two stereoscopic mode, and mono mode" means two modes total: stereoscopic (HoloKit) and mono. If a third mode is intended (stereo video passthrough, camera drawn into both eye viewports), it fits as a Metal-only change in M4 and is listed there as optional.

## 1. Target architecture

```
                 iOS app / App Clip (Swift, SwiftUI)
 ┌─────────────────────────────────────────────────────────────┐
 │ ARSession (ARWorldTrackingConfiguration) ── ARFrame 60 Hz    │
 │        │                                                     │
 │        ├─► Renderer.swift (Metal): camera background (mono)  │
 │        │        or black (stereo)          [bottom layer]    │
 │        │                                                     │
 │        └─► ARBridge.swift: builds FramePacket, pushes via    │
 │              webView.evaluateJavaScript("__hw.onFrame(...)") │
 │                                                              │
 │ WKWebView (transparent, isOpaque=false)      [top layer]     │
 │   ├ user script @documentStart: holoweb-polyfill.js (IWER   │
 │   │   fork + HoloKit device) installs navigator.xr           │
 │   ├ page: three.js / Babylon / Unity WebGL → XRWebGLLayer    │
 │   └ window.webkit.messageHandlers.holoweb ← JS→native calls  │
 └─────────────────────────────────────────────────────────────┘
```

Mode switch (`mono` / `stereo`) is native state pushed to JS in every FramePacket. JS chooses view count, projection, viewports; Metal chooses background.

## 2. Track 1: App + App Clip + WebGPU check

### 2.1 Repo cleanup (M0)
- Delete scratch targets/dirs: `aaa/`, `aa/`, `holoweb-app/` (nested legacy UIKit copy), `HoloWeb/test2/` (Unity build should be hosted, not bundled; it alone would blow the 15 MB App Clip budget).
- Fix the crash: `ContentView` uses `@EnvironmentObject` but both apps inject with `.environment(state)`. Pick `@Observable` + `@Environment(HoloWebState.self)` everywhere (drop `ObservableObject`/`@Published`).
- One WKWebView configuration only. Move script injection + message handlers from `HoloWebState` (`WebPage`) into `WebViewRepresentable.makeUIView`, and stop calling `load` in `updateUIView` (it reloads on every SwiftUI update). Load the URL once from state.
- Unify orientation constants (Renderer uses `.landscapeRight`, state used `.landscapeLeft`). Decide: mono = follow interface orientation; stereo = `.landscapeLeft` (HoloKit orientation), locked via `supportedInterfaceOrientations`.
- Add `NSCameraUsageDescription` to both targets. Commit as `chore: consolidate app targets and web view configuration`.
- Verify: `xcodebuild -scheme HoloWeb -destination 'generic/platform=iOS' build` and same for `HoloWebClip`.

### 2.2 WebGPU verification (M1)
- Bundle `webgpu-check.html`: logs `navigator.gpu?.requestAdapter()` info, `adapter.features`, `adapter.limits`, then draws one WebGPU triangle and one WebGL2 triangle. Route `console.log` through the existing `logHandler`.
- Run on a physical iPhone on iOS 26.x and iOS 27.0. Record results in `plan/notes.md` (adapter name, whether `navigator.gpu` exists in WKWebView, any GPU-process crash in Console.app).
- Also run the three.js AR sample twice: `WebGPURenderer` default (expect XR failure on WebGPU backend) and `forceWebGL: true` (expected to work with the polyfill). This fixes the guidance we give content authors.

### 2.3 App Clip (M5)
- Invocation URL: `https://holoweb.app/c?url=<encoded page URL>`. Associated Domains: `appclips:holoweb.app` (Clip) and `applinks:holoweb.app` (full app). AASA file on holoweb.app with `appclips` section.
- Decide invocation policy: digital-only (100 MB cap) vs. physical codes (15 MB cap). Recommendation: start digital-only; the polyfill bundle is < 200 KB and the Swift binary is small, so 15 MB is reachable later if QR codes are wanted.
- App Clip-specific behavior: `identifierForVendor` is empty (don't rely on it); CoreMotion returns nothing (skip gyro prediction); persist nothing.
- Test: scheme env var `_XCAppClipURL`, then TestFlight invocation from Safari smart banner (`<meta name="apple-itunes-app" content="app-clip-bundle-id=org.realitydeslab.holoweb.Clip, app-id=...">`).
- Verify size: App Store Connect "App Clip size" report after upload, or `xcodebuild -exportArchive` with `thinning` and inspect the `.ipa` for the Clip.

## 3. Track 2: Polyfill selection and structure

Decision: fork IWER core into `polyfill/` (TypeScript, esbuild → one IIFE `holoweb-polyfill.js`, injected `atDocumentStart`, `forMainFrameOnly`).

Why IWER over the bundled Mozilla fork:
- It is maintained in 2026 and already implements hit-test, anchors, planes, meshes, depth binding, `enabledFeatures`, `dom-overlay`-era session shape, which three.js / Babylon / Unity WebXR exports assume today. The Mozilla fork predates WebXR 1.0 in several APIs.
- Its `XRDevice` already has `stereoEnabled`, `ipd`, view spaces per eye, viewport per eye, and `immersive-ar` with `alpha-blend`.
- Cost: two patches, because IWER computes a symmetric `perspective(fovy, aspect)` and copies left→right, and splits viewports in fixed halves.

Patches to IWER (keep as a small diff on top of the upstream tag so we can rebase):
1. `XRDevice`: add `nativeProjection: { left?: Float32Array; right?: Float32Array; none?: Float32Array }` and `nativeViewports: { left?: Rect; right?: Rect; none?: Rect }` (pixel rects). `XRSession` frame tick uses `nativeProjection[eye]` when present; `getViewport` uses `nativeViewports[eye]` when present.
2. `XRDevice`: keep IWER's `position`/`quaternion` as the center-eye pose. We set it every frame from native. `ipd` stays as IWER's ±ipd/2 view offset (this already matches HoloKit's eye offsets).
3. Add `HoloKitDeviceConfig`: `name: 'HoloKit'`, modes `['inline','immersive-ar']`, features `['viewer','local','local-floor','unbounded','hit-test','anchors','dom-overlay','light-estimation']`, `environmentBlendModes: { 'immersive-ar': 'alpha-blend' }`, `interactionMode: 'screen-space'`.
4. Bridge module `bridge.ts`: owns the `window.__hw` object that native calls, and the single `messageHandlers.holoweb` channel to native.
5. Disable devui/sem/remote in the build; ship only `iwer` core + our files. Target size < 200 KB minified.

Fallback if the patch grows: Google webxr-polyfill 2.x `CustomXRDevice` (its `getProjectionMatrix(eye)` / `getBaseViewMatrix(eye)` / `getViewport(eye)` already take `eye`), at the cost of implementing hit-test/anchors ourselves.

Package layout:
```
polyfill/
  package.json            (iwer pinned to 2.4.0, esbuild, vitest)
  src/index.ts            installs runtime, exposes window.__hw
  src/device.ts           HoloKit XRDevice subclass + config
  src/bridge.ts           native <-> JS protocol (FramePacket in, commands out)
  src/stereo.ts           HoloKit math (constants, phone table, projection, viewports)
  src/phones.json         ported from iOSPhoneModelList.asset
  src/hittest.ts          JS-side ray/plane test + native raycast fallback
  test/stereo.test.ts     golden values vs Unity SDK
  patches/iwer-*.patch    the two upstream patches
```

## 4. Track 3: ARKit → polyfill real-time bridge, mono + stereo

### 4.1 Transport
- JS → native: one handler `holoweb` with `WKScriptMessageHandlerWithReply` (async replies via promise). Commands: `init`, `requestSession{mode, features}`, `endSession`, `hitTest{origin, direction}`, `createAnchor{pose}`, `deleteAnchor{id}`, `setMode{mono|stereo}` (only when JS UI toggles), `log`.
- Native → JS: per ARFrame (60 Hz) call `webView.evaluateJavaScript("__hw.onFrame(<json>)")`. Payload ~700 bytes; the Mozilla WebXR Viewer used exactly this path at 60 Hz. JS stores the latest packet; the polyfill's rAF reads it, so a dropped call never stalls rendering.
- Frame pacing: native-push, not JS-poll (the old `onUpdate` round trip adds a frame). Coalesce: if the previous `evaluateJavaScript` has not completed, skip this frame.
- P2 upgrade: iOS 27 `WKJSHandle`. JS creates a `Float32Array(64)` and hands a handle to native once; native then calls `callAsyncJavaScript("update(buf, ...)", arguments: [handle, values])` to avoid string parsing. Measure before adopting.

FramePacket (JSON):
```
{ t: <ARFrame.timestamp ms>, mode: "mono"|"stereo",
  pose: [16]            // ARKit camera transform, world space, column-major
  intrinsics: {fx,fy,cx,cy,w,h}   // camera intrinsics for mono projection
  orient: "portrait"|"landscapeLeft"|..., viewport: {w,h,scale},
  light: {ambient, temp, dir:[3], intensity},
  tracking: "normal"|"limited"|"notAvailable",
  planes: [{id, pose:[16], extent:[2], polygon:[...]}]   // sent at 10 Hz or on change only
}
```

### 4.2 Coordinate spaces
- ARKit world tracking is gravity-aligned, Y-up, right-handed, meters, identical to WebXR conventions. `local` = ARKit world origin. `viewer` = camera (mono) or center-eye (stereo). `local-floor` = `local` translated by the lowest detected horizontal plane, else −1.3 m; emit `reset` when the estimate changes. `unbounded` = `local`.
- `depthNear`/`depthFar` come from the page's `XRRenderState`; JS rebuilds rows 3/4 of the projection from intrinsics (mono) or from the HoloKit formula (stereo). Native never needs near/far.

### 4.3 Mono mode
- Views: one view, eye `none`. `stereoEnabled = false`.
- Projection from intrinsics, using ARKit's `projectionMatrix(for: orientation, viewportSize:, zNear:, zFar:)` semantics; JS computes the equivalent from `intrinsics` + web viewport so the WebGL viewport and the Metal camera background (`displayTransform`) agree exactly.
- Metal: draw camera image (current `Renderer.swift` path).
- Input: tap → `select` with `targetRayMode: 'screen'`; ray unprojected through the tap pixel.
- Verify: three.js WebGL AR sample; a 10 cm cube placed by hit-test stays fixed while walking around; overlay/camera misalignment < 2 px at screen center (checkerboard test page).

### 4.4 Stereo mode (HoloKit)
- Views: two views, `stereoEnabled = true`, `ipd` user-adjustable (0.054–0.074, default 0.064).
- Center-eye pose = `cameraPose × T(CameraOffset + MrOffset)`; IWER adds ±ipd/2 per eye.
- Per-eye off-axis projection and per-eye viewport rects computed in `stereo.ts` from HoloKit X constants and the phone table (formulas and constants in `plan/notes.md`). Rects are in device pixels; the polyfill's canvas backing store must be `innerWidth × dpr` so rect math in meters→pixels holds. Provide `getNativeFramebufferScaleFactor = dpr`.
- Metal: clear to black (optical see-through). Optional third mode "stereo video passthrough": draw the camera image into both eye rects (Metal-only change).
- Orientation locked to `.landscapeLeft`; status bar hidden; screen brightness raised; idle timer disabled.
- Phone model: native reports `hw.machine` (e.g. `iPhone17,1`) + native screen size/scale; JS looks up `phones.json`. Unknown model → nearest by screen size, and a calibration page (port of the SDK's ViewportBottomOffset calibration).
- Input: P1 tap anywhere on the screen edge = `select` from the center-eye gaze ray (`targetRayMode: 'gaze'`). P2: Vision hand-pose pinch like the Unity SDK.
- Verify: alignment scene (virtual cube on a printed marker at 1 m, both eyes), and unit tests comparing `stereo.ts` output to values computed from the Unity SDK for iPhone14,2.

### 4.5 Latency
- Budget: ARFrame → push → JS render → WebKit compositor → display ≈ 2–3 frames. Measure with a timestamp overlay.
- Mitigation order: (a) native-push instead of poll, (b) pose extrapolation from the last two ARKit poses by the measured latency, (c) full app only: CoreMotion gyro prediction as in the HoloKit SDK `LowLatencyTrackingManager` (unavailable in App Clip).

### 4.6 Features beyond pose
- P1 `hit-test`: JS-side ray vs. received planes (zero round trip) for `XRHitTestSource`; native `ARSession.raycast` via `hitTest` reply for `transient-input` precision.
- P1 `light-estimation`: ambient intensity/temperature and, with `environmentTexturing`, the primary light direction.
- P2 `anchors`: native `ARAnchor` add/remove, ids echoed in FramePacket.
- P2 `dom-overlay`: DOM already sits above the canvas in the same WKWebView, so overlay is mostly free; report `XRDOMOverlayState`.
- P0 (M4) `XRGPUBinding` for WebGPU-backend pages: feasible in pure JS; details in `plan/notes.md` (three.js needs only the binding constructor, `getPreferredColorFormat`, `createProjectionLayer`, `getViewSubImage` with `getViewDescriptor`, and the `webgpu` session feature). Polyfill allocates a 2-layer `GPUTexture` and `copyTextureToTexture`s each layer into its own canvas at the mono/HoloKit rects after the app's rAF callback.
- Not now: `camera-access` (needs per-frame image transfer; Variant Launch ships base64 JPEGs, too slow for our 60 Hz goal), depth sensing, image tracking, world map save/load (the ~25 legacy WebXR Viewer handlers in `HoloWebState.swift` go away).

## 5. Milestones, order, and acceptance

| # | Milestone | Deliverable | Acceptance check |
|---|---|---|---|
| M0 | Repo cleanup | single WKWebView config, crash fixed, scratch targets removed | both schemes build; app shows a web page over the camera |
| M1 | WebGPU check | `webgpu-check.html`, results in notes | `navigator.gpu` adapter logged on iOS 26 and 27 device; WebGL2 fallback confirmed |
| M2 | Polyfill skeleton | `polyfill/` fork of IWER with the two patches, fake bridge, vitest | desktop Chrome runs three.js AR sample against a mock FramePacket stream; `stereo.test.ts` passes |
| M3 | Native bridge, mono | `ARBridge.swift`, FramePacket push at 60 Hz | cube placed by hit-test stays world-locked; measured fps >= 55; overlay/camera alignment < 2 px |
| M4 | XRGPUBinding | `gpu-binding.ts`: XRGPUBinding, XRProjectionLayer, XRGPUSubImage, copy-to-canvas presenter, `webgpu` session feature | three.js `WebGPURenderer` default backend renders the AR sample in mono; alpha compositing over camera intact |
| M5 | Stereo | `stereo.ts` + phones table + Metal black mode + orientation lock; both WebGL and WebGPU layers use the HoloKit viewport rects | HoloKit X alignment scene on iPhone 15/16/17; IPD slider works |
| M6 | App Clip | associated domains, invocation URL, size report | TestFlight App Clip launches page from a link on holoweb.app; size within chosen cap |
| M7 | Features | hit-test source, light estimation, dom-overlay state, anchors | three.js `webxr_ar_hittest` and `webxr_ar_lighting` samples behave as on Android Chrome |
| M8 | Performance | pose extrapolation, WKJSHandle experiment, gyro prediction (full app) | motion-to-photon measured; documented in notes |

Priority: M0-M4 are P0. M5 and M6 are P1 (M5 is the product differentiator; M6 unblocks distribution). M7-M8 are P2.

## 6. Risks
- WebKit GPU-process instability on some iPhone/iOS 26.x combos (reported iPhone 15 + 26.4). Keep a WebGL2 path and test on ≥ 2 device generations.
- Per-frame `evaluateJavaScript` cost grows with payload; keep planes out of the 60 Hz packet.
- IWER upstream churn: pin 2.4.0, keep patches as files under `polyfill/patches/`.
- HoloKit phone table lacks unreleased models; ship calibration page.
- App Clip 15 MB cap if QR invocation is later required: keep polyfill and assets remote-loadable.

## 7. Immediate next step
Start M0: delete scratch targets, fix the `@EnvironmentObject` injection crash, and merge the two web view configurations into `WebViewRepresentable`. Then run the M1 WebGPU check page on a device.

## 8. Latency follow-ups (added 2026-09-22 after M3 measurements)
Throughput is solved (59.9 onFrame/s, 0 skipped, 2 calls in flight). Each callAsyncJavaScript round trip is ~17-20 ms; no faster native->page channel exists because WKWebView runs out of process.
- M3b (P0): timestamp-matched camera background. Renderer keeps a 3-deep ring of captured-image textures keyed by ARFrame.timestamp; the polyfill reports the timestamp it rendered each XR frame (fire-and-forget `postMessage({type:"rendered", t})`); Renderer draws the matching image. Removes virtual/real drift in mono.
- M5 (P1, moved from M8): pose prediction in stereo. Extrapolate to predicted display time from the last poses; full app adds CoreMotion gyro (unavailable in App Clip).
- Measure first: one-way delivery latency, and whether WKWebView rAF runs at 60 or 120 Hz on ProMotion devices.

## 9. Feature specs and test targets (added 2026-09-22)

Every feature below is implemented against a published spec or explainer and must pass on iPhone 15 Pro (iOS 27) via `Scripts/regression.py`, plus headless e2e in `polyfill/`. Wire-level details live in `plan/bridge_protocol.md`; per-sample API analysis in `plan/samples_requirements.md`.

| Feature | Spec | Native source | Test targets |
|---|---|---|---|
| immersive-ar core, blend/interaction modes | [WebXR AR Module](https://immersive-web.github.io/webxr-ar-module/) | ARWorldTrackingConfiguration | `polyfill/test/ar-module-conformance.test.ts`; all pages below |
| immersive-vr (opaque, camera off) | [WebXR Device API](https://immersive-web.github.io/webxr/) | ARKit 6DoF, black background | [tests/exit-button](https://immersive-web.github.io/webxr-samples/tests/exit-button.html) |
| hit-test (incl. transient input) | [WebXR Hit Test](https://immersive-web.github.io/hit-test/) | ARSession.raycast + JS plane raycast | [hit-test](https://immersive-web.github.io/webxr-samples/hit-test.html), three.js webxr_ar_hittest |
| anchors | [WebXR Anchors](https://immersive-web.github.io/anchors/) | ARAnchor | [anchors](https://immersive-web.github.io/webxr-samples/anchors.html), [hit-test-anchors](https://immersive-web.github.io/webxr-samples/hit-test-anchors.html) |
| plane-detection | [WebXR Plane Detection](https://immersive-web.github.io/real-world-geometry/plane-detection.html) | ARPlaneAnchor boundary polygon | [proposals/plane-detection](https://immersive-web.github.io/webxr-samples/proposals/plane-detection.html), three.js webxr_ar_plane_detection |
| mesh-detection | [WebXR Mesh Detection](https://immersive-web.github.io/real-world-meshing/) | ARMeshAnchor (LiDAR sceneReconstruction) | [proposals/mesh-detection](https://immersive-web.github.io/webxr-samples/proposals/mesh-detection.html) |
| light-estimation + reflections | [WebXR Lighting Estimation](https://immersive-web.github.io/lighting-estimation/) | ARLightEstimate, AREnvironmentProbeAnchor | three.js webxr_ar_lighting |
| hand-tracking | [WebXR Hand Input](https://immersive-web.github.io/webxr-hand-input/) | Vision DetectHumanHandPoseRequest + LiDAR smoothedSceneDepth | [immersive-hands](https://immersive-web.github.io/webxr-samples/immersive-hands.html), [webgpu/immersive-hands](https://immersive-web.github.io/webxr-samples/webgpu/immersive-hands.html) |
| image-tracking | [WebXR Image Tracking explainer](https://github.com/immersive-web/image-tracking/blob/main/explainer.md) | ARReferenceImage / ARImageAnchor (imageSpace = anchor.transform * Rx(-90°)) | `examples/image-tracking.html` (HoloWeb marker, 0.15 m), [PlayCanvas demo](https://playcanv.as/p/PCsSvN5h/), [Needle sample](https://engine.needle.tools/samples/image-tracking/) |
| dom-overlay | [WebXR DOM Overlays](https://immersive-web.github.io/dom-overlays/) | transparent WKWebView over Metal | plane/mesh-detection samples (root = body) |
| WebGPU layers | [WebXR/WebGPU binding](https://github.com/immersive-web/WebXR-WebGPU-Binding) (XRGPUBinding) | polyfilled over GPUDevice | [webgpu/immersive-ar-session](https://immersive-web.github.io/webxr-samples/webgpu/immersive-ar-session.html), three.js WebGPURenderer examples |
| visibility on interruption | WebXR Device API visibilityState | ARSession interruption, app lifecycle | [tests/interrupted-ar](https://immersive-web.github.io/webxr-samples/tests/interrupted-ar.html) |

Image tracking specifics (from the explainer): feature `'image-tracking'`; `XRSessionInit.trackedImages: sequence<{ ImageBitmap image; float widthInMeters }>` snapshotted at requestSession; `session.getTrackedImageScores()` resolves `'trackable' | 'untrackable'` per image; `frame.getImageTrackingResults()` returns `{ [SameObject] imageSpace, index, trackingState: 'tracked' | 'emulated', measuredWidthInMeters (0 if unknown) }`; no `'untracked'` state; untrackable images never appear; no events. Needs a human holding the phone over the printed marker for the "tracked" check.

Not planned: camera-access (AR Module forbids exposing camera images without consent), depth-sensing, persistent anchors.
