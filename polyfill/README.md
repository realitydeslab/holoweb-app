# holoweb-polyfill

WebXR runtime that the HoloWeb iOS app injects into its WKWebView. It installs `navigator.xr`
(`immersive-ar` + `inline`), feeds it ARKit poses through the native bridge
(`plan/bridge_protocol.md`), and renders in mono (handheld) or HoloKit X stereo.
WebGL pages use `XRWebGLLayer`; WebGPU pages use the `XRGPUBinding` polyfill.

Output: `dist/holoweb-polyfill.js` (minified IIFE, ~154 KB, ~48 KB gzip) and
`dist/holoweb-polyfill.dev.js` (unminified, inline source map). Native loads the minified file
as a `WKUserScript` at document start, main frame only, page world.

## Commands

```bash
npm install          # also applies patches/iwer+2.4.0.patch (postinstall: patch-package)
npm run build        # dist/*.js, fails if > 250 KB or if IWER remote/native code is bundled
npm test             # vitest: stereo golden values, bridge + session behaviour (happy-dom)
npm run typecheck    # tsc --noEmit, strict
npm run test:e2e     # headless Chromium against mock-native: examples in mono/stereo, native toggles, rotation,
                     # demo.html, stale-right-eye fixture (three r111), hands, three.js r186 official AR examples
                     # (fixtures; HOLOWEB_E2E_LIVE=1 = threejs.org), same-origin iframe, A-Frame 1.8 (network)
                     # HOLOWEB_E2E_TOJI=1 adds the live Toji page
```

Desktop development: open `examples/three-ar.html` (WebGL2 backend) or
`examples/three-ar-webgpu.html` (WebGPU backend) over http. Without `window.webkit` the polyfill
uses `src/mock-native.ts` (orbiting camera at 60 Hz, one floor plane). `?holoweb-mode=stereo`
and `?holoweb-model=iPhone17,1` override the mock.

## Layout

| File | Role |
|---|---|
| `src/index.ts` | Builds the device, installs the runtime, exposes `window.__holoweb` |
| `src/device.ts` | HoloKit `XRDeviceConfig`, native-resolution canvas, `getNativeFramebufferScaleFactor = dpr` |
| `src/bridge.ts` | Protocol v1: `ready` handshake with `WKJSHandle`, `onFrame` -> device pose/projection/viewports, `rendered`, commands |
| `src/session.ts` | `requestSession`/`endSession` to native, `local`/`local-floor` spaces, dom-overlay |
| `src/stereo.ts`, `src/phones.ts` | HoloKit X math and the iOS phone table (from the Unity SDK) |
| `src/views.ts` | View-count policy: never fewer views than the page has seen in a session (inert 2nd view) |
| `src/prediction.ts` | Stereo-only pose extrapolation (default 25 ms, `__holoweb.setPrediction(ms)`, 0 = off) |
| `src/anchors.ts` | `createAnchor` / `deleteAnchor` / `onAnchors` behind IWER's `XRAnchor` |
| `src/light.ts` | `requestLightProbe` / `getLightEstimate` from ARKit ambient lux + kelvin |
| `src/floor.ts` | `local-floor` height from planes, `reset` event when it moves > 2 cm |
| `src/hittest.ts` | Ray vs ARKit plane polygons, plugged into IWER's hit-test plumbing as its environment module |
| `src/hittest-transient.ts` | `requestHitTestSourceForTransientInput` / `getHitTestResultsForTransientInput` (screen taps) |
| `src/planes.ts` | `plane-detection`: `frame.detectedPlanes` with stable `XRPlane` objects per native id |
| `src/reflection.ts` | `XRWebGLBinding.getReflectionCubeMap` from `onEnvironment`, `reflectionchange` |
| `src/input.ts` | Screen tap -> transient `screen` (mono) / `gaze` (stereo) input source, `select` events |
| `src/webgl-layer.ts` | Non-null opaque `XRWebGLLayer.framebuffer` + fixed framebuffer size |
| `src/gpu-binding.ts`, `src/gpu-presenter.ts` | `XRGPUBinding`, projection layer, copy-to-canvas presenter |
| `src/hands.ts`, `src/hand-input.ts` | WebXR Hand Input from native Vision + LiDAR joints (`onHands`), pinch -> select |
| `src/mock-native.ts`, `src/mock-hands.ts` | Desktop stand-in for the iOS app (incl. a synthetic pinching hand) |
| `src/webkit.ts` | Typed `window.webkit` shim (the only untyped boundary) |

## Why patch-package over vendoring IWER

IWER 2.4.0 ships compiled ES modules plus `.d.ts` in `lib/`. The HoloWeb changes are 110 changed
lines across 7 files; vendoring would copy ~60 modules (plus the 3.9k-line native override) into
this repo for review. With patch-package the whole fork is one reviewable file,
`patches/iwer+2.4.0.patch`, re-applied on every install. Rebasing onto a new IWER version is to bump
the pin, run `npm install`, fix rejected hunks, and run `npx patch-package iwer`. Every patched line
carries a `HOLOWEB:` comment. Everything that can be done from outside (see below) is kept out of
the patch.

devui, sem and remote are excluded: devui/sem are separate packages we never import; the patch
removes the `RemoteControlInterface` construction from `XRDevice`, and the build fails if any
`iwer/lib/remote` or `iwer/lib/native` byte reaches the bundle. `webxr-layers-polyfill` is stubbed
at build time (IWER only uses it for `installRuntime({ polyfillLayers: true })`), saving 60 KB.

## Patches (patches/iwer+2.4.0.patch)

1. **Per-eye projection override**: `XRDevice.nativeProjection: Partial<Record<'left'|'right'|'none', Float32Array>>`.
   The frame tick copies the override and rewrites entries [10] and [14] from `renderState.depthNear/depthFar`
   (infinite far supported), in the immersive and inline paths.
2. **Per-eye viewport override**: `XRDevice.nativeViewports` (framebuffer pixels, bottom-left origin); `getViewport` uses it when present.
3. **Mono immersive = one view**: an immersive session with `stereoEnabled = false` returns one `'none'`
   view (handheld AR), not IWER's left eye plus a zero-width right eye.
4. **Layers render state**: `updateRenderState({ layers })`, `renderState.layers`, and a frame loop that runs
   for a layers-only session (no `baseLayer`); `baseLayer` + `layers` together throws `NotSupportedError`.
5. **`onFrameEnd` device hook**, called after the page's XR callbacks (used by the XRGPUBinding presenter).
6. **Remote control removed** from `XRDevice` (bundle size).
7. **`XRRay.matrix` fix**: upstream built the rotation axis as `direction x -Z`, which points non-default
   rays the wrong way (for example a straight-down ray becomes straight up). Changed to `-Z x direction`.
8. Types: `WebXRFeature` gains `'light-estimation' | 'webgpu'`.
9. **Full-framebuffer clear**: the per-frame immersive clear disables a page-left `SCISSOR_TEST` for the clear, so
   a former right-eye region cannot survive a stereo -> mono switch.

Requirement 3 of the task (installRuntime without native `navigator.xr`, `immersive-ar` support,
optional features and `enabledFeatures` echo including `webgpu`) needed no patch: it follows from
the device config. The config sets `userAgent` to the real UA, because IWER overwrites
`navigator.userAgent` with it.

## Adaptations outside the patch

- `XRWebGLLayer.framebuffer` returns a sentinel `WebGLFramebuffer` that the context binds as the default
  framebuffer. three.js' WebGL2 backend keys state on this object and fails on IWER's `null`.
- `XRWebGLLayer.framebufferWidth/Height` report the native size (innerWidth x dpr) from creation.
  Without this, three.js sizes its XR target after `setPixelRatio(1)` and the image is offset.
- The canvas is sized at native resolution during a session; `getNativeFramebufferScaleFactor` returns `devicePixelRatio`.
- `local` is the ARKit origin (IWER anchors it to the viewer pose at request time). `local-floor` is
  the lowest horizontal plane below the origin, else 1.3 m down.
- While an immersive session runs, page content is hidden (`visibility`) except the XR canvases and the
  dom-overlay root, and html/body backgrounds are forced transparent so the native camera (mono) or
  black (stereo) shows through, matching what a real immersive session displays.
- Anchors are ARKit anchors: `XRFrame.createAnchor` / `XRHitTestResult.createAnchor` post `createAnchor`,
  `onAnchors` moves anchor spaces, `transform: null` drops the anchor from `trackedAnchors`, `delete()` posts
  `deleteAnchor`. `requestPersistentHandle` rejects (ARKit origins differ per session).
- Light estimation: ARKit `ambientIntensity` (1000 lux = neutral) and `ambientColorTemperature` become an L0-only
  SH term plus a directional light from above, split so a white upward surface reflects `k * tint`; the conversion
  constants are documented in `src/light.ts`.
- `local-floor` starts 1.3 m below the origin, moves to the lowest horizontal plane (only downwards once planes
  define it) and dispatches `reset` when it moves by more than 2 cm.
- Stereo pose prediction: the viewer pose is extrapolated from the last two ARKit frames (linear translation,
  slerp rotation) by 25 ms. Mono never predicts, because the camera background is drawn for the reported `rendered` frame.
- Rotation in mono: render targets keep their session-start size. three.js ignores `setSize` while presenting
  and allocates its XR targets once (reallocating the layer would mismatch its depth attachment). The WebGL canvas
  keeps its backing store and CSS stretches it; the WebGPU presenter canvas follows the new size and scales the
  layer. Native's projection already matches the new aspect, so geometry is correct; only the sampling density
  changes until the page re-enters XR.
- Mono <-> stereo mid-session (normal flow: Start AR in mono, then the app's native toggle button): the
  session keeps running on both backends. Within a session the reported view count never drops below the
  maximum the page has seen (`src/views.ts`): a session that has only been mono has one view; mono after stereo
  reports `[mono view, inert right view]`. The inert view has the mono pose (three's union frustum = mono), a
  true 0x0 viewport (`XRWebGLLayer.getViewport` and `XRGPUSubImage.viewport`, so pages that skip empty viewports
  skip it) and a projection pushed far below the viewport (P[9] = 1e4), so it rasterises nothing even in engines
  that draw it anyway; presenters ignore it. `examples/ar-scene.js` `?stats` reports both `views` (reported
  views) and `activeViews` (views with a non-zero XRViewport). Reason: engines keep per-view state sized by the largest view count.
  three.js <= r111 WebXRManager renders a fixed `[cameraL, cameraR]` ArrayCamera and updates only `cameras[i]`
  for `i < views.length`, so a 2 -> 1 drop left the stale right eye rendering every frame
  (toji.github.io/webxr-particles, r111dev). Babylon / A-Frame / PlayCanvas may assume the same.
  - WebGL: follows directly (viewports + projections per frame).
  - WebGPU (`XRGPUBinding`): three.js r186 caches its intermediate target's render-pass descriptor under a
    key without the ArrayCamera size and builds one colour attachment per camera on first use, so a
    descriptor first built for 1 camera crashes at the switch to 2 (`_createArrayCameraLayerDescriptors`,
    `colorAttachments[1]` undefined), while one built for 2 cameras serves both. The polyfill therefore primes
    it with the same inert view for the first 3 frames of a mono XRGPUBinding session; a session that stays
    mono is a true single view after that.
  - Layer size is set by the mode at layer creation. Starting in mono, stereo eyes render at full-framebuffer
    size and are scaled into the eye rects (about 2x the mono pixel cost, ~3.3x per eye what the rects need).
    three sizes its XR render targets once per session, so this cannot change without re-entering.
- Hit test: `PlaneEnvironment` implements IWER's SEM interface, so `requestHitTestSource` and
  `getHitTestResults` run in-frame against the latest `onPlanes` set with zero IPC. Native raycast is
  available as `__holoweb.hitTest(origin, dir)`, which costs one message round trip (about 1 frame).

## Planes, reflections, frames, engines

- `plane-detection`: every frame of a session with the feature gets all live ARKit planes in `frame.detectedPlanes`.
  Each is one IWER `XRPlane` per native id, reused while the plane lives (three.js' `XRPlanes` keys meshes by the
  object). `planeSpace` is the plane transform (+Y = normal); `polygon` is `DOMPointReadOnly[]` from native
  `polygon` (else the extent rectangle); `orientation`; `lastChangedTime` is updated only when native
  `lastChanged` or the geometry changes. Hit tests use the same polygons.
- Reflections: the global `XRWebGLBinding` is IWER's plus `getReflectionCubeMap(probe)`. It is one WebGL cube
  texture per context (SRGB8_ALPHA8, or EXT_sRGB on WebGL1), updated in place from `onEnvironment`, and null
  before the first map. GL state it touches is restored. Each new map fires `reflectionchange` on live light
  probes. Only `srgba8` is offered (`preferredReflectionFormat`). There is no `createProjectionLayer`, so three.js
  keeps XRWebGLLayer (WebGL) / XRGPUBinding (WebGPU).
- Transient-input hit test for screen taps (A-Frame's `ar-hit-test` uses it).
- `offerSession` is not exposed. A-Frame 1.8 (`xr-mode-ui XRMode: xr`) calls it at load and throws an unhandled
  "Failed to enter VR mode" when it rejects; without it A-Frame skips the offer and keeps its AR button.
- Frames: the bundle can run in every frame (native injects with `forMainFrameOnly: false`). Each frame posts
  `ready { frame: 'main' | 'sub' }` lazily, on its first `isSessionSupported` / `requestSession`, so only the frame
  that uses WebXR registers a handle (playcanv.as runs the app in a same-origin iframe).

## WebXR AR Module conformance

Checked by `test/ar-module-conformance.test.ts` against https://immersive-web.github.io/webxr-ar-module/.

| Requirement | HoloWeb |
|---|---|
| `immersive-ar` is a supported `XRSessionMode` | Yes; `immersive-vr` is not offered |
| `environmentBlendMode` reflects the compositor | `alpha-blend` in mono (camera passthrough), `additive` in HoloKit stereo (optical see-through), follows mid-session toggles; never `opaque` |
| `interactionMode` | `screen-space` in mono, `world-space` in stereo |
| `XRView.isFirstPersonObserver` | Present, always `false` (including the inert 2nd view) |
| `secondary-views` feature | Not granted: optional is dropped, required rejects with `NotSupportedError` |
| Screen-space input | Tap = transient source, `targetRayMode: 'screen'`, profile `generic-touchscreen`, `selectstart` / `select` / `selectend` |
| No camera image exposure | `camera-access` not granted (required -> `NotSupportedError`), no `XRView.camera`, no `getCameraImage` |

Unsupported required features reject with a `NotSupportedError` DOMException (IWER used a plain `Error`).

## Hand tracking (`hand-tracking` feature)

- Native (proposed protocol addition, see plan/notes.md): when `requestSession.features` contains `hand-tracking`,
  run `VNDetectHumanHandPoseRequest` (2 hands) on `ARFrame.capturedImage`, lift the 21 joints to 3D with LiDAR
  `sceneDepth`, and call `bridge.onHands([{ handedness, joints: number[63], confidence: number[21] }])`:
  world-space metres, Vision joint order (wrist; thumb CMC/MP/IP/tip; index, middle, ring, little MCP/PIP/DIP/tip).
- Polyfill: IWER's two `XRHandInput`s are driven from that data (their canned poses are disabled), so pages get
  `inputSource.hand` with 25 `XRJointSpace`s, `getJointPose` / `fillPoses` / `fillJointRadii`.
  - Finger metacarpals (not in Vision) are estimated at 25 % from wrist to knuckle.
  - Orientation: -Z along the bone, +Y out of the back of the hand. Radii are typical adult values.
  - Target ray: from the pinch point, pointing away from the viewer.
  - Pinch (thumb tip to index tip < 2 cm, release > 3.5 cm) -> `selectstart`, then `select` + `selectend`.
  - Joints under 0.3 confidence keep their last position; a hand disappears 250 ms after its last update.
- `examples/three-ar-hands.html`: three.js `XRHandModelFactory` spheres; pinch drops a cube at the fingertip.

## Native integration checklist

- Inject `dist/holoweb-polyfill.js` at document start, main frame, `.page` world; enable
  `allowsJSHandleCreationInPageWorld`; register one reply handler named `holoweb`.
- `onFrame` args: `transform` (display-oriented pose = `inverse(view)`) is the viewer pose; `view` is used
  only when `transform` is missing. `proj` must match the same orientation and the web view pixel size.
  `sentAt` gives `__holoweb.bridge.latest.latencyMs`. The polyfill posts `rendered { t }` after every
  immersive XR frame (mono and stereo).
- Stereo assumes the web view covers the whole screen (no safe-area insets) so canvas pixels = screen pixels.
- HoloKit orientation: the Unity SDK's `ScreenOrientation.LandscapeLeft` is `UIInterfaceOrientation.landscapeRight`
  (home side on the right). The phone-table offsets assume it; native's `setMode(.stereo)` already requests
  `.landscapeRight` (plan/notes.md M3), while plan/bridge_protocol.md still says `.landscapeLeft`.
- `onPlanes` `transform` is the plane centre pose (ARPlaneAnchor transform x T(center)), local +Y = normal, extent along local X/Z.

## Known issues

- three.js r186 WebGPURenderer, WebGL2 backend: sub-camera viewports are flipped as if they had a
  top-left origin (`three.webgpu.js` WebGLBackend, `context.height - height - y`), but
  `XRWebGLLayer.getViewport` returns spec bottom-left rects. It is harmless for full-height viewports (mono,
  Quest), but HoloKit eye rects then land (H - 2y - h) px higher (~130 of 780 px in the e2e run).
  The WebGPU backend path and classic `WebGLRenderer` are correct. Upstream fix: XRManager should pass
  `y = framebufferHeight - y - height` on the WebGL backend.
- Light estimation values (lux/K -> SH + directional) are a documented mapping, not a measured calibration.
- threejs.org `webxr_ar_lighting` loads a 2K HDR default environment in parallel; if it finishes after
  `estimationstart` its callback overwrites `scene.environment` with the default (page race, not the polyfill).
- `XRGPUBinding.createProjectionLayer({ textureType: 'texture' })` is rejected; only `texture-array`.
- After a mono rotation the image is resampled (e.g. a 2556x1179 target shown at 1179x2556): correct geometry,
  lower vertical detail, until the session is re-entered.
