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
