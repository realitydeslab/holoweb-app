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

## Polyfill execution log (M7, prediction)

2026-09-22. Scope: `polyfill/` only; not committed; `Scripts/sync-polyfill.sh` not run (it writes HoloWeb/Web, native's side).

### Delivered
1. **Anchors** (`src/anchors.ts`). `XRFrame.createAnchor` and `XRHitTestResult.createAnchor` post `createAnchor { pose }` (world pose) and resolve with an `XRAnchor` on the `{ id }` reply. `onAnchors` updates anchor spaces. `transform: null` removes the anchor from session/frame `trackedAnchors`, keeps its last pose, and later `delete()` calls post nothing. `delete()` on a live anchor posts `deleteAnchor { id }`. `requestPersistentHandle` rejects NotSupportedError, because ARKit origins differ per session and IWER's persistence is localStorage poses. Ids are dropped when the session ends.
2. **Light estimation** (`src/light.ts`). `session.requestLightProbe()` (NotSupportedError without the feature), `frame.getLightEstimate(probe)` (null until native sends `light`), `preferredReflectionFormat = 'srgba8'`, and the globals `XRLightProbe` and `XRLightEstimate`. Conversion:
   - k = lux / 1000; tint = Tanner Helland Kelvin->RGB, normalised to unit Rec.709 luminance.
   - SH L0 only: c0 = 0.5 * k * tint * 2*sqrt(pi) (projection of constant radiance onto Y00).
   - primaryLightIntensity = 0.5 * pi * k * tint from direction (0,1,0).
   - The 50/50 split makes a white upward surface reflect k * tint under three.js' lighting model.
   - This is a documented choice, not a calibration.
3. **local-floor reset** (`src/floor.ts`). The floor starts at -1.3 m, then follows the lowest horizontal plane below the origin (only downwards once planes define it). When it moves > 2 cm, every local-floor space gets the new offset plus a `reset` event whose transform is the new origin in the old space.
4. **Stereo pose prediction** (`src/prediction.ts`). Extrapolates the camera pose from the last two frames (linear translation, slerp with factor 1 + h/dt, normalised), then applies CameraOffset + MrOffset. The default is 25 ms; `__holoweb.setPrediction(ms)` changes it and 0 disables. No prediction when the gap is > 100 ms or out of order, and the factor is capped at 4. Mono resets the predictor and never predicts. `rendered.t` stays the ARFrame timestamp.
5. **Rotation in mono**: handled without reallocation; the reason is in the code.
   - three.js ignores `setSize` while presenting. `setXRRenderTargetTextures` only swaps the colour texture, and three's XR render target plus depth-array/MSAA attachments keep their session-start size, so a reallocated layer of a new size would mismatch them.
   - The polyfill therefore keeps targets fixed (`XRWebGLLayer.framebufferWidth/Height` are now fixed per layer, and the canvas is sized from them).
   - Presentation scales: the WebGL canvas is CSS-stretched; the WebGPU presenter canvas follows the new size and uses its blit path.
   - Native's `proj` already matches the new aspect, so geometry is correct and only the sampling density changes. `bridge.layoutChanges` counts orientation or size changes.
6. **examples/ar-scene.js**:
   - Adds `anchors` + `light-estimation` to optionalFeatures.
   - Tap places a mesh on `hit.createAnchor()`, created in-frame, and the mesh follows `trackedAnchors`.
   - A light probe runs every frame.
   - `?stats` now logs `anchors`, `placed`, `light` (sh0 + primary) and `nativeLight`.
   - The native autostart/stats code is kept.

### Verification
- `npm run typecheck`: clean. `npm run build`: 154.3 KB (47.9 KB gzip), was 148.0. The IWER patch is unchanged (110 lines); all M7 work is outside the patch.
- `npm test`: 47/47, up from 25.
  - New `test/prediction.test.ts` (10): linear translation, constant angular velocity (2 deg/frame -> +3 deg at 25 ms), 30 deg/frame about a tilted axis, orthonormality, the shortest path through 180 deg, disabled/unusable samples (0 ms, no prev, dt 0, out of order, gap > 100 ms), factor cap, predictor buffer copy and reset.
  - New `test/light-floor.test.ts` (7): Kelvin->RGB and the luminance normalisation, the lux/K mapping and energy split, floor tracking/threshold/monotonic behaviour, and reset transforms.
  - `test/bridge.test.ts` +5, through the real IWER session:
    - Anchor create/track/move/lost/delete.
    - Light probe estimate and rejection without the feature.
    - local-floor reset from onPlanes.
    - Stereo prediction applied, mono not predicted, `setPrediction(0)` disabling it.
- `npm run test:e2e`: 10/10.
  - Every case now also asserts >= 1 tracked native anchor after tap-to-place and a light estimate reaching the page.
  - New cases: mono rotation to portrait on WebGL and on WebGPU (presenter blit). They assert no errors, the reticle centred within 12 %, and that the bridge saw the layout change.
  - Portrait screenshots checked by eye: undistorted (round cylinder tops) on both backends.
- Not run on a device.

### Open issues / for native
- Anchor ids are sent back as strings (`String(id)`); native should accept string ids in `deleteAnchor`.
- The prediction horizon is a constant 25 ms from ARFrame arrival. It ignores the rAF phase, so the horizon should be tuned on HoloKit with `?stats` + `setPrediction`.
- The light conversion is uncalibrated; there is no environment cube map.
- A mono rotation keeps the session-start resolution until the page re-enters XR.
- Also done (native's open item): the polyfill re-posts `ready` (with a new WKJSHandle) on `pageshow` with `persisted=true`, because a bfcache restore does not re-run scripts. Unit test added: 48/48; e2e 10/10 re-run; bundle 154.4 KB.

### M7 + stereo prediction on device (iPhone 15 Pro, iOS 27)
- Polyfill 154.4 KB (48.0 KB gzip); 48/48 unit tests pass locally.
- three-ar mono (WebGL) and three-ar-webgpu stereo: 60 XR fps, no errors, light estimate reaches the page (native ~930-1050 lux / ~5000-5060 K -> sh0 ~1.8-2.0, primary tint warm-white).
- Web/xr-anchor-check.html (WebXR Anchors API through polyfill + ARKit): createAnchor resolved in 2.0 ms, tracked at z = -1.000 for 4 s, delete() -> trackedAnchors 0, session ended cleanly.
- Needs a person with the phone: prediction horizon tuning in HoloKit (`__holoweb.setPrediction(ms)`, default 25 ms), light estimate appearance in real rooms, rotating the phone mid-session in mono, tap-to-place on a real floor.

## Polyfill execution log (mid-session mono/stereo toggle on WebGPU)

2026-09-22. Scope: `polyfill/` only; not committed; `Scripts/sync-polyfill.sh` not run.

### Root cause (three.js r186, WebGPU backend)
- `WebGPUBackend._getRenderPassDescriptor` caches descriptors per `getCacheKey(renderContext)` = (activeCubeFace, mip level, texture ids). For an ArrayCamera on a depth-array target it builds one colour attachment per camera, `cameras.length` at first use.
- XR renders into the renderer's intermediate framebuffer target, which always exists by default (output colour space != working space). That target is not external, so its descriptor stays cached for the whole session.
- Starting in mono caches a 1-attachment descriptor. At the first stereo frame `_createArrayCameraLayerDescriptors` reads `colorAttachments[1].view` (TypeError). Reproduced headless with the old end-session policy disabled.
- A descriptor first built for 2 cameras serves both 1 and 2 cameras (2 -> 1 -> 2 was fine).
- `_getRenderPassDescriptor` only invalidates on target width/height/samples changes, none of which the polyfill can influence.
- The proper fix is upstream: include the ArrayCamera size in the cache key.

### Change
- Sessions are no longer ended on a mode change (removed from `session.ts` / `bridge.ts`).
- `gpu-binding.ts` primes three's cache:
  - In a mono session with an XRGPUBinding layer, `getViewerPose` appends a `right` "priming" view until the page has rendered two views into the layer for 3 frames (`PRIME_FRAMES`).
  - The priming view has the mono pose (ipd 0, so three's `setProjectionFromUnion` gives the mono frustum) and the mono projection with P[9] = 1e4. Every vertex in front lands at y_ndc ~ -1e4, so it rasterises nothing: the cost is one extra vertex/draw submission pass for ~3 frames.
  - After priming, mono is a true single view.
- The presenter skips views of the other mode (the priming view in mono).
- Evaluated and rejected: keeping 2 views in mono permanently (idea from the task). It doubles three's per-draw CPU encoding and vertex work for the whole session, and exposes a fake second eye to pages all the time.
- Cost note: the layer size is fixed at creation (three sizes its XR targets once). Starting in mono (the normal flow), stereo eyes render at full-framebuffer size and are scaled into the HoloKit rects, about 2x the mono pixel cost.
- `examples/demo.html`: documents the normal flow (Start AR in mono, then the native toggle). `?mode=stereo` and `?autostart` are marked as test aids for unattended runs.

### Verification
- `npm run typecheck` clean. `npm run build`: 154.7 KB (48.1 KB gzip).
- `npm test`: 51/51. New `test/gpu-priming.test.ts` with fake WebGPU checks three things:
  - Priming for the first frames, then one view.
  - The actual priming view: same transform; P[0], P[5], P[8], P[10], P[11], P[14] unchanged; y_ndc < -1000 for points in front.
  - The presenter copies only layer 0 in mono; a stereo toggle then mono follow without ending the session.
- `npm run test:e2e`: 10/10.
  - New: three-ar.html (WebGL) and three-ar-webgpu.html (WebGPU) toggled mono -> stereo -> mono -> stereo mid-session. Each phase waits > 20 XR frames and asserts the view count (phases `mono:1 stereo:2 mono:1 stereo:2` on both), no console errors or GPU warnings, and that the session is still active.
  - New: demo.html `?autostart` with the same toggles, sampled through the page's own XR session (`mono:1 stereo:2 mono:1 stereo:2`, presenter active).
  - Removed: the obsolete "WebGPU session ends and re-enters" case and the single WebGL switch cases (covered by the toggle cases).
  - Headless fps per phase over 1.5 s: WebGPU 60/60/60/60/60, WebGL 58-60, no hitch visible at the switches.
- Not run on a device.

## Polyfill execution log (stale right eye after stereo -> mono, old three.js)

2026-09-22. Scope: `polyfill/` only; not committed; `Scripts/sync-polyfill.sh` not run.

### Cause (confirmed from source)
- toji.github.io/webxr-particles ships three.js `REVISION = '111dev'`.
- Its `WebXRManager` builds `cameraVR = new ArrayCamera([cameraL, cameraR])` once. `onAnimationFrame` updates `cameraVR.cameras[i]` only for `i < views.length` and never shrinks the array.
- After stereo -> mono, cameraR keeps its stereo viewport, pose and projection and is rendered every frame. three r110 does the same.
- three r117 and later rebuild the camera list when the view count changes (checked in the 0.117.1 source), so the fixture pins 0.110.0.

### Fix
- New `src/views.ts` view-count policy: within a session the reported view count never drops below the maximum the page has seen.
  - A mono-only session keeps one view.
  - Mono after stereo reports `[mono 'none' view, inert 'right' view]`.
  - The inert view has the mono pose (three's union frustum = mono), IWER's zero-width mono 'right' WebGL viewport, and the mono projection with P[9] = 1e4, so it rasterises nothing.
  - The WebGPU presenter ignores it. For WebGL no presenter is involved: zero-area viewport plus no fragments.
- The XRGPUBinding descriptor priming now uses the same inert view (`needsPrimingView` is the extra reason).
- Trade-off: after any stereo trip, mono sessions pay one extra vertex/draw-submission pass per frame (no fragments) for the rest of the session.
- IWER patch hunk 9: the per-frame immersive clear temporarily disables a page-left `SCISSOR_TEST`, so the whole framebuffer is cleared (including the old right-eye region). Patch is now 117 changed lines.

### Verification
- `npm test`: 53/53.
  - New tests: a mono-only session keeps 1 view; stereo -> mono gives `none,right` with the inert view having the same transform, the same union-relevant projection terms, a zero-area WebGL viewport and no rasterisation; each new session starts afresh.
  - The priming test was updated (mono after stereo keeps the inert view; the presenter still copies only layer 0).
- `npm run test:e2e`: 12/12 with `HOLOWEB_E2E_TOJI=1` (11 without; the Toji case is opt-in because it needs the network).
  - `examples/fixtures/old-three-r110.html` (three 0.110.0 via jsdelivr, served locally from `three-r110`; WebGLRenderer + `renderer.vr`): a green backdrop on layer 1 (cameraL / mono) and a red backdrop on layer 2 (cameraR only).
    - Screenshot: mono red 0; stereo red 399,256 px in the right half; mono again red 0 with green covering the right half.
    - Spy: `gl.viewport(877,39,698,572)` (the stereo right-eye rect) is called in stereo and never after returning to mono.
  - Live https://toji.github.io/webxr-particles/ with the bundle injected at document start (as the app does) against mock-native, AR button, mono -> stereo -> mono: the right-eye rect is used in stereo and never in mono; 0 page console errors.
  - Toggle cases now expect `mono:1 stereo:2 mono:2 stereo:2` (three-ar WebGL, three-ar-webgpu, demo.html).
- Negative control: building with the policy disabled (priming only) made both toggle cases, the fixture and Toji fail. The fixture showed 55,796 stale red px in mono and the right-eye `gl.viewport` still called; Toji also still called the right-eye rect in mono. This is the device bug, reproduced headless. The policy was restored and the bundle rebuilt.
- Build: 154.9 KB (48.1 KB gzip). Not run on a device.
- Follow-up (same batch):
  - The inert view now has a true 0x0 viewport: `nativeViewports.right = {0,0,0,0}` in mono, so `XRWebGLLayer.getViewport` returns 0x0; `XRGPUBinding.getViewSubImage` returns `XRViewport(0,0,0,0)` for it. Before this, IWER's default was width 0 with full height.
  - The fixture moved to three@0.111.0 (`examples/fixtures/old-three-r111.html`, devDep `three-r111`); r111 has the same fixed-ArrayCamera code as Toji's r111dev.
  - `examples/ar-scene.js` `?stats` JSON has `views` (unchanged: number of XR views reported) and `activeViews` (views whose XRViewport has non-zero width and height, taken from three's XR sub-camera viewports, which are the `getViewport` / `getViewSubImage` viewports; 0 when not presenting).
  - Headless `?autostart&stats` lines, mono -> stereo -> mono: three-ar.html views 1/2/2, activeViews 1/2/1; three-ar-webgpu.html the same.
  - Toggle e2e cases assert both (phases `mono:1/1 stereo:2/2 mono:2/1 stereo:2/2`).
  - `npm test` 53/53, `npm run test:e2e` 12/12 (with HOLOWEB_E2E_TOJI=1), build 155.0 KB (48.2 KB gzip).

## Polyfill execution log (hand tracking: Vision hand pose + LiDAR -> WebXR Hand Input)

2026-09-22, requested by the user. Scope: `polyfill/` + this note; not committed. Native side not implemented; the proposal is below.

### Proposed protocol addition (for plan/bridge_protocol.md, native owner to confirm)
- The polyfill advertises `hand-tracking`. Native runs hand tracking only when `requestSession.features` contains it.
- native -> JS: `bridge.onHands(hands)` after each Vision result (~30 Hz), `hands = [{ handedness: "left" | "right", joints: number[63], confidence: number[21] }]`. Send `[]` when no hand is found.
  - `joints`: 21 points x (x, y, z), ARKit world space, metres, Vision order: 0 wrist; 1-4 thumb CMC, MP, IP, tip; 5-8 index MCP, PIP, DIP, tip; 9-12 middle; 13-16 ring; 17-20 little.
  - `confidence`: Vision per-joint confidence.
- Suggested native pipeline:
  1. Run `VNDetectHumanHandPoseRequest` (maximumHandCount 2) on `ARFrame.capturedImage`, orientation `.up` (sensor orientation), on a background queue. Drop frames while busy; never block the ARSession delegate.
  2. Convert each Vision point (normalised, lower-left origin) to capturedImage pixels (u, v).
  3. Sample `smoothedSceneDepth.depthMap` (256x192, scaled coordinates) at (u, v); skip or flag low `confidenceMap`. If a joint has no valid depth, use the median depth of the valid joints.
  4. Unproject with the intrinsics at capturedImage resolution: X = (u - cx) / fx * d, Y = -(v - cy) / fy * d, Z = -d.
  5. Transform to world with the raw `ARCamera.transform` (sensor orientation, matching the image), not the display-oriented pose.
- `chirality` from Vision gives `handedness`; its meaning with the back camera needs a device check.
- Phones without LiDAR: hand-size depth estimate (wrist to middle MCP ~9 cm) or no hands. JS works either way.

### Polyfill side (done)
- `src/hands.ts` (pure):
  - Maps 21 -> 25 joints: thumb 1:1; finger MCP/PIP/DIP/tip -> phalanx-proximal/intermediate/distal/tip; `<finger>-metacarpal` = lerp(wrist, MCP, 0.25).
  - Joint frames: -Z along the bone towards the tip (tips reuse the last bone); +Y out of the back of the hand from cross(indexMCP - wrist, pinkyMCP - wrist), negated for right hands; right-handed.
  - Radii are typical adult values.
  - Pinch uses thumb tip to index tip with hysteresis (< 2 cm on, > 3.5 cm off).
- `src/hand-input.ts`:
  - Drives IWER's left/right `XRHandInput` objects, which already provide `inputSource.hand` (XRHand of 25 XRJointSpaces), `getJointPose`, `fillPoses`, `fillJointRadii` and inputsourceschange.
  - Two per-instance overrides, no IWER patch needed: IWER's per-frame canned-pose `updateHandPose` is replaced with a no-op, and its gamepad trigger (which fires `select` on press) is disabled.
  - Events are dispatched in spec order: `selectstart` on pinch, `select` + `selectend` on release. Events start the frame after the page sees the source.
  - Target ray: origin at the pinch point, pointing away from the viewer through it.
  - Joints under 0.3 confidence keep their last position; incomplete skeletons are ignored.
  - A hand is dropped 250 ms after its last update (`selectend` only, if it was pinching).
  - Only sessions with `hand-tracking` get hand input sources (IWER filters the rest).
- Mock native sends a synthetic right hand for `hand-tracking` sessions (`src/mock-hands.ts`): 35 cm in front of the camera, pinching 0.8 s of every 2.4 s, at 30 Hz.
- `examples/three-ar-hands.html`: three.js `XRHandModelFactory` 'spheres'; pinch drops a cube at the index fingertip; `?backend=webgl` option.

### Verification
- `npm test`: 62/62. New `test/hands.test.ts` (9 tests):
  - The joint list equals IWER's XRHandJoint order.
  - Position mapping and the metacarpal estimate.
  - Orientation: -Z along the bone, +Y dorsal for right and mirrored left hands, orthonormal with det +1, tips continue the last bone.
  - Pinch hysteresis; incomplete hands rejected.
  - Integration through an IWER session: one right hand source with 25 joints and inputsourceschange; `getJointPose` tip position and radius, `fillPoses`, `fillJointRadii`.
  - Event order `selectstart` -> `select`, `selectend`; loss after 250 ms gives `selectend` only; no hand sources without `hand-tracking`.
- `npm run test:e2e`: 13/13 (2 new).
  - three-ar-hands.html on WebGPU and on WebGL: hands=1, joints=25, handSelects=1, cubes=1, hand model visible (12,475 / 14,221 drawn px).
  - Screenshot checked by eye: a right hand from the back, fingers up, thumb on the left, the cube at the pinch point.
- Build: 160.6 KB (50.1 KB gzip), +5.6 KB. Not run on a device (needs the native half).

### Open
- +Y = back of the hand follows my reading of the WebXR Hand Input joint convention. Verify on device with three's `XRHandMeshModel` (mesh profile): the hand mesh must not appear palm-flipped.
- Vision chirality semantics with the rear camera, depth holes at fingertips, and the latency of Vision (~10-15 ms) + delivery all need device tuning.

## Native execution log (planes polygon, environment map, test click)
2026-09-22, iPhone 15 Pro "Holo iPhone 15 I" (iPhone16,1, iOS 27), phone lying still on a desk.

Changes:
- `onPlanes` items now include `polygon` and `lastChanged` (ARBridge+Frames.swift). The polygon is the boundary vertices in the frame of the sent transform (inverse of T(center)*Ry(rotationOnYAxis)), with y = 0. The code measures winding with a signed area and reverses it when needed, so the output is CCW seen from +Y whatever order ARKit uses. The first plane logs `[bridge] ARKit plane boundary winding ...` (not seen yet: no planes). An offline swiftc check with a rotated, offset rectangle recovered the rectangle exactly, CCW for both input windings. `lastChanged` = ARFrame timestamp (ms) of the plane's last didAdd/didUpdate.
- `onEnvironment` (new EnvironmentProbeReader.swift). Source on device: rgba16Float cube, 256x256, 9 mips. The code blits mip 3 (32x32) into a shared buffer, converts linear half floats to sRGB bytes in the command-buffer completion handler, and sends at most 1 Hz. Metal and GL use the same cube face order and the same (s,t) formulas, with t=0 = first row, so faces and rows are copied unchanged (see the file header). Maps are sent only if the requestSession features include `light-estimation` (added to bridge_protocol.md). While the phone lies still, ARKit updates the probe once, so one map is sent per session.
- `[bridge] requestSession features=...` and `[bridge] planes sent n= polygons=` (every 2 s at most) diagnostics.
- DEBUG `HOLOWEB_TEST_CLICK=<selector>`: 2.5 s after each main-frame didFinish, clicks the element, with up to 5 retries 1 s apart.
- regression.py: `env-plane-check.html` page checks and `third_party_run` for the three.js hittest, plane_detection and lighting examples.

`Scripts/regression.py --skip-polyfill --device 00008130-000848EA38298D3A`: 51/61 passed.
- env.*: 4/4 PASS (6 x 4096 bytes, face means 118/112/96/112/109/117).
- three-hittest: 4/4 PASS (pushed 1560, skipped 0). three-lighting: 6/6 PASS (features light-estimation,dom-overlay,viewer,local; env map sent). The old bundled polyfill has no `onEnvironment` yet, so the call logs one `[bridge] call failed`.
- FAIL planes.* (5): 0 planes, because the phone sees no surfaces. A person needs to hold the phone over a floor or table.
- FAIL three-plane-detection (5): the bundled polyfill predates plane-detection support ("One or more required features are not supported by the device"), so no session starts. Re-run after Scripts/sync-polyfill.sh, with the phone pointed at a surface.

## Polyfill execution log (plane detection, reflections, offerSession, iframes, AR Module conformance)

2026-09-22. Scope: `polyfill/` + this note; not committed. Three queued batches.

### 1. three.js AR examples: hittest, plane_detection, lighting
- `plane-detection` (`src/planes.ts`):
  - One IWER `XRPlane` per native plane id, reused while it lives; three's `XRPlanes` keys meshes by the object and builds each mesh once.
  - planeSpace = plane transform (+Y normal); polygon = DOMPointReadOnly[] from native `polygon` (fallback: extent rectangle); orientation.
  - lastChangedTime is updated only when native `lastChanged` or the geometry changes.
  - Added to `frame.detectedPlanes` each frame for sessions with the feature. IWER's per-frame canned planes path stays empty.
  - The hit test now uses the polygon (even-odd point-in-polygon) instead of the extent.
- Reflections (`src/reflection.ts`):
  - The global `XRWebGLBinding` is a subclass of IWER's (depth untouched) that remembers its GL context.
  - `getReflectionCubeMap(probe)` returns one cube texture per context: SRGB8_ALPHA8 on WebGL2, EXT_sRGB/RGBA on WebGL1. It is updated in place per new `onEnvironment` map and null before the first map.
  - Saved/restored GL state: the cube binding, UNPACK_FLIP_Y / PREMULTIPLY / ALIGNMENT, ROW_LENGTH / SKIP_*, and the PIXEL_UNPACK_BUFFER binding.
  - `reflectionchange` fires on every live probe per new map, and once for probes created after a map arrived.
  - `requestLightProbe({ reflectionFormat })` accepts only 'srgba8'.
  - `onreflectionchange` is a listener-backed accessor, IWER's pattern (a class field was double-invoked by happy-dom).
  - Verified against r186 `XREstimatedLight`: it checks `'XRWebGLBinding' in window` and writes the returned WebGLTexture into `renderer.properties.get(env).__webglTexture`. So it needs a real cube texture on the page's context, which it gets.
  - No `createProjectionLayer` was added, so three keeps XRWebGLLayer (WebGL) and XRGPUBinding (WebGPU).
- Mock (`src/mock-environment.ts`): floor (grows at 1 s: new lastChanged), table octagon, wall; 32x32 sky/ground gradient cube map at start and again at 2 s.
- Also: `requestHitTestSourceForTransientInput` / `getHitTestResultsForTransientInput` (`src/hittest-transient.ts`). They were found missing by the A-Frame e2e (A-Frame `ar-hit-test`), and use the same plane raycast for 'screen' / 'transient-pointer' sources.
- e2e (`scripts/e2e-three-official.mjs`): the three official pages are unmodified.
  - They are vendored in `test/fixtures/threejs-r186` and served under their threejs.org URLs; `HOLOWEB_E2E_LIVE=1` uses the live pages, which also pass.
  - build/jsm come from local r186; live threejs.org is also r186.
  - The bundle is injected at document start; the scene is observed via three's `__THREE_DEVTOOLS__` hook; `#ARButton` is clicked.
  - hittest: reticle becomes visible.
  - plane_detection: `XRPlanes` has 3 meshes, still 3 after the plane update (identity stable).
  - lighting: `estimationstart`, `XREstimatedLight.environment` backed by the polyfill cube (bindTexture(CUBE_MAP) without GL error), reflectionchange 1, cube served 1.
  - `scene.environment` is informational: the page's 2K HDR default loads in parallel and its callback overwrites `scene.environment` when it finishes after estimationstart. This is a race in the example; tap Start AR after the page has loaded on device.

### 2. offerSession and same-origin iframes
- `offerSession` removed from IWER's XRSystem.prototype. A-Frame 1.8 `enterVR(false, true)` then resolves "OfferSession is not supported." instead of an unhandled "Failed to enter VR mode".
- `ready` is lazy: each frame posts `{ type: 'ready', frame: 'main' | 'sub', bridge }` on its first `isSessionSupported` / `requestSession` (`bridge.ensureReady`). `pageshow` with persisted re-posts only if the frame had announced.
- e2e:
  - `examples/fixtures/iframe-host.html` (three-ar.html in a same-origin iframe): AR entered from the iframe; main frame ready=0, iframe ready=1 as 'sub', iframe XR loop 20 frames, 1 view.
  - Live A-Frame 1.8 model-viewer: offerSession not exposed, AR button -> ar-mode, 20 XR frames, a tap runs ar-hit-test, no page errors.

### 3. WebXR AR Module conformance
- `environmentBlendMode`: 'alpha-blend' in mono, 'additive' in stereo, updated on every mode change (bridge.setLocalMode).
- `interactionMode`: 'screen-space' in mono, 'world-space' in stereo.
- `XRView.isFirstPersonObserver`: false on every view.
- `secondary-views` is not granted (it isn't in supportedFeatures). Required unsupported features now reject with a `NotSupportedError` DOMException (IWER used a plain Error).
- `test/ar-module-conformance.test.ts` (7 tests): immersive-ar supported; blend mode per mode across toggles; interaction mode per mode; isFirstPersonObserver false on mono / stereo / inert views; secondary-views optional dropped and required rejected; screen tap = transient 'screen' source with generic-touchscreen and selectstart/select/selectend then removal; no camera-access, no XRView.camera, no getCameraImage.
- README has the conformance table.

### Verification
- `npm run typecheck` clean. `npm test`: 78/78 (8 files).
- `npm run test:e2e`: 18/18 (fixture mode; the three official cases also pass with HOLOWEB_E2E_LIVE=1). The A-Frame case needs the network and SKIPs offline.
- `npm run build`: 169.6 KB (53.1 KB gzip), was 160.6.
- Flake observed once: `gpu-priming.test.ts` "presents only the views of the current mode" failed in 1 of ~16 full-suite runs and could not be reproduced in 10 consecutive runs; cause unknown.
- `src/bridge.ts` is 389 lines, near the 400-line budget; split it on the next change.
- Not run on a device.

## Native execution log (same-origin iframes, hands, meshes, visibility)
2026-09-22, iPhone 15 Pro (iPhone16,1, iOS 27), phone lying still on a desk. Polyfill bundle synced 20:10.

Same-origin iframes (BridgeFrames.swift, ARBridge.swift, HoloWebState.swift):
- The polyfill and the console forwarder are injected into all frames. Console output from cross-origin frames is dropped.
- The bridge accepts messages from the main frame and from iframes whose origin equals the main frame's. The main-frame origin comes from webView.url at didCommit; default ports are normalised to 0. Cross-origin and opaque (data:) frames get the old error text.
- Each frame's `ready` is stored under its `frame` id, falling back to "main"/"iframe". The frame that sends `requestSession` becomes the call target: `callAsyncJavaScript(in: frameInfo)`, with nil for the main frame.
- HOLOWEB_TEST_CLICK searches same-origin iframes and also accepts `js:<expr>`. playcanv.as draws its AR button on the canvas (a PlayCanvas UI entity), so it needs `js:pc.Application.getApplication().fire('ar:request:start')`.
- Console errors are now forwarded as "Name: message @ first stack frame" instead of "{}".
- Fixed a crash in Renderer.swift: the in-flight DispatchSemaphore trapped in Renderer.deinit when the Metal view was torn down with a frame on the GPU, because the completion handler captured self weakly. The semaphore is now captured strongly. Renderer.swift was already over 400 lines before this change.

Hands (HandTracker.swift):
- Vision runs on capturedImage with the EXIF orientation of the current interface orientation (portrait = .right). Joints are mapped back to raw sensor pixels, then to the smoothedSceneDepth map. Depth samples need confidence >= medium; joints without one use the median valid joint depth, and 0.45 m is used when there is no depth at all. Unprojection uses the intrinsics and the raw ARCamera.transform.
- Busy frames are dropped; only the CVPixelBuffers of one frame are held.
- Measured with no hand in view: 45–60 results/s, Vision 6.6–8.8 ms, camera stays at 60 fps.
- Chirality is Vision's label, unflipped (rear camera, no mirroring). Not verified on device.

Meshes (MeshStreamer.swift): with "mesh-detection" requested, sceneReconstruction = .meshWithClassification (3). Changed meshes are sent at most 2 Hz, each update capped at about 2 MB of base64; the remainder follows on the next frame. semanticLabel is the most common face class. No meshes arrived while the phone lay still.

Visibility: `onVisibility` "hidden" on scene willDeactivate, didEnterBackground and ARSession interruption; "visible" on didActivate and interruption end. Only sent while streaming and only on change. Verified by switching to Settings with devicectl and back: hidden, visible, then streaming resumed at 60 fps.

`Scripts/regression.py --skip-polyfill`: 109/124 passed. The in-run fixes (sample error allow-list, Error forwarding) came after the run.
- bridge.frame-rate 49.0/s once; two re-runs gave 59.5 and 60.0.
- planes.* (5) and the plane checks of the three.js and iw-plane-detection runs: no surfaces in view.
- iw-plane-detection also logs `ReferenceError: Can't find variable: XRRay` (polyfill gap, reported to the polyfill agent).
- iw-mesh-detection: the polyfill rejects mesh-detection (reported).
- iw-interrupted-ar: the page throws on purpose (`new Exception`); regression.py now ignores that error.
- Pass: iw-webgpu-ar-session, iw-webgpu-hands, iw-anchors, iw-hit-test, iw-hit-test-anchors, iw-hands, iw-exit-button (enters AR), playcanvas-iframe, three hittest/lighting.

Needs a person:
- Point the phone at a floor or table: planes checks and the plane samples.
- Sweep a room: mesh-check.html and iw-mesh-detection (after polyfill mesh support).
- Hold a hand 30–60 cm in front of the rear camera: hands-check.html shape, hand rate and plausible size. Raise only the right hand and check that handedness reads "right".

Device contention: another agent ran regression.py on the same phone 19:59–20:09. My concurrent launches died with signal 9 or CoreDevice error 4000. Only one agent should use the phone at a time.

## Polyfill execution log (P0/P1 gaps G1–G13, samples e2e, G10 hand gestures)

Gaps closed in polyfill/ (details in plan/samples_requirements.md):
- G1: `renderState.layers` is undefined until a page sets layers (IWER patch). r152 used to take the layers path and draw nothing; fixture test/fixtures three-r152.html now passes.
- G2/G3: inline sessions keep their canvas in place. SessionSlots parks the inline session while an immersive one runs and makes it active again afterwards; exit-button sample passes.
- G4: `XRHitTestResult.createAnchor` still works after its frame ends; persistent anchor handles are rejected.
- G6: `beforexrselect` is honoured on dom-overlay touches.
- G7: immersive-vr is supported as an opaque session (product decision); requestSession is native for every non-inline mode.
- G11: `onVisibility` maps to visibilityState and visibilitychange. Input ends without select, and frames pause while hidden.
- G9: `mesh-detection` via onMeshes (base64 geometry, stable XRMesh objects, transform-only updates).
- G13: `supportedFeatures` come from the ready reply's capabilities; mesh-detection and hand-tracking only with LiDAR.
- G12: an XRGPUBinding depthStencilTexture is allocated when requested. Descriptor-cache priming applies only when `__THREE__` is set. Negative control: with allocation disabled, the 3 GPU warnings return.
- G10 (JS):
  - onHands accepts `{t, hands}` and the legacy bare array.
  - Per-joint One Euro filter on native t (minCutoff 1.5 Hz, beta 2; 0.7 Hz where the depthValid bit is clear). Filters reset when a hand reappears.
  - Gestures use unfiltered joints: hysteresis handles the noise without filter lag. Poses use the filtered joints.
  - Grab (curl ratio < 1.35, release > 1.55) fires squeezestart / squeeze / squeezeend.
  - A grab suppresses the pinch. An active pinch ends with selectend only, before squeezestart.
  - Grip sits at the palm centre (wrist + 4 MCPs). Pinch thresholds are scaled by hand size; radii follow the spec table.

Flake root cause: the gpu-priming test had no fake window.webkit, so the mock native pushed 60 Hz frames into the test. Fixed with a webkit stub.

Verification (2026-09-22):
- npm test: 13 files, 99 tests pass (new test/hand-gestures.test.ts: One Euro step and jitter, squeeze hysteresis, event order, pinch cancel, smoothing, palm grip, legacy array form).
- npm run test:e2e: 29/29, including all 10 immersive-web samples and three-ar-hands with the new onHands format.
- Build: 176.5 KB (55.3 KB gzip).

Tune on device: HAND_FILTER in src/one-euro.ts and SQUEEZE_ON/OFF in src/hands.ts.

### Image tracking on device (2026-09-22, iPhone 15 Pro facing the laptop's built-in screen)
- Fixture: holoweb-marker.png shown full-screen in Safari on the built-in display at 750 pt ≈ 15.0 cm (panel 30.2 cm / 1512 pt). Scratchpad `show.sh marker|hand` switches it; Safari must be in its own full-screen Space, otherwise any Chrome activation raises a leftover Chrome window over it (that happened twice and was the cause of the first "not tracked" runs).
- image-check.html: scores [trackable, untrackable, trackable]; 279 tracked results in ~20 s, 0 malformed; measuredWidthInMeters 0.150 (expected 0.15); axes orthonormal; +Z · (to camera) 0.79; +Y · worldUp 0.86 (screen tilted back). Confirms the anchor.transform * Rx(-90°) imageSpace convention.
- Device screenshots: `xcrun devicectl device capture screenshot --device <udid> --destination <png>`.

## Polyfill execution log (P0: WebXR globals, e2e under WKWebView conditions)

- Cause: WKWebView has no WebXR globals. IWER's installRuntime sets 27 of them. Headless Chromium ships its own XRRay, XRPlane, XRHitTestResult, ..., which hid the gap; the device showed it as "Can't find variable: XRRay" in proposals/plane-detection.
- Fix: src/globals.ts installs the rest and holds the canonical list (`WEBXR_GLOBALS`, 42 names; `__holoweb.missingGlobals()` reports gaps on device):
  - XRRay, XRBoundedReferenceSpace, XRHitTestSource/Result
  - XRAnchor/Set, XRPlane/Set, XRMesh/Set
  - XRCPUDepthInformation, XRWebGLDepthInformation
  - XRProjectionLayer (also without WebGPU)
  - Dictionaries and enums (XRDOMOverlayState, XRSessionMode) have no browser global and are not installed.
  - XRImageTrackingResult joins the list with image tracking.
- IWER XRRay bug fixed (patch, HOLOWEB): a missing DOMPointInit `w` became undefined. It now defaults to 1 as in the spec, so `{z:-1}` without `w:0` throws TypeError, as in Chrome, and origin.w != 1 throws.
- e2e: scripts/e2e-wkwebview.mjs wraps browser.newContext. Every frame of every context deletes Chromium's native XR* constructors and Navigator.prototype.xr before page scripts. Only native-code functions are deleted, so init-script order does not matter.
  - New case "WebXR globals under WKWebView conditions": no Chromium XR* left, none missing, XRRay checks, navigator.xr is the polyfill's.
  - The e2e server now reads a file before writeHead. A 404 after writeHead(200) had crashed the run.
- Result: 30/30 e2e with Chromium's WebXR stripped (all 10 samples, three.js r186 fixtures, r111/r152, A-Frame live, iframe, hands, demo). Nothing else depended on Chromium globals. npm test 101/101 (new test/globals.test.ts).

## Polyfill execution log (WebXR image tracking)

Spec: https://github.com/immersive-web/image-tracking/blob/main/explainer.md (IDL checked against the current explainer).

- src/image-tracking.ts:
  - Feature 'image-tracking' (always offered; ARKit detection images need no LiDAR).
  - `installImageSnapshot` is the outermost requestSession wrapper. It draws each `trackedImages[i].image` to a canvas (long side <= 1024 px) synchronously in the page's call, because inner hooks await `ready`: the explainer's snapshot-at-call. It then PNG-encodes them.
  - The session hook posts `setTrackedImages {images:[{index, widthInMeters, width, height, png}]}` before native requestSession.
  - Scores map back by index. An image that can't be drawn or has widthInMeters <= 0 is 'untrackable' without reaching native.
  - `session.getTrackedImageScores()` returns a frozen array and rejects with NotSupportedError without the feature.
  - `frame.getImageTrackingResults()` returns one frozen array per frame, trackable images only.
    - `imageSpace` is [SameObject] per index. The native transform is used as-is (already in imageSpace convention).
    - `tracked:false` maps to 'emulated'.
    - It throws NotSupportedError without the feature and InvalidStateError outside the frame callback.
  - Global XRImageTrackingResult (added to WEBXR_GLOBALS). Diagnostics: `__holoweb.images.stats {resultQueries, framesWithResults, lastScores}`.
- Mock native: setTrackedImages scores 1x1 images 'untrackable'. onImages sends image 0 at 0.5 m ahead of the session-start camera, alternating tracked and emulated each second.
- examples/image-tracking.html (three r186):
  - Uses examples/assets/holoweb-marker.png at 0.15 m (the lead's file, not regenerated).
  - dom-overlay text shows the score, the state and the measured width. Axis gizmo plus outline; the outline is a closed Line, since WebGPURenderer has no LineLoop.
  - `?stats` logs `[image-tracking] {scores, results:[{index,state,width}]}` every 2 s; `?autostart` also works.
- Scripts/sync-polyfill.sh copies examples/assets/ to HoloWeb/Web/examples/assets/ (lead-approved edit).
- Tests:
  - test/image-tracking.test.ts has 5 conformance cases.
  - scripts/e2e-images.mjs has 3 cases:
    - The example, plus a fixture session [marker, 1x1]: scores [trackable, untrackable], results only index 0 in both states, one imageSpace object.
    - PlayCanvas live: the tap enters AR in its same-origin iframe; results are queried every frame.
    - Needle app URL live, via the needle-menu "Enter AR" in its shadow root: 2 images trackable.
- Verification (2026-09-22): npm test 106/106 (15 files), e2e 33/33 with Chromium's WebXR stripped, tsc clean, build 181.8 KB (56.9 KB gzip).

## Native execution log (G10 hands payload, immersive-vr, capabilities, image tracking)
2026-09-22 evening, same phone. It now faces the laptop screen, which shows the HoloWeb marker (15.0 cm wide). All device commands go through Scripts/device-lock.py.

Changes:
- onHands now sends `{ t, hands: [{ handedness, joints, confidence, depthValid }] }` (G10).
  - Vision runs with orientation .up. Joint depth is a 3x3 median of pixels with confidence >= medium, clamped to the palm depth (median of wrist, thumb CMC and 4 MCPs) ± 0.08 m. A joint outside that window, or without depth, gets palm + its previous offset and a cleared depthValid bit.
  - Hands with unknown chirality are dropped.
  - Rate: 30 Hz, 15 Hz at thermal state serious, off at critical. Calls are coalesced.
  - Measured with no hand in view: 27–30 results/s, Vision 7.9–10.8 ms.
- immersive-vr: ViewerPhase gains vrMono and vrStereo. `blendsCamera` is true only for arMono. The exit label reads "Exit VR". tests/exit-button enters vrMono and renders an opaque scene at 60 fps (checked with a device screenshot).
- The ready reply has `capabilities { lidar, sceneReconstruction, handTracking }`.
- ImageTracker.swift: setTrackedImages builds ARReferenceImage (orientation .up) and awaits validate(). At most 4 images are trackable. Scale estimation is on. onImages sends `anchor.transform * Rx(-90°)` (the math is documented in the file).
- The test click also searches open shadow roots (Needle's AR button is inside `<needle-menu>`).
- regression.py: image_run and three image-tracking third_party_run entries. Expectations moved to Scripts/regression_targets.py (regression.py is 375 lines).

`regression.py --skip-polyfill`: 134/158.
- image-check vs the on-screen marker, all 8 PASS: scores trackable/untrackable/trackable; "image tracking n=2"; 280 tracked results; width 0.150 m; axes orthonormal (max |dot| 0.000); z·toCamera 0.79; y·worldUp 0.86 (image top is up; the screen leans back, z·up 0.51).
- mesh-check, 6/6 PASS: 41 meshes in 14 updates, 3422 vertices, 3993 triangles, indices in range, min gap 580 ms.
- env-plane-check planes: 5/5 PASS in a single run before the full regression (vertical plane 0.55x0.20 m, 7-vertex CCW polygon). 0 planes in this full run.
- Failures:
  - planes 0 this time (5 + three-plane-detection + iw-plane-detection);
  - iw-plane-detection XRRay missing (polyfill);
  - PlayCanvas and Needle image tracking enter AR but do not request image-tracking (polyfill has no image-tracking yet);
  - examples/image-tracking.html is not bundled yet (6);
  - iw-hands and iw-webgpu-hands now enter VR, where the polyfill does not grant hand-tracking (4).
- engine.needle.tools/samples/image-tracking/ embeds its app in a cross-origin iframe (image-tracking-zubckszr0qj2.needle.run), which the bridge refuses, so regression tests the app URL directly.

## Polyfill execution log (capabilities field names, device gaps from native)

- Device gap 1: hand-tracking was missing from requestSession features in the hands samples. Cause: `parseCapabilities` read `sceneDepth`, but the protocol and native send `{ lidar, sceneReconstruction, handTracking }`, so hand-tracking was never offered on the device, in AR or VR. The mock sent the old name, which hid the gap in e2e.
- Fix: `handTracking` (or the older `sceneDepth`) gates hand-tracking. The mock and the meshes test's fake native now send the protocol's names. New unit test for the native format.
- Device gaps 2 (PlayCanvas and Needle don't request image-tracking) and 3 (XRRay): the device bundle was synced at 20:10, before image tracking and the WebXR-globals fix. Both pages request image-tracking headless once the feature exists (PlayCanvas checks `window.XRImageTrackingResult`). Needs a re-sync.
- Verification: npm test 107/107, e2e 33/33.

## Polyfill execution log (bundled three.js AR examples, VR hand-tracking test)

- examples/threejs/ holds webxr_ar_hittest.html, webxr_ar_lighting.html and webxr_ar_plane_detection.html from the r186 fixtures; only the importmap changes, `three` now points at ./build/three.module.js.
  - Also bundled: build/three.module.js and three.core.js from node_modules/three 0.186.0; jsm/webxr/{ARButton,XRPlanes,XREstimatedLight}.js and jsm/loaders/UltraHDRLoader.js; main.css and textures/equirectangular/royal_esplanade_2k.hdr.jpg from threejs.org.
  - 3.3 MB in total. It is regenerated by `node scripts/vendor-threejs.mjs`.
  - Scripts/sync-polyfill.sh copies it to HoloWeb/Web/examples/threejs/.
  - App Clip note: if HoloWeb/Web goes into the Clip, this adds about 3.3 MB (budget 15 MB).
- e2e: each three.js check also runs against the bundled copy from the local server, with every non-local request aborted and reported. All 3 pass offline.
- test/vr-hands.test.ts: ready reports `{lidar, sceneReconstruction, sceneDepth}` (native 1ea696e). immersive-vr with optional ['local-floor','hand-tracking'] gets hand-tracking in enabledFeatures, blend mode 'opaque', and native requestSession features including hand-tracking. onHands then gives a right XRHand with 25 joints. Negative control with sceneDepth false fails with features ['local-floor','viewer','local'], the device symptom.
- Verification: npm test 108/108 (16 files), e2e 36/36.

## Native execution log (capabilities.sceneDepth, plane diagnostics, hand fixture, image/mesh pages)
2026-09-22 ~21:00–21:30. The phone faces the laptop, which shows the fixtures (show.sh marker|hand). Every run holds Scripts/device-lock.py.
- capabilities now include `sceneDepth` (the polyfill reads it). My addition collided with the same key added in HEAD and crashed the app (duplicate dictionary literal key); fixed. New xr-features-check.html: isSessionSupported true; requestSession with required hand-tracking + mesh-detection granted; frame.detectedMeshes up to 4. Added to regression page_checks.
- Plane diagnosis (HOLOWEB_AR_DIAG=1 logs [diag] once per second):
  - planeDetection=3 (horizontal+vertical) on every run, including the runs with frameSemantics=16 (hands) and sceneReconstruction=3 (meshes). A re-run for images builds the full configuration again, and no reset options are ever passed.
  - Tracking reaches normal after about 1 s.
  - worldMappingStatus stays "limited" the whole run.
  - rawFeaturePoints: 0–4 for the first ~10 s, then 60–280, dropping back to 2 at times.
  - Result: the first plane appeared at ~11 s in env-plane-check (it passed 5/5). In mesh-check (12 s) and iw-plane-detection (30 s) no plane formed, although ARKit built 2–4 meshes from LiDAR in the same runs.
  - Conclusion: on this stationary phone, ARKit plane detection waits for visual features and mapping, not LiDAR. The scene (screen plus dim desk) gives few features. Moving the phone slightly fixes it; the native config is not the cause.
- Hand fixture (palm photo, screen at 0.37–0.38 m): 187 hands in 8 s, 23.4 results/s, Vision 14–15 ms, 21/21 joints with measured depth. Joint view-depth spread 1.9 cm (flat photo), wrist-to-middle-tip 0.164 m. Handedness "left" on all 187. The photo shows a palm with the thumb on the left, which is anatomically a left hand. Mac Vision's "right" would mean it read the back of a right hand. Chirality is still unverified.
- Pages:
  - iw-mesh-detection 6/6 PASS (hit-test, mesh-detection granted; meshes n=4).
  - iw-plane-detection: no page errors now (XRRay fixed); 0 planes.
  - examples/image-tracking.html: tracked=true, width 0.150 m at (-0.07,-0.09,-0.34).
  - PlayCanvas image tracking: setTrackedImages n=1 trackable, ARKit n=1.
  - Needle: n=2 trackable, ARKit n=2.
  - PlayCanvas and Needle track their own marker images, not the HoloWeb marker, so their tracked=true needs those images on screen.

## Polyfill execution log (image snapshot in WebKit, e2e under WebKit)

- Device bug: examples/image-tracking.html on the iPhone scored ["untrackable"] and never sent setTrackedImages.
  - The snapshot returned null without saying why. The old `console.warn(err)` reaches native's log as `{}`.
  - The code already used a DOM <canvas> + toDataURL, not OffscreenCanvas.
  - Playwright WebKit 26.6 over http does not reproduce it (drawImage and toDataURL work), so the failure is specific to WKWebView, probably the holoweb-app:// scheme.
  - A cross-origin (tainted) bitmap in WebKit throws SecurityError from toDataURL. That used to reject requestSession; it now scores untrackable with a logged reason.
- Fix, in the new src/image-snapshot.ts:
  - Every failure is logged as `HoloWeb image-tracking: image N: <step>: <Error.name>: <message> -> untrackable` and kept in `__holoweb.images.stats.snapshotErrors`.
  - If drawing the ImageBitmap fails (throws, no size, or toDataURL returns something other than PNG, e.g. "data:,"), the element it was created from is drawn instead. `installBitmapSourceTracking` wraps createImageBitmap and remembers the source of each uncropped, option-less element call. Native's raw page shows that <img> + canvas + toDataURL works on the device.
  - Unit tests in test/image-snapshot.test.ts: logged name and message, the fallback to the source element, "data:," rejected.
- e2e:
  - `npm run test:e2e` (Chromium) now also runs the 3 image-tracking cases in Playwright WebKit (39 cases).
  - `npm run test:e2e:webkit` runs the whole suite in WebKit (36 cases, WebGPU included).
  - The only WebKit-only failure was interrupted-ar's intentional `new Exception()`, which WebKit words "Can't find variable: Exception"; the allow-list now accepts both wordings.
- Verification: npm test 111/111 (17 files); e2e Chromium + WebKit images 39/39; e2e WebKit full 36/36 (interrupted-ar rerun after the allow-list fix).
- On the device, if it still fails: read `__holoweb.images.stats.snapshotErrors` or the warn line in native's log.

### Gallery + bundled three.js on device (2026-09-22, iPhone 15 Pro)
- threejs-bundled (offline r186 copies): hittest, plane_detection (planes n=1, 4-vertex polygon), lighting — all enter AR, 0–4 skipped of ~1560, no page errors.
- Needle (physics playground, snow globe, musical instrument, collaborative sandbox, diamond ring): all 5 enter AR via WebXR (not Quick Look) under HoloWeb.
- three.js ball shooter: enters AR (1554 frames, 6 skipped); logs "THREE.Object3D.add: object not an instance of THREE.Object3D" x2 → polyfill investigating input-source shape.
- model-viewer: enters AR, then TypeError "Invalid direction value to construct XRRay" → polyfill XRRay stricter than Chrome; fixing.
- SuperSplat: AR button clicked, no session requested, no error → polyfill investigating.
- Babylon playground: the playground itself timed out preparing the runnable (before any AR button) → retry in final baseline.
- Run: `Scripts/run-targets.py threejs-bundled gallery` → 44/52.

## Native: geometric hand chirality (2026-09-22 late)
Vision's chirality is wrong for first-person rear-camera views. On the Mac, scratchpad/hands/first-person-two-hands.jpg (backs of a left and a right hand) returns right and right.

HandTracker now derives handedness from geometry. With a = indexMCP − wrist and b = littleMCP − wrist in Vision's y-up coordinates on the unmirrored capturedImage, s = a.x·b.y − a.y·b.x. s > 0 means left, assuming the back of the hand faces the camera. The sign survives rotation, so sensor vs display orientation does not matter. Vision's label is kept as `visionChirality`, and hands are no longer dropped when Vision says unknown.

Mac check (scratchpad/chir.swift):
- first-person: x=0.21 → left (s=+0.047), x=0.81 → right (s=−0.048); Vision said right and right.
- front-back: x=0.23 left, x=0.79 right; Vision said right and right.
- Palm-facing photos read as the opposite hand, as expected, because the rule assumes the back of the hand.

Device (show.sh hands2, hands-check.html):
- hands.chirality-first-person 178/178. The phone's Vision said "right,left" for the same view, so it is inconsistent even between devices.
- 22.2 results/s, Vision 18–20 ms with two hands, 21/21 joints with measured depth, depth spread 3.0 cm (flat photo), wrist 0.38 m.
