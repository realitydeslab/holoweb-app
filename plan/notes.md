# Notes: HoloWeb planning research

## Repo facts (verified 2026-09-22)
- Xcode 27.0 (27A266a); simulator runtimes iOS 26.5 and iOS 27.0 installed.
- IPHONEOS_DEPLOYMENT_TARGET = 26.0 on all targets.
- Targets: HoloWeb (org.realitydeslab.holoweb), HoloWebClip (org.realitydeslab.holoweb.Clip, parent-app entitlement present), aaa (scratch Metal/ARKit sample copy).
- HoloWeb/webxr2.0.js = Mozilla webxr-ios-js bundle (5688 lines) built on Google webxr-polyfill; expects WebXR Viewer message handlers (initAR, watchAR, requestSession, onUpdate ...).
- HoloWeb/webxr-polyfill.js = 6231 lines (Google webxr-polyfill copy).
- HoloWebState.swift registers ~25 WKScriptMessageHandlers matching the WebXR Viewer protocol; onUpdate handler is stubbed (no data sent back yet).
- ContentView stacks MetalViewRepresentable (ARKit camera background via Renderer.swift, ~508 lines) under a transparent WKWebView; toolbar toggles isStereo / enteredAR.
- Two WKWebView configurations exist: HoloWebState uses new SwiftUI `WebPage` API; WebViewRepresentable builds its own WKWebView and hardcodes https://holoweb.app/test2/ (Unity WebGL build) in updateUIView (reloads every update).
- test.html uses three.js 0.177 WebGPURenderer + ARButton.

## Sources
(to fill)

### WebGPU in WKWebView (verified 2026-09-22)
- Apple Frameworks Engineer, June 2025 (developer.apple.com/forums/thread/770862): Safari feature flags do not affect WKWebView; "For WKWebView, the feature will work when it's enabled by default" -> test on iOS 26 where WebGPU is on by default.
- webkit.org/blog/17333 (Safari 26.0): WebGPU ships on macOS, iOS, iPadOS, visionOS.
- webkit.org/blog/18325 (Safari 27.0, released 2026-09-17): WGSL `clip_distances`; WebXR Layers `textureType: "texture-array"` for projection layers; `srgb-linear` / `display-p3-linear` canvas color spaces; new WKWebView APIs: WKJSHandle, WKContentWorldConfiguration, WKDOMNodeSnapshot. Immersive environments remain visionOS-only. No WebXR on iOS Safari.
- xrdoctors.pro (2026-06-09): "handheld WebXR AR is still not exposed by Safari in 2026"; App Clip launchers (Variant Launch) remain the workaround.
- developer.apple.com/forums/thread/822200: WebContent/GPU process crashes on iPhone 15 + iOS 26.4 in WKWebView; not WebGPU-specific; unresolved. Stability risk to track.
- WKJSHandle (iOS 27.0+): JS calls `window.webkit.createJSHandle(obj)` in a world with `allowJSHandleCreation`; handle is GC-protected and can be passed as an argument to `callAsyncJavaScript`. Candidate for zero-parse per-frame transport (P2).

### three.js + WebGPU + WebXR
- WebGPURenderer falls back to WebGL2 backend automatically; `new WebGPURenderer({ forceWebGL: true })` pins WebGL2. XR on the WebGPU backend needs `XRGPUBinding` (Chrome flag only). A polyfill exposing only XRWebGLLayer therefore requires pages to use the WebGL2 backend (or WebGLRenderer). Ref: discourse.threejs.org/t/webgpurenderer-vr-support/76048, threejs.org/docs WebGPURenderer.

### Polyfill candidates
1. Mozilla webxr-ios-js (bundled as HoloWeb/webxr2.0.js, 5688 lines, MPL-2.0, last real update ~2020). Built on Google webxr-polyfill 2019. Immersive-ar via ARKitDevice; protocol: JS posts `onUpdate` each rAF, native replies `arkitCallbackOnData({timestamp, light_intensity, camera_transform, camera_view, projection_camera, worldMappingStatus, newObjects, removedObjects})`. Single projection matrix for both eyes (`getProjectionMatrix(eye)` ignores eye). The locally patched `getViewport` references an undefined `session` variable (ReferenceError in immersive mode) and returns inconsistent left/right rects.
2. Google webxr-polyfill 2.x (bundled as HoloWeb/webxr-polyfill.js, 6231 lines, Apache-2.0). Abstract `XRDevice` (onFrameStart/onFrameEnd/getViewport/getProjectionMatrix(eye)/getBasePoseMatrix/getBaseViewMatrix(eye)) supports per-eye projection natively. No hit-test, anchors, dom-overlay, layers. Unmaintained since ~2020.
3. IWER 2.4.0 (meta-quest/immersive-web-emulation-runtime, MIT, TypeScript, active 2026). Package `iwer`. XRDeviceConfig: name, supportedSessionModes (incl. 'immersive-ar'), supportedFeatures, supportedFrameRates, environmentBlendModes, interactionMode, userAgent. Runtime knobs: position, quaternion, ipd (0.063), fovy (pi/2), stereoEnabled, installRuntime({globalObject, polyfillLayers, forceInstall}). Has hit-test, anchors, planes, meshes, depth (XRWebGLBinding), hands, action record/replay, native-override mode. Limitation: XRSession.ts computes a symmetric `mat4.perspective(fovy, aspect)` and copies left->right; viewports are fixed half-splits. HoloKit needs per-eye off-axis projection and custom viewport rects -> requires a ~2-point patch (projection override + viewport override).
4. Variant Launch: commercial, closed; validates the App Clip + polyfill approach (camera tracking, hit-test, anchors, dom-overlay, 'local' space; camera frames shipped as base64).

### App Clip constraints (developer.apple.com/documentation/appclip/choosing-the-right-functionality-for-your-app-clip)
- Size: 15 MB (iOS 16 and earlier); iOS 17+: 100 MB only if digital invocation only (no App Clip Codes/QR/NFC), or via the App Store Connect demo link. Our deployment target is iOS 26, so 100 MB applies if we skip physical invocations.
- Unavailable at runtime: CoreMotion (!), BackgroundTasks, Contacts, EventKit, HealthKit, HomeKit, MediaPlayer, Messages, NearbyInteraction, PhotoKit, SensorKit, Speech, AppIntents, CallKit, FileProvider, AssetsLibrary.
- Available: SwiftUI/UIKit and "the same frameworks as your full app" otherwise -> ARKit, AVFoundation camera, WebKit, Metal are fine (Variant Launch proves ARKit in App Clip works).
- identifierForVendor and UIDevice.name return "" in App Clips. No custom URL schemes; use universal links + `appclips:` associated domain. Location only When-In-Use. Full app must contain the same functionality.

### HoloKit stereo math (holokit/holokit-unity-sdk, Runtime/DeviceProfile.cs + HoloKitCameraManager.cs)
HoloKit X specs (meters): OpticalAxisDistance 0.064; MrOffset (0, -0.02894, -0.07055); ViewportInner 0.0292; ViewportOuter 0.0292; ViewportTop 0.02386; ViewportBottom 0.02386; LensToEye 0.02497+0.03898 = 0.06395; AxisToBottom 0.02990; AlignmentMarkerOffset 0.05075. IPD range 0.054..0.074, default 0.064.
Per phone (PhoneModelSpecs): ScreenResolution, ScreenDpi, ViewportBottomOffset, CameraOffset (e.g. iPhone14,2 = (0.042005, -0.05809, -0.00727)), ScreenBottomBorder (e.g. 0.00347). Table in Assets/ScriptableObjects/iOSPhoneModelList.asset covers iPhone11,x .. iPhone17,x.
Projection (left): P00 = 2n/vw; P11 = 2n/vh; P02 = (ipd - vw - gap)/vw; P22 = -(f+n)/(f-n); P23 = -2fn/(f-n); P32 = -1; right: P02 = -leftP02. Where vw = ViewportInner+ViewportOuter, vh = ViewportTop+ViewportBottom, n = LensToEye, fullW = OpticalAxisDistance + 2*ViewportOuter, gap = fullW - 2*vw.
Viewports (normalized screen, landscape): fullWidth = fullW/screenW_m; width = vw/screenW_m; height = vh/screenH_m; centerX = 0.5; centerY = (ViewportBottomOffset != 0 || ScreenBottomBorder == 0) ? (ViewportBottomOffset + vh/2)/screenH_m : (AxisToBottom - ScreenBottomBorder)/screenH_m; left = [0.5 - fullWidth/2, +width]; right = [0.5 + fullWidth/2 - width, +width]; y = centerY +- height/2. screenW_m = px / dpi * 0.0254.
Eye poses: centerEye = cameraPose * T(CameraOffset + MrOffset); left = centerEye * T(-ipd/2,0,0); right = centerEye * T(+ipd/2,0,0). Near plane for eye cameras = LensToEye.

### Bugs in current repo found during survey
- ContentView uses `@EnvironmentObject var state` but apps inject with `.environment(state)` (Observable) -> runtime crash "No ObservableObject of type HoloWebState found".
- WebViewRepresentable.updateUIView calls `uiView.load(...)` on every SwiftUI update (reload loop) and hardcodes https://holoweb.app/test2/.
- HoloWebState builds a `WebPage` with all message handlers, but the displayed WKWebView (WebViewRepresentable) has its own configuration with only `logHandler`; the ARKit bridge handlers never see the page.
- Renderer.swift uses `.landscapeRight` for view/projection/displayTransform; HoloWebState stub uses `.landscapeLeft`.
- webxr2.0.js `getViewport` stereo patch is broken (see above).

### XRGPUBinding polyfill feasibility (three.js dev XRManager.js, checked 2026-09-22)
three.js WebGPU-backend XR path needs only: `globalThis.XRGPUBinding` constructor `(session, GPUDevice)`; `getPreferredColorFormat()`; `createProjectionLayer({colorFormat})` returning `{textureWidth, textureHeight, textureArrayLength, ignoreDepthValues}`; `session.updateRenderState({layers:[layer]})`; per frame `getViewSubImage(layer, view)` returning `{colorTexture: GPUTexture, viewport, getViewDescriptor() -> {dimension:'2d', baseArrayLayer, arrayLayerCount:1}}`; and `session.enabledFeatures` must include `'webgpu'` (else it throws). It allocates its own depth (RenderTarget depth:2, useArrayDepthTexture). All of this is plain JS over a GPUDevice the page created, so a polyfill can implement it: allocate a 2-layer `GPUTexture` (RENDER_ATTACHMENT | TEXTURE_BINDING | COPY_SRC) sized to the eye viewport, and after the app's rAF callback issue `copyTextureToTexture` from each layer into the polyfill canvas's `GPUCanvasContext.getCurrentTexture()` (configured with COPY_DST | RENDER_ATTACHMENT, alphaMode 'premultiplied') at the mono/HoloKit viewport rects, then `queue.submit`. No shader needed. Est. 200-300 lines TS. Unknowns to test on device: WebKit accepting `xrCompatible` in requestAdapter (unknown dict members are ignored per WebIDL), and copy-to-canvas-texture usage support.

## Native execution log (M0-M3)

### M0 (2026-09-22) — device: Holo iPhone 15 I, iPhone16,1, iOS 27.0
- `xcodebuild -scheme HoloWeb -destination id=00008130-000848EA38298D3A build` -> BUILD SUCCEEDED (App Clip embedded). Required `xcodebuild -downloadComponent MetalToolchain` (838.9 MB, Xcode 27 ships without it).
- Installed + launched via devicectl; https://holoweb.app/test2/ (Unity 6000.0.17f1 WebGL) loads, page console forwarded as `[web]` lines. Visual overlay not machine-verified (no screenshot tool); needs a human glance.
- Commit 058c9eb.

### M1 WebGPU check (HoloWeb/Web/webgpu-check.html, launched with HOLOWEB_PAGE=webgpu-check.html)
- navigator.gpu: true. navigator.xr: false. window.webkit.createJSHandle: undefined (preference not yet enabled; M3).
- requestAdapter({xrCompatible:true}) accepted (unknown member ignored).
- adapter.info: vendor/architecture/device/description all "apple" (privacy-bucketed).
- features include clip-distances, shader-f16, float32-filterable, timestamp-query, texture-formats-tier2, primitive-index.
- limits: maxTextureDimension2D 16384, maxTextureArrayLayers 2048, maxBufferSize 1 GiB, maxComputeWorkgroupSizeX 1024.
- preferredCanvasFormat: bgra8unorm.
- Canvas configure with usage RENDER_ATTACHMENT|COPY_DST and alphaMode premultiplied: OK. Rendered into layer 0 of a 2-layer texture and copyTextureToTexture into the canvas: OK. -> XRGPUBinding presenter design is confirmed viable on device.
- WebGL2: works; OVR_multiview2: not exposed (so three.js WebGL XR will not use multiview).
- UA string reports "iPhone OS 18_7" (WebKit UA freeze), so pages must not sniff the iOS version from UA.

### M3 native bridge (HoloWeb/ARBridge.swift, BridgeMath.swift; test page Web/bridge-check.html)
- WKJSHandle works on iOS 27: `configuration.defaultWebpagePreferences.allowsJSHandleCreationInPageWorld = true` (also set per navigation) makes `window.webkit.createJSHandle` available in the page world; the handle arrives inside the `ready` message body as a `WKJSHandle` and works as a `callAsyncJavaScript` argument. Transport reported: "jshandle".
- ready reply on iPhone 15 Pro: model iPhone16,1, nativeBounds 1179x2556, scale 3, dpi 460.
- Frame rate: ARKit 60.5 fps (video format 60). With one call in flight: 30.0 calls/s, 50% skipped, because one callAsyncJavaScript round trip is ~17-20 ms. With max 2 in flight: 59.9 calls/s, 0 skipped. Decision: maxFramesInFlight = 2.
- hitTest round trip: 6-8 ms. Returned 0 hits in the unattended run (phone lying still, ray not aimed at a surface); needs a manual run aimed at the floor.
- Planes: 0 during the 4 s unattended run (no movement). Needs a manual run.
- Unknown message type rejects the JS promise with the error string; no frames arrive after endSession.
- Stereo orientation: HoloKit's Unity LandscapeLeft equals UIInterfaceOrientation.landscapeRight (home side on the right); setMode(.stereo) requests `.landscapeRight`.
- Renderer now follows the interface orientation (was hardcoded .landscapeRight, wrong in portrait), skips the camera image in stereo, and no longer draws the sample's debug anchor cubes.

## App Clip execution log (M6)

2026-09-22, Xcode 27, device Holo iPhone 15 I (00008130-000848EA38298D3A, iOS 27.0).

### Changes
- `HoloWeb/HoloWebClip.entitlements`: added `com.apple.developer.associated-domains = [appclips:holoweb.app]` (kept `parent-application-identifiers`).
- `HoloWeb/HoloWeb.entitlements` (new): `applinks:holoweb.app`, `appclips:holoweb.app`. `CODE_SIGN_ENTITLEMENTS = HoloWeb/HoloWeb.entitlements` set for HoloWeb Debug + Release; file reference added to the HoloWeb group. Patched by Python script; `plutil -lint project.pbxproj` OK.
- `HoloWeb/HoloWebApp.swift`: `.onContinueUserActivity(NSUserActivityTypeBrowsingWeb)` -> `HoloWebLink.targetURL` -> `state.load`.
- `HoloWeb/HoloWebClipApp.swift`: on first launch loads `HoloWebLink.targetURL(_XCAppClipURL)` if set; otherwise waits 2 s for an invocation activity, then falls back to `https://holoweb.app/test2/`. Invocation activities that arrive later still load (skipped if same URL). Each load prints `[clip] <source>: <url>` (source = invocation / _XCAppClipURL / default).
- `HoloWebClip.xcscheme`: `_XCAppClipURL = https://holoweb.app/c?url=https%3A%2F%2Fholoweb.app%2Ftest2%2F` (replaced the old `/launch?url=` value).
- `server/.well-known/apple-app-site-association` (applinks `/c*` for KR9H35SQQ9.org.realitydeslab.holoweb; appclips KR9H35SQQ9.org.realitydeslab.holoweb.Clip) and `server/README.md` (hosting requirements, smart banner tag, App Store Connect steps).

### Signing
- Automatic signing provisioned the associated-domains capability for both bundle IDs without manual portal steps. Signed entitlements: HoloWeb.app has `associated-domains = [applinks:holoweb.app, appclips:holoweb.app]` and `associated-appclip-app-identifiers = [KR9H35SQQ9.org.realitydeslab.holoweb.Clip]`; HoloWebClip.app has `associated-domains = [appclips:holoweb.app]`, `on-demand-install-capable = true`.

### Size (Release, generic/platform=iOS, `-allowProvisioningUpdates`) -> BUILD SUCCEEDED
- `du -sh HoloWebClip.app` = 476 KB uncompressed; main binary `HoloWebClip` = 403,552 bytes (394 KB); default.metallib 22 KB; Web/ 12 KB.
- vs caps: 15 MB physical-invocation cap -> 3% used; 100 MB digital-only cap -> 0.5%. Physical invocations (App Clip Codes, QR, NFC) are viable. Recheck after the polyfill bundle lands in Web/ (expected < 200 KB).

### Device check
- `xcodebuild -scheme HoloWebClip -configuration Debug -destination id=00008130-000848EA38298D3A -allowProvisioningUpdates build` -> BUILD SUCCEEDED.
- `xcrun devicectl device install app ... HoloWebClip.app` -> installed next to the already installed full app `org.realitydeslab.holoweb`; no conflict. (The clip does not appear in `devicectl device info apps`, which only lists the full app.)
- `timeout 20 xcrun devicectl device process launch --console --terminate-existing --environment-variables '{"_XCAppClipURL":"https://holoweb.app/c?url=https%3A%2F%2Fholoweb.app%2Ftest2%2F"}' ... org.realitydeslab.holoweb.Clip`:
  `[clip] _XCAppClipURL: https://holoweb.app/test2/`, 38 `[web]` lines incl. `Initialize engine version: 6000.0.17f1`, `Unity WebGPU: Version: WebGPU 1.0`, `RenderGraph is now enabled.` -> target page loads.
- Distinct URL (`url=https%3A%2F%2Ftoji.github.io%2Fwebxr-particles%2F`): `[clip] _XCAppClipURL: https://toji.github.io/webxr-particles/` plus THREE.js `[web]` warnings -> query parsing drives navigation, not the fallback.
- No env var: `[clip] default: https://holoweb.app/test2/` after the 2 s wait, page loads.
- Full app `HoloWeb` scheme device build also BUILD SUCCEEDED with the new entitlements (not reinstalled).

### Manual steps left
- Deploy `server/.well-known/apple-app-site-association` to https://holoweb.app/.well-known/apple-app-site-association with `Content-Type: application/json` (see server/README.md). Until then universal links / real App Clip invocation cannot be tested; `_XCAppClipURL` is the only path.
- App Store Connect: default App Clip experience + advanced experience for `https://holoweb.app/c`; replace `APP_STORE_ID` in the smart banner tag once the app record exists.
- TestFlight invocation test of `https://holoweb.app/c?url=...` from Safari/Messages.

### M3b latency measurements (iPhone 15 Pro, iOS 27, Web/bridge-check.html)
- One-way native->page delivery via callAsyncJavaScript + WKJSHandle, wall clock sentAt vs performance.timeOrigin+now, last 120 frames: p50 0.5 ms, p90 1.2 ms, max 7.1 ms.
- So the earlier ~17-20 ms was the completion-handler round trip (reply is delivered late), not delivery. Transport latency is negligible; the dominant delay is the page's rAF phase relative to ARFrame arrival (up to one 16.7 ms frame).
- WKWebView requestAnimationFrame on this ProMotion device: 60.5 Hz (not 120).
- `rendered` message sent every rAF tick while streaming: no drop in onFrame rate (60.0/s, 0 skipped).
- Renderer now draws the camera image of the frame the page last reported via `rendered` (3-frame ring in ARBridge); falls back to the newest frame for pages that never report (non-polyfill pages).

## Polyfill execution log (M2, M4-JS)

2026-09-22. Scope: `polyfill/` only (no Swift / Xcode changes). Not committed.

### Built artifacts
- `polyfill/dist/holoweb-polyfill.js`: minified IIFE, 148.0 KB (45.9 KB gzip), budget 250 KB. `polyfill/dist/holoweb-polyfill.dev.js`: 810 KB unminified with inline source map. Not copied outside `polyfill/`; native should bundle the minified file into `HoloWeb/Web/` (App Clip impact about +148 KB).
- Bundle contents: IWER 2.4.0 core + gl-matrix + HoloWeb sources. The build fails if any `iwer/lib/remote` or `iwer/lib/native` byte is bundled. `webxr-layers-polyfill` is stubbed (-60 KB; only used by `polyfillLayers: true`).

### IWER fork
- Chosen: `iwer@2.4.0` pinned + `patch-package` (`polyfill/patches/iwer+2.4.0.patch`, 7 files, 110 changed lines, every hunk tagged `HOLOWEB:`), not vendoring. Reason: upstream publishes compiled `lib/` + `.d.ts`, so one patch file is the whole fork; rebasing = bump the pin + re-run patch-package. Rationale and hunk list are in `polyfill/README.md`.
- Patches: (1) `nativeProjection` per eye with [10]/[14] rebuilt from depthNear/depthFar (immersive + inline); (2) `nativeViewports` per eye; (3) immersive + `stereoEnabled=false` returns one `'none'` view; (4) `renderState.layers` + layers-only frame loop; (5) `onFrameEnd` hook; (6) RemoteControlInterface removed; (7) `XRRay.matrix` axis bug fixed (non-default rays pointed the wrong way); (8) `WebXRFeature` += `light-estimation`, `webgpu`.
- Requirement "installRuntime without navigator.xr / immersive-ar / enabledFeatures echo incl. webgpu" needed no patch (device config); the config passes the real UA because IWER overwrites `navigator.userAgent`.

### Verification (all run on this Mac)
- `npm run typecheck` (tsc 7.0.2, strict): clean.
- `npm test` (vitest 5, happy-dom): 25/25 pass. `test/stereo.test.ts`: iPhone14,2 golden values from an independent Python transcription of `HoloKitCameraManager.SetupCameraData` (runtime screen 2532x1170, 460 dpi): P00 2.1900685, P11 2.6802179, P02 0 at ipd 0.064 and +/-0.1027397 at ipd 0.070 (right eye sign flip), P22 -1.0001279, P23 -0.1279082 (near 0.06395, far 1000); viewports left (158, 47, 1058, 864), right (1317, 47, 1058, 864) px, bottom-left origin; cameraToCenterEye (WebXR, z towards user) (0.042005, -0.08703, 0.07782). Mono [10]/[14] rewrite equals `mat4.perspective` with the new depth range. `test/bridge.test.ts`: ready posts a WKJSHandle, requestSession resolves the reply, feature echo incl. webgpu, mono/stereo onFrame -> viewer pose + projections, rendered posted per frame, JS hit test against onPlanes, endSession on page end, no echo on native end.
- `npm run test:e2e` (Playwright 1.63 Chromium, headless, `--enable-unsafe-webgpu`, WebGPU adapter present): 8/8 pass. Covered: `examples/three-ar.html` (WebGPURenderer forceWebGL) and `examples/three-ar-webgpu.html` (WebGPU backend + XRGPUBinding), each in mono and stereo; WebGL mono->stereo and stereo->mono mid-session; WebGPU mono->stereo (session ends, page re-enters); WebGPU stereo with a late phone-model change (presenter blit path). Each case asserts: no console errors or GPU warnings, >= 60 XR frames, hit-test results, tap placed an object, expected view count (1/2), expected backend, reticle pixels visible in a screenshot. Screenshots were also checked by eye.
- Not run: anything on a device. The WebGPU presenter compositing over the Metal camera layer, HoloKit alignment, and three.js performance at native resolution on iPhone are unverified.

### Protocol deviations / clarifications (plan/bridge_protocol.md)
- `requestSession` goes to native only for `immersive-ar`; inline sessions stay JS-only, so native never sees `mode: "inline"`.
- `onFrame`: `transform` is used as the viewer pose (per the updated protocol); `view` is only a fallback. `orientation` is stored; `sentAt` becomes `__holoweb.bridge.latest.latencyMs`.
- `rendered { t }` is posted after every immersive XR frame in both modes, fire and forget; `t` = timestamp of the latest applied frame.
- `onPlanes[].transform` is assumed to be the plane centre pose (ARPlaneAnchor.transform x T(center)) with local +Y = normal and `extent` along local X/Z.
- Stereo orientation: the protocol text says `.landscapeLeft`, but the phone-table offsets assume Unity LandscapeLeft = `UIInterfaceOrientation.landscapeRight`. That matches native's `setMode(.stereo)` (M3 log). The protocol text should be updated.
- Native `hitTest` is exposed as `__holoweb.hitTest(origin, dir)` (one round trip, 6-8 ms measured by native). `XRHitTestSource` results come from the JS plane raycast (in frame, zero IPC).
- Mono <-> stereo during a session: WebGL sessions follow it. Sessions rendering through XRGPUBinding are ended, because three.js' WebGPU backend cannot change view count mid-session (crash reproduced in e2e before the fix).

### Findings worth knowing
- three.js r186 WebGPURenderer, WebGL2 backend, flips XR sub-camera viewports as if they were top-left (`context.height - height - y`). This is harmless for full-height viewports, but it moves HoloKit eye rects up by H - 2y - h px (~130 of 780 px in e2e). The WebGPU backend and classic WebGLRenderer are correct. Recommend the WebGPU backend for stereo content until this is fixed upstream.
- three.js' WebGL2 backend needs a non-null `XRWebGLLayer.framebuffer` (it is used as a WeakMap key). The polyfill hands out a sentinel framebuffer that the context maps to the default framebuffer, so there is no copy and no extra GPU pass.
- three.js reads `framebufferWidth` right after `setPixelRatio(1)`, so the layer must report the native size itself; otherwise the XR target is 1/dpr size and offset.
- IWER's `local` space is anchored at the viewer pose at request time; it is overridden to the ARKit origin.
- While immersive, page content is hidden except the XR canvases and the dom-overlay root, and html/body backgrounds are transparent (otherwise page backgrounds hide the camera and page text shows in the headset).

### Open issues
- Device run needed: three-ar / three-ar-webgpu over the camera (mono), HoloKit X alignment (stereo), fps at native resolution.
- `light-estimation` is advertised but there is no `XRLightProbe` API yet (M7); the latest estimate is on `__holoweb.bridge.latest.light`.
- `local-floor` is computed at request time; no `reset` event when the floor estimate changes.
- Anchors are IWER's static anchors, not ARKit anchors (M7).
- `XRGPUBinding` supports `textureType: 'texture-array'` only; canvas and layer sizes are fixed at session start (no rotation handling in mono).
- Single-touch input only; `beforexrselect` is not implemented.

## Integration on device (M2 + M4 + M5 smoke), iPhone 15 Pro, iOS 27
- Polyfill injected from HoloWeb/Web/holoweb-polyfill.js (148 KB) at document start. `Scripts/sync-polyfill.sh` builds polyfill/ and copies the bundle + examples into HoloWeb/Web/.
- Bundled pages are served at holoweb-app://local/... by BundledPageSchemeHandler, because file:// pages cannot import local ES modules (WebKit: "Cross-origin script load denied by Cross-Origin Resource Sharing policy"). The custom scheme keeps navigator.gpu, navigator.xr and createJSHandle available.
- Unattended runs with `?autostart` (and `&mode=stereo`), stats every 2 s, phone lying still:

| Example | Mode | Backend | Views | XR fps (steady) | Canvas | Errors |
|---|---|---|---|---|---|---|
| three-ar.html | mono | webgl | 1 | 60 | 2556x1179 | none |
| three-ar-webgpu.html | mono | webgpu (XRGPUBinding) | 1 | 60 | 2556x1179 | none |
| three-ar-webgpu.html | stereo | webgpu (XRGPUBinding) | 2 | 60 | 2556x1179 | none |
| three-ar.html | stereo | webgl | 2 | 58.5-59.5 | 2556x1179 | none |

- Bridge: ~20 frames skipped only in the first second (page startup), then 0. Delivery latency ~0-1 ms (small negative values are wall-clock jitter between processes).
- Not yet verified (needs a person holding the phone): visual camera/content alignment in mono, hit-test reticle on a real floor (hitFrames stayed 0 because the phone was lying still with no planes), HoloKit X optical alignment in stereo.

### M7 native: ARKit anchors (iPhone 15 Pro, iOS 27)
- createAnchor adds an ARAnchor (name "holoweb") and replies with its id; tracked poses go to the page via onAnchors at <=10 Hz; removed anchors are sent once with transform null; deleteAnchor removes it. Page anchors are removed on navigation.
- bridge-check: createAnchor 0.5 m in front of the camera -> onAnchors delivered within 400 ms with z = -0.500 (requested -0.500). onFrame stayed at 60.0/s.
- Regression: default remote Unity WebGPU page (https://holoweb.app/test2/) still loads with the polyfill injected (Unity WebGPU 1.0 device, RenderGraph enabled), no errors.

### Native review fixes (reviewer subagent findings, 2026-09-22)
Fixed: bridge reset moved from didStartProvisionalNavigation to didCommit (failed navigations no longer kill the bridge); holoweb handler rejects non-main-frame messages; anchors held as [id: ARAnchor] so removal never depends on currentFrame, and removed on page change; ARSession didFailWithError -> markARStopped + onSessionEnded(reason); page-generation counter ignores completions from a previous page; recentFrames cleared whenever streaming stops; NaN/Infinity and zero-length directions rejected; hitTest tries existing plane geometry before estimated planes (type "plane" now reachable); isInspectable only in DEBUG; http dropped from HoloWebLink; weak proxies for script message handlers (no retain cycles); ARKit starts on requestSession and pauses on endSession/page change instead of at app launch. ARBridge split into ARBridge.swift + ARBridge+Frames.swift.
Re-verified on device: bridge-check 60.0 onFrame/s, anchors round trip, no frames after endSession; three-ar mono 60 fps.
Open (product decision): pages opened through holoweb.app/c?url= get pose, planes and light with no origin display or consent prompt. Options: show the page origin on session start, per-origin consent, or a first-party allowlist.
Open (polyfill): re-post `ready` on `pageshow` with persisted=true (bfcache restore does not re-run scripts); onAnchors callback (in progress in M7 batch).
