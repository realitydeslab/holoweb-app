# immersive-web samples: requirements for HoloWeb (iPhone 15 Pro, LiDAR)

Date: 2026-09-22. Source: `immersive-web/webxr-samples` at `fb41c34` (2026-09-10), shallow clone.
Polyfill state: `polyfill/dist/holoweb-polyfill.dev.js` built 19:44 today. That build includes the
uncommitted hand-tracking work (`src/hand-input.ts`, `src/hands.ts`, `src/mock-hands.ts`), but no
plane-detection yet.

How "works today" was determined: every page was loaded in headless Chromium (Playwright, 390x844,
SwiftShader WebGL/WebGPU) with the dev bundle injected at document start and mock-native frames.
The script clicked the Enter button, tapped the screen, and read session state and errors.
Nothing here ran on a device. Scripts: scratchpad `samples.cjs`, `anch*.cjs`, `mesh.cjs`, `hands.cjs`, `gpu*.cjs`.

## Summary

| # | Page | Mode requested | Required / optional features | Main APIs | Works today | Blocking gaps |
|---|---|---|---|---|---|---|
| 1 | proposals/mesh-detection | immersive-ar | req `hit-test`, `mesh-detection`; opt `dom-overlay` (root = `document.body`) | three r152 `WebXRManager` (WebGL2), `frame.detectedMeshes`, `XRMesh.meshSpace/vertices/indices/lastChangedTime/semanticLabel`, `getPose`, controller `selectstart/selectend`, `beforexrselect` | **No**: `requestSession` rejects (`mesh-detection` unsupported) | G1 three r130-r173 layers path (`glBinding.createProjectionLayer is not a function`, reproduced); G6 overlay root = body; G9 mesh detection (JS + native) |
| 2 | proposals/plane-detection | immersive-ar | req `anchors`, `plane-detection`; opt `dom-overlay` (root = body) | three r127 (`XRWebGLLayer`), `frame.detectedPlanes`, `XRPlane.planeSpace/polygon/lastChangedTime`, `XRRay`, `frame.createAnchor(pose, plane.planeSpace)`, `trackedAnchors`, session `select`, `beforexrselect` | **No**: rejects (`plane-detection` unsupported; being added) | G8 plane detection (in progress); G6 overlay root = body |
| 3 | webgpu/immersive-ar-session | immersive-ar | req `webgpu` | `XRGPUBinding`, `getPreferredColorFormat`, `createProjectionLayer({colorFormat, depthStencilFormat:'depth24plus', alpha:true})`, `updateRenderState({layers})`, `getViewSubImage` -> `colorTexture`, `depthStencilTexture`, `viewport`, `getViewDescriptor()`; `local` + `reset` | **Yes** (headless). The first 3 frames fail WebGPU validation | G12 (cosmetic: priming view vs 1x1 depth) |
| 4 | webgpu/immersive-hands | tries immersive-vr, then immersive-ar | req `webgpu`; opt `local-floor`, `bounded-floor`, `hand-tracking`, `tracked-sources` | XRGPUBinding as #3; `inputSource.hand`, `fillJointRadii`, `fillPoses`, `getJointPose('index-finger-tip')`, `inputsourceschange`, `trackedsourceschange`, `visibilitychange` | **Partial**: runs in AR. Mock hands work (right hand, 25 joints). No real hands | G10 native hand tracking; G12 |
| 5 | anchors | inline at load; immersive-ar (VR fallback) | req `anchors` | `XRWebGLLayer`, `select`, `frame.createAnchor(pose, inputSource.targetRaySpace)`, `trackedAnchors`, `anchor.anchorSpace`, `anchor.delete()`, `viewer` (inline) / `local` | **No**: the button is covered, and the immersive request is rejected | G2 inline canvas covers page; G3 inline + immersive sessions |
| 6 | hit-test | immersive-ar | req `local`, `hit-test` | `requestHitTestSource({space: viewer})`, `getHitTestResults`, `hitTestSource.cancel()`, `select` | **Yes** | none |
| 7 | hit-test-anchors | immersive-ar | req `local`, `hit-test`, `anchors` | #6 + `XRHitTestResult.createAnchor()` on the previous frame's result, `trackedAnchors` | **Partial**: reticle works; tap rejects `InvalidStateError: XRFrame is not active` | G4 |
| 8 | immersive-hands | tries immersive-vr, then immersive-ar | opt `local-floor`, `bounded-floor`, `hand-tracking`, `tracked-sources` | #4 on `XRWebGLLayer`; `fetchProfile` (CDN) for `tracked-pointer` sources | **Partial**: as #4 | G10 |
| 9 | tests/interrupted-ar | inline at load; immersive-ar | none | `XRWebGLLayer` set 5 s after the session resolves (the page throws in between) | **No**: G2 + G3. With both worked around, it renders after 5 s | G2, G3 |
| 10 | tests/exit-button | inline at load; **immersive-vr only** | req `local-floor` | `WebXRSampleApp`, `gl.makeXRCompatible()`, in-world `ButtonNode` hit by the `select` ray -> `session.end()` | **No**: "VR NOT FOUND" (disabled) | G7 immersive-vr; G2, G3 |

## Prioritised gap list

Sizes: S <= 0.5 day, M = 1-2 days, L = 3-5 days (one engineer, including tests).

| Pri | Gap | Side | Pages unblocked | Size |
|---|---|---|---|---|
| P0 | G3 inline session blocks immersive (`An active XRSession already exists`) | JS (IWER patch) | 5, 9, 10 + any "magic window" page | M |
| P0 | G2 inline session's canvas moved into IWER's fixed z-999 container, covering the page | JS | 5, 9, 10 | S |
| P0 | G1 `renderState.layers` is `[]`, so three r130-r173 on WebGL2 take the `XRWebGLBinding.createProjectionLayer` path and throw | JS | 1 + every three r130-r173 page | S |
| P0 | G4 `XRHitTestResult.createAnchor()` rejects when its frame is no longer active | JS | 7 | S |
| P0 | G6 dom-overlay with root = `document.body`: XR canvas above the overlay, all taps swallowed, no `beforexrselect` | JS | 1, 2 (overlay is on by default) | S-M |
| P0 | G8 plane-detection (in progress) | JS (+ native already sends `onPlanes`) | 2 | M |
| P1 | G9 mesh-detection | native + JS + protocol | 1 | native M, JS M |
| P1 | G10 hand tracking: native Vision + LiDAR -> `onHands`; JS One Euro smoothing, squeeze, timestamp | native + JS | 4, 8 | native M-L, JS S |
| P1 | G7 `immersive-vr` session mode | JS + native (product decision) | 10 | S + S |
| P2 | G11 visibility / interruption -> `visibilitychange` | native + JS | 4, 8 (react to it); correctness everywhere | S + S |
| P2 | G12 WebGPU: inert priming view fails validation in non-three renderers; no `depthStencilTexture` | JS | 3, 4 (cosmetic) | S |
| P2 | G13 capability report in `ready` (LiDAR -> `mesh-detection`) | native + JS | 1 on non-LiDAR phones (fail cleanly) | S |

Why this order: the P0 items are small fixes, and together they make 5, 7 and 9 work and remove crashes on 1 and 2.
G8 is already in progress. Mesh and native hands are the only large pieces. Only one page needs `immersive-vr`.

---

## Per-page detail

### 1. proposals/mesh-detection.html
- Enter button: the label is fixed at "START AR". `isSessionSupported('immersive-ar')` enables it.
- `requestSession('immersive-ar', { requiredFeatures: ['hit-test', 'mesh-detection'], optionalFeatures: ['dom-overlay'], domOverlay: { root: document.body } })`.
  The "Enable DOM Overlay" checkbox is checked by default. `hit-test` is required but not used (the file imports `js/hit-test.js` and never calls it).
  After the session resolves, the page sets `session.mode = 'immersive-ar'` (an expando; harmless because IWER has no `mode` getter).
- Rendering: three **r152** from jsDelivr, `WebGLRenderer({antialias, alpha})`, `renderer.xr.setReferenceSpaceType('local')`, `setSession`, `setAnimationLoop`, `setFoveation(0)`.
  - r152 decides the layer type with `session.renderState.layers === undefined || !isWebGL2`. Our IWER patch makes `layers` return `[]`, so r152 does `new XRWebGLBinding(session, gl).createProjectionLayer(...)`.
    IWER's `XRWebGLBinding` (depth-only) has no such method. Result: `pageerror glBinding.createProjectionLayer is not a function`, and no frame is ever rendered (reproduced with the feature check bypassed). -> **G1**.
- Per frame: `frame.detectedMeshes` (Set). For each `XRMesh`: `frame.getPose(mesh.meshSpace, localSpace)`, `mesh.vertices` (Float32Array xyz, fed straight to `BufferAttribute(…, 3)`), `mesh.indices` (Uint32Array to `setIndex`), `mesh.lastChangedTime` (rebuilds geometry when it increases), `mesh.semanticLabel` (drawn as 3D text via FontLoader). A mesh that leaves the set is removed. The page keys meshes by XRMesh object identity, so identity must persist across updates.
- Input: `renderer.xr.getController(0/1)` `selectstart`/`selectend`. While pressed, the page raycasts the controller's `matrixWorld` -Z against all meshes and places a red sphere reticle. It works with our `screen` input source. `XRControllerModelFactory` ignores non-`tracked-pointer` sources.
- DOM overlay: `header.addEventListener('beforexrselect', e => e.preventDefault())` suppresses XR input from header taps. -> **G6**.
- Materials: with triangles shown (the default), translucent colours plus a wireframe. Otherwise the material uses ZeroFactor blending, which punches holes in the content (occlusion).

### 2. proposals/plane-detection.html
- Button: fixed "START AR", enabled by `isSessionSupported('immersive-ar')`.
- `requestSession('immersive-ar', { requiredFeatures: ['anchors', 'plane-detection'], optionalFeatures: ['dom-overlay'], domOverlay: { root: document.body } })`.
- three **r127** from unpkg, which always uses `XRWebGLLayer` (not affected by G1).
- Per frame:
  - `frame.trackedAnchors` and `getPose(anchor.anchorSpace)`.
  - `frame.detectedPlanes`, `getPose(plane.planeSpace)`, `plane.polygon` (array of points with `.x .y .z`, plane-local, y = 0; fan-triangulated, so convex is assumed), `plane.lastChangedTime` (geometry rebuilt when it increases).
  - Reticle: `new XRRay(viewerPose.transform)` (global `XRRay` exists in our bundle, verified), then `js/hit-test.js`. That file intersects the ray with every plane's +Y normal at `planeSpace`, then keeps hits inside the polygon with a same-side test (convex only, winding-agnostic).
  - `plane.orientation` and `semanticLabel` are not read.
- `session` `select` -> `event.frame.createAnchor(new XRRigidTransform(point_on_plane), plane.planeSpace)`; `anchors.ts` already accepts any space and converts it to a world pose.
- Same `beforexrselect` overlay pattern as #1 (**G6**).

### 3. webgpu/immersive-ar-session.html
- `createWebGPUContext({xrCompatible: true})` (`requestAdapter({xrCompatible})`) runs before the button is created. Button label "START AR", enabled by `isSessionSupported('immersive-ar')`.
- `requestSession('immersive-ar', { requiredFeatures: ['webgpu'] })`.
- `new XRGPUBinding(session, device)`, `getPreferredColorFormat()`, `createProjectionLayer({ colorFormat, depthStencilFormat: 'depth24plus', alpha: true })`. `textureType` is omitted (the spec default is `'texture'`; ours creates `texture-array`, which is fine because the page only uses `getViewDescriptor()`).
- `updateRenderState({ layers: [layer] })`, `requestReferenceSpace('local')` + `reset` listener (uses `evt.transform`), `getViewerPose`.
- Per view: `binding.getViewSubImage(layer, view)` -> `colorTexture.createView(subImage.getViewDescriptor())`, `depthStencilTexture?.createView(...)`, `viewport.{x,y,width,height}`.
  One render pass per view. Clear to (0,0,0,0) so the camera shows through. `scene.enableStats(true)`.
- Headless result: session starts, EXIT AR shown, frames render. Exactly 3 WebGPU validation warnings ("depth stencil attachment 1x1 does not match 390x..."), then clean.
  Cause: in mono we prime three.js with an inert 2nd view that has a 0x0 viewport. Our subimage has no `depthStencilTexture`, so the sample sizes its own depth attachment from the viewport (min 1x1). The colour attachment is the full array layer, so the sizes do not match and the frame's command buffer is invalid. -> **G12**.

### 4. webgpu/immersive-hands.html / 8. immersive-hands.html
- Button: default WebXRButton text "ENTER VR". Checks `isSessionSupported('immersive-vr')` first; if false, sets `isAR = true` and enables on `isSessionSupported('immersive-ar')`. Under HoloWeb it therefore requests **immersive-ar** (verified). The label still says VR, which is cosmetic.
- `requestSession(isAR ? 'immersive-ar' : 'immersive-vr', { optionalFeatures: ['local-floor', 'bounded-floor', 'hand-tracking', 'tracked-sources'] })`. `tracked-sources` comes from a checkbox that is checked by default. The WebGPU version adds `requiredFeatures: ['webgpu']`.
  `hand-tracking` is **optional**, so the samples run without it.
  Enabled today: `['local-floor', 'hand-tracking', 'viewer', 'local']`, plus `webgpu` on the WebGPU page.
- Reference space: `local` + `getOffsetReferenceSpace(identity)` (`local-floor` is requested but not used).
- What is rendered: `space.gltf` plus an **opaque milky-way skybox**, so in AR the camera is completely hidden (the samples are written for VR). A rotating 25 cm box at (0,0,-0.65) (WebGPU: (0,-0.3,-0.65)) changes colour when an index fingertip is within 25 cm. Per hand: 25 boxes, one per joint, scaled by joint radius, plus a 2 cm box at `index-finger-tip`. `tracked-pointer` sources also get a laser and a cursor 2 m along the target ray.
- Hand API use:
  - `inputSource.hand` (truthy check).
  - `hand.values()` in **spec joint order** (box i = joint i).
  - `frame.fillJointRadii(hand.values(), Float32Array(25))`: must return true, otherwise the whole hand is hidden. So every joint needs a radius every frame.
  - `frame.fillPoses(hand.values(), refSpace, Float32Array(400))`.
  - `hand.get('index-finger-tip')`, then `frame.getJointPose(joint, refSpace)`.
  - Only `index-finger-tip` is read by name.
  - `handedness` must be `left` or `right`: boxes are keyed `input_left`/`input_right`, and the WebGL page has no index box for `none`.
  - WebGL page: `inputsourceschange` -> `fetchProfile(inputSource, jsDelivr)` for every `tracked-pointer` source (hands included). `profiles` must contain a real id (e.g. `generic-hand`, which IWER's XRHandInput has), otherwise the promise rejects (harmless).
  - `visibilitychange`: `visible-blurred` removes all hand boxes; WebGPU hides visuals when `!== 'visible'`.
  - `session.trackedSources` / `trackedsourceschange` are optional (undefined is handled).
- Minimum to show hands in AR on a phone:
  - `hand-tracking` in supported features (done, uncommitted).
  - Two `tracked-pointer` sources with an `XRHand` of 25 `XRJointSpace`s in spec order, all with radii and poses (done via IWER `XRHandInput`; mock verified: `hands: ["right:25"]`, `fillJointRadii` true).
  - Native `onHands` data (**G10**).
  - No page change is needed; they need neither immersive-vr nor `hand-tracking` as a required feature.
- Our `screen` touch source has no `hand`, so the samples skip it.

### 5. anchors.html
- Why the curator saw "START VR": the page builds the button with `textEnterXRTitle: isARAvailable ? "START AR" : "START VR"` **before** `isSessionSupported('immersive-ar')` resolves. `isARAvailable` is still `false` then, and the label is never rebuilt. Every AR browser, Chrome Android included, shows "START VR". This is a sample bug, not HoloWeb. The resolved check then sets `xrSessionString = 'immersive-ar'`, so a click requests `immersive-ar` with `requiredFeatures: ['anchors']`.
- The real blockers (both reproduced):
  1. The page starts an **inline** session at load (`requestSession('inline')`, `viewer` space, `InlineViewerHelper`) and sets an `XRWebGLLayer` on the page canvas. IWER's `onBaseLayerSet` reparents that canvas into its `position:fixed; z-index:999` container for inline sessions too. `elementFromPoint` at the button returns `CANVAS[z=2] < DIV[z=999]`, so the START button cannot be tapped (the tap lands on the canvas). -> **G2**.
  2. With the button clicked from script, `requestSession('immersive-ar')` rejects with `InvalidStateError: An active XRSession already exists.` IWER allows only one session, inline included. -> **G3**.
  - With the inline request suppressed: `enabledFeatures ['anchors','viewer','local']`, and 3 taps gave `trackedAnchors.size === 3`. `anchors.ts` handles `createAnchor(pose, targetRaySpace)`.
- Also used: WebXR polyfill (`js/third-party/webxr-polyfill`, `usePolyfill` default true). `navigator.xr` exists at document start, so it only installs compatibility shims (harmless).
  `scene.inputRenderer.useProfileControllerMeshes(session)` loads meshes only for `tracked-pointer` sources.
  The inline skybox is hidden in AR (`skybox.visible = false`).

### 6. hit-test.html
- Fixed "START AR" label. `requiredFeatures: ['local', 'hit-test']`.
- `requestReferenceSpace('viewer')` -> `requestHitTestSource({ space })`. Per frame, `getHitTestResults(source)[0].getPose(local)` places the reticle.
- `select` -> clone a flower at `reticle.matrix`. `hitTestSource.cancel()` on exit. Works headless; it is already in the gallery.

### 7. hit-test-anchors.html
- As #6, with `requiredFeatures: ['local', 'hit-test', 'anchors']`.
- The page stores `hitTestResults[0]` from the rAF callback. In `select` it calls `reticleHitTestResult.createAnchor()` on that stored result.
  The result belongs to the **previous** frame. Our `anchors.ts` override (via IWER) rejects `InvalidStateError: XRFrame is not active` (reproduced). The spec text does say to reject when the frame is inactive, but this is the reference sample and it works in Chrome Android, which does not enforce the check. -> **G4**.
- Also uses `frame.trackedAnchors.has(anchor)`, `getPose(anchor.anchorSpace)`, and `anchor.delete()` beyond 30 anchors.

### 9. tests/interrupted-ar.html
- Commit `0183c53` (2020-03-19): "Sample to test interrupted AR session creation". It is **not** a test of `visibilitychange` or app backgrounding.
  The page requests `immersive-ar` (no features), calls `xrButton.setSession(session)`, then **throws** (`new Exception(...)`, a ReferenceError). It schedules `onSessionStarted` for 5 s later.
  So for 5 s the session exists with no `baseLayer`, no reference space and no rAF. After that it sets `XRWebGLLayer` + `local` and renders the solar system.
- It checks that the UA:
  - keeps a session alive with no render state and does not time out or crash;
  - shows passthrough meanwhile;
  - still lets the user exit;
  - accepts a late `baseLayer`.
- HoloWeb status:
  - Native draws the newest camera frame when no `rendered` arrives (`ARBridge+Frames.swift` falls back to the newest frame).
  - The header's EXIT button is hidden by our immersive CSS, but the native top-right "Exit AR" exists.
  - Blocked only by G2/G3: the page also runs an inline session.
  - With inline suppressed, headless shows the error tooltip, then `baseLayer` is set after 5 s and frames render.

### 10. tests/exit-button.html
- `WebXRSampleApp({ referenceSpace: 'local-floor' })`, whose defaults are `immersiveMode: 'immersive-vr'` and `inline: true`.
- Button enabled only by `isSessionSupported('immersive-vr')`, which is false under HoloWeb, so it shows "VR NOT FOUND" (disabled, verified). -> **G7**.
- If VR were offered:
  - `requestSession('immersive-vr', { requiredFeatures: ['local-floor'] })`, then `gl.makeXRCompatible()`, then `XRWebGLLayer`.
  - `cube-room.gltf` is opaque.
  - The in-world `ButtonNode` at (0, 1.2, -0.65) in `local-floor`: `select` -> `scene.handleSelect` raycasts `targetRaySpace` against selectable nodes -> `app.session.end()`. On a phone, tapping the button on screen hits it, because our `screen` ray goes through the touched pixel.
  - Also needs G2/G3 (inline session at load).

---

## Gaps with implementation notes

### G1 (JS, P0, S): three r130-r173 take the WebXR Layers path
- Checked on jsDelivr builds: `session.renderState.layers === undefined` is the switch in r130, r131, r152, r160, r165, r170. r174+ feature-detects `'createProjectionLayer' in XRWebGLBinding.prototype`; r127-r129 always use `XRWebGLLayer`.
- Fix: make `XRRenderState.layers` return `undefined` unless the session enabled `webgpu` (or a future `layers`). Keep accepting `updateRenderState({layers})`.
  Alternative: implement `XRWebGLBinding.createProjectionLayer`. That is more work and not needed.
- Test: a three r152 fixture next to `examples/fixtures/old-three-r111.html`.

### G2 (JS, P0, S): inline sessions must not reparent the page canvas
- In `device.ts` `installNativeResolution`: when `baseLayer`'s session is `inline`, skip IWER's `onBaseLayerSet` (no move into `canvasContainer`, no resize) and leave the canvas where the page put it.
- Also make sure `onSessionEnd` of an inline session does not restore or move the canvas while an immersive session owns it.

### G3 (JS, P0, M): allow inline sessions alongside one immersive session
- IWER `XRSystem.grantSession` rejects when `activeSession` exists, and the device frame loop drives only `activeSession`.
- Patch (patch-package, `HOLOWEB:` comments):
  - Track the inline session and the immersive session separately.
  - When `immersive-*` is requested while an inline session is active, park the inline session: it stays valid but gets no frames, which is how Chrome behaves while immersive. Grant the immersive session.
  - On immersive `end`, make the parked inline session active again.
  - Reject only a second immersive session.
- Then G2's canvas handling applies to the immersive session only.

### G4 (JS, P0, S): `XRHitTestResult.createAnchor()` from a stale frame
- In `anchors.ts`, accept a hit result whose frame is inactive as long as its session has not ended. Use the result's stored world pose.
  Keep the spec check for `XRFrame.createAnchor` (called on `event.frame`, which is active).

### G6 (JS, P0, S-M): dom-overlay with root = `document.body`
- Reproduced: after entering, `elementFromPoint` at the header button returns the XR `CANVAS` (plane) or IWER's container `DIV` (mesh).
  Cause: `raiseOverlay` puts `z-index:1000` on `body`, and IWER's `z-index:999` container is a child of `body`. The XR canvas therefore still covers the header.
- Also, `input.ts` ignores every pointerdown inside the overlay root. With root = body that is every touch, so `select` / `selectstart` never fire.
- Fix:
  - When the overlay root contains the canvas container, drop the container below the overlay content (`z-index: 0`, `pointer-events: none`), so XR content is drawn behind the overlay as in Chrome.
  - Implement `beforexrselect`: on pointerdown, dispatch `new Event('beforexrselect', { bubbles: true, cancelable: true })` at `e.target`. Create the XR `screen` input only if it was not cancelled, whether or not the target is inside the overlay.
  - This replaces the current "ignore taps inside the overlay" rule; the spec behaviour is "XR input unless `beforexrselect` is cancelled".

### G7 (JS + native, P1, S + S): `immersive-vr`
- Needed only by tests/exit-button (and any page that offers VR only, e.g. Babylon default experience, A-Frame "Enter VR").
- **Product decision needed**: once VR is supported, pages that try VR first choose VR. That includes both hands samples, A-Frame's default button, three `VRButton` and Babylon's default.
- JS:
  - Add `'immersive-vr'` to `supportedSessionModes`, with `environmentBlendModes['immersive-vr'] = 'opaque'`.
  - Pass the mode through `requestSession` (protocol: `mode: "immersive-ar" | "immersive-vr" | "inline"`).
  - Do not force transparent backgrounds for VR.
- Native:
  - Same ARKit world tracking (6DoF poses) with the camera feed not drawn: black in mono; in stereo HoloKit, black is see-through, so VR looks like AR.
  - Keep plane detection for `local-floor`.

### G8 (JS, P0, M; in progress): plane-detection
Page requirements for the teammate:
- Advertise `plane-detection`, and expose planes only when it is enabled.
- `frame.detectedPlanes` must keep **stable `XRPlane` identity** per ARKit id.
- `planeSpace` must follow `onPlanes` transform updates. IWER clones the matrix at construction; update `planeSpace[P_SPACE].offsetMatrix` in place.
- `polygon`: points with `x, y, z` in plane space, y = 0 (from `onPlanes.polygon`).
- `lastChangedTime` from `onPlanes.lastChanged`. IWER's `updateTrackedPlanes` overwrites it with `frame.predictedDisplayTime` every frame, so the sample would rebuild every plane's geometry every frame.
- `orientation` `"horizontal"` / `"vertical"`.
- Native already sends `onPlanes` at 10 Hz, so no native work.

### G9 (native + JS, P1): mesh-detection
Native (M):
- Only when `requestSession.features` contains `mesh-detection`:
  - `ARWorldTrackingConfiguration.supportsSceneReconstruction(.mesh)` must be true (LiDAR only). Otherwise reply `{ ok: false, error }`, which rejects the required feature cleanly.
  - Set `configuration.sceneReconstruction = .mesh`, or `.meshWithClassification` if we want `semanticLabel`.
  - Today `startARSession()` always runs a fixed config. Make it feature-driven, because meshing costs CPU, GPU and heat.
- Per `ARMeshAnchor` (didAdd / didUpdate / didRemove):
  - `transform` goes to `meshSpace`.
  - `geometry.vertices` (`ARGeometrySource`: MTLBuffer, `format .float3`, `stride`, `offset`, `count`): copy into packed xyz float32. The stride can exceed 12.
  - `geometry.faces` (`ARGeometryElement`, `bytesPerIndex 4`, `indexCountPerPrimitive 3`, `count` triangles): Uint32 triangle list.
  - Classification is per face (`geometry.classification`, uint8). For `semanticLabel` take the majority class: wall -> `wall`, floor -> `floor`, ceiling -> `ceiling`, table -> `table`, seat -> `couch`, window -> `window`, door -> `door`, none -> omit.
- Size and rate: vertices are 12 B each and faces ~24 B per vertex (about 2 triangles per vertex), so ~36 B per vertex.
  A room is typically tens to ~150 anchors and ~50k-300k vertices: **~2-11 MB per full snapshot** (estimate; measure on device).
  ARKit re-meshes changed chunks about every 0.5-1 s while scanning.
- Transport (protocol addition): `bridge.onMeshes(changes)` at **at most 2 Hz**, dirty anchors only, per-call budget ~1 MB (spill the rest to the next tick):
  - Metadata: `[{ id, transform: number[16], lastChanged: ms, label?, vertices?: base64 (float32 xyz), indices?: base64 (uint32) }]`. Geometry is included only when it changed; a transform-only update omits it.
  - Removal: `{ id, removed: true }`.
  - Base64 matches `onEnvironment`. Decoding into a fresh ArrayBuffer gives aligned `Float32Array`/`Uint32Array` views.
  - If profiling shows base64 cost is too high: serve binary through the existing `WKURLSchemeHandler` (`BundledPageSchemeHandler`) as `fetch(holoweb-data://mesh/<id>/<version>)` with CORS headers.

JS (M):
- A `MeshEnvironment` (or extend `PlaneEnvironment`) returning `trackedMeshes` as a Set of **stable `NativeMesh` objects**, one per id, mutated in place.
- IWER `updateTrackedMeshes` needs the same patch as planes:
  - update `xrMesh[P_MESH].vertices/indices` when native geometry changes;
  - update `meshSpace` offsetMatrix in place;
  - set `lastChangedTime` only on a geometry change. Today IWER stamps it every frame, which would re-upload every mesh every frame.
- Advertise `mesh-detection` only if `ready` reports the capability (**G13**).
- `hit-test` against meshes is not needed for this sample; it raycasts in three.js.

### G10 (native + JS, P1, native M-L, JS S): hand tracking
Confirmed with the lead against the iOS 27 SDK:
- Vision's Swift `DetectHumanHandPoseRequest` returns `HumanHandPoseObservation`: 21 2D joints per hand, each with confidence, plus `chirality` (ObjC: `VNDetectHumanHandPoseRequest`).
- Vision has no 3D hand request, and ARKit hand anchors are visionOS-only. So 3D comes from LiDAR depth.

Already done in JS (uncommitted; `src/hands.ts`, `src/hand-input.ts`, see `plan/notes.md` "hand tracking"):
- 21 -> 25 joint mapping.
- Joint frames and radii.
- IWER `XRHandInput`: `inputSource.hand`, `targetRayMode 'tracked-pointer'`, profiles incl. `generic-hand`, `getJointPose` / `fillPoses` / `fillJointRadii`.
- Pinch -> `selectstart` / `select` / `selectend`.

Still missing:
- in JS: smoothing, squeeze, and a timestamp field;
- in native: all of it.

**Protocol** (extends the notes proposal): `bridge.onHands({ t, hands: [{ handedness: "left" | "right", joints: number[63], confidence: number[21], depthValid: number (bitmask of joints with measured depth) }] })`.
- `t` is the source ARFrame timestamp in ms. The polyfill needs it for the filter and to line hands up with the pose used for `rendered`.
- Send `hands: []` when nothing is seen. Hands with `chirality == .unknown` are dropped natively.

**Native pipeline** (`HandTracker`, new file, shared by the app and App Clip targets like `ARBridge.swift`):
1. Enable only if `requestSession.features` contains `hand-tracking`.
   - Add `.smoothedSceneDepth` to `frameSemantics` (`supportsFrameSemantics(.smoothedSceneDepth)` must be true; LiDAR only). `smoothedSceneDepth` is better than raw `sceneDepth` for fingers because it averages across frames. Take raw `sceneDepth` if motion blur on fast hands turns out worse.
   - Without LiDAR: skip hand tracking (do not advertise it; see G13).
2. On a serial background queue, take the newest `ARFrame`. If the tracker is busy, drop the frame: never queue, and never block `session(_:didUpdate:)`.
   - Run `DetectHumanHandPoseRequest` (`maximumHandCount = 2`) on `capturedImage` (1920x1440 YCbCr) with orientation `.up`. The buffer is in sensor/landscape orientation, the same frame as the intrinsics.
   - Keep a reference only to the `CVPixelBuffer` and the needed camera values, not the `ARFrame` itself. ARKit warns when frames are retained, and holding them starves its buffer pool.
3. Budget (estimate; measure with `os_signpost` on the 15 Pro):
   - Vision hand pose on A17 Pro is ~8-15 ms per frame (ANE/GPU), with the input scaled internally to the model size. The cost is roughly fixed per image.
   - Run at **30 Hz** (every other ARFrame). That is about 25-45 % of one background thread plus ANE time, and it keeps the 60 Hz ARKit and WebKit path free.
   - Drop to 15 Hz when `ProcessInfo.thermalState >= .serious`, and stop at `.critical`.
   - Once a hand is known, set `regionOfInterest` to the last hand box grown by 50 %: a smaller effective input, and faster. Reset to the full frame when the hand is lost.
4. For each observation:
   - `chirality` -> `handedness`. The rear camera is not mirrored, so `.left` should mean the user's left hand; **verify on device**.
   - Points are normalised with a lower-left origin. Convert to capturedImage pixels: `u = x * W`, `v = (1 - y) * H`.
5. Depth lift for each joint:
   - Sample `smoothedSceneDepth.depthMap` (256x192 Float32, metres) at `(u, v) * 256/1920`. Use a 3x3 median, and only pixels whose `confidenceMap` is `.medium` or `.high`.
   - Palm anchor: median depth of wrist + the 4 finger MCPs + thumb CMC. The palm is large and flat, so it almost always has valid depth.
   - Fingertips and thin phalanges often sample the background at silhouette edges. Clamp each joint's depth to `palm ± 0.08 m`. A joint outside that window, or with no valid pixel, gets the palm depth plus the previous frame's offset, and its `depthValid` bit is cleared.
   - Unproject with `camera.intrinsics` (at capturedImage resolution): `X = (u - cx)/fx * d`, `Y = -(v - cy)/fy * d`, `Z = -d` (camera space, +Y up, -Z forward).
   - Transform by the raw `camera.transform` (sensor orientation, matching the image) into ARKit world space = WebXR `local`.
6. Send `onHands` straight away (coalesced like `onFrame`; skip if the previous call has not returned).
   - Latency (estimate): Vision 8-15 ms + depth/unproject < 1 ms + delivery <= 1 display frame. At 30 Hz, the hand is ~1-3 frames (33-70 ms) older than the camera image in mono.
   - Optional later: the JS filter's trend term can extrapolate to the rendered frame's timestamp.

**Joint mapping** (21 Vision -> 25 WebXR, in `XRHand` order):

| WebXR joint | Source |
|---|---|
| `wrist` | Vision `wrist` (at the wrist crease, the same place as the WebXR wrist joint). Orientation: -Z towards the middle MCP, +Y = back of the hand from `cross(indexMCP - wrist, pinkyMCP - wrist)`, negated for the right hand |
| `thumb-metacarpal`, `-phalanx-proximal`, `-phalanx-distal`, `-tip` | thumb CMC, MP, IP, tip (1:1) |
| `<finger>-metacarpal` (index, middle, ring, pinky) | **interpolated**: `lerp(wrist, MCP, 0.25)`. Vision has no finger CMC joints; the real CMCs sit about a quarter of the way from wrist to knuckle. For ring and pinky, 0.2 is closer to anatomy; tune on device |
| `<finger>-phalanx-proximal`, `-intermediate`, `-distal`, `-tip` | MCP, PIP, DIP, tip (1:1) |

- Joint orientation: -Z along the bone towards the next joint (tips reuse the last bone), +Y dorsal (as `wrist`), X = Y x Z.
- Using a single palm normal for every joint is fine for boxes and spheres. For three's `XRHandMeshModel`, check that fingers do not twist.

**Radii** for `fillJointRadii` (estimates, adult hand, metres; current `hands.ts` values in brackets). A per-user version can scale all radii by `|wrist - middleMCP| / 0.095`.

| Joint | Radius |
|---|---|
| wrist | 0.020 [0.020] |
| thumb-metacarpal / proximal / distal / tip | 0.012 / 0.010 / 0.009 / 0.008 [same] |
| finger metacarpal | 0.011 [0.010] |
| finger phalanx-proximal | 0.010 [0.010] |
| finger phalanx-intermediate | 0.009 [0.009] |
| finger phalanx-distal | 0.008 [0.008] |
| finger tip | 0.007 [0.007] |
| pinky (all joints) | x0.85 of the above (not in `hands.ts`) |

The WebXR spec says the radius is the distance from the joint to the skin, so these are half-thicknesses. `fillJointRadii` returns false if any radius is missing, which hides the whole hand in the samples, so every joint must always have one.

**Temporal smoothing** (JS, S, in `hands.ts` before `buildSkeleton`):
- A **One Euro filter** per joint on world xyz, using the native `t` (seconds) for `dt`.
- Filter positions only; orientations are rebuilt from the filtered points, so they stay consistent.
- Starting parameters, metres and seconds, to tune on device: `minCutoff = 1.5 Hz`, `beta = 2.0` (Hz per m/s; a 0.5 m/s motion raises the cutoff by 1 Hz), `dCutoff = 1.0 Hz`.
- Joints whose `depthValid` bit is clear get `minCutoff = 0.7 Hz` (smoother, since their z is inferred).
- Reset a hand's filters when it reappears after `LOST_MS` (250 ms) or its handedness changes.
- Why JS and not native: the filter needs the same timestamps the page sees, and keeping native stateless makes it easier to test with mock hands.

**select / squeeze** (JS, S):
- **Pinch -> select** (exists): thumb-tip to index-tip distance, hysteresis on < 2.0 cm and off > 3.5 cm, measured after filtering. Scale both thresholds by hand size (`|wrist - middleMCP| / 0.095`) so small hands and depth bias do not break it.
- **Grab -> squeeze** (new):
  - Curl ratio `c = mean over index..pinky of |tip - wrist| / |MCP - wrist|`. An open hand is ~1.9-2.1, a fist ~1.0-1.2.
  - Squeeze on when `c < 1.35`, off when `c > 1.55`, dispatching `squeezestart`, then `squeeze` + `squeezeend` on release, in spec order, like select.
  - While squeezing, suppress pinch: a fist brings the thumb onto the index finger.
  - Expose both states on the `generic-hand` gamepad: button 0 = pinch (select), button 1 = grab (squeeze). This matches IWER's `XRHandGamepadConfig` convention for button 0.
- Target ray: exists. Origin at the pinch point, pointing away from the viewer through it. `gripSpace`: IWER's; put it at the palm centre (mean of wrist and MCPs) with the palm orientation.
- `visibilitychange` (G11): on `visible-blurred` / `hidden`, end any active select or squeeze without firing `select` / `squeeze`, then drop hands.

**App Clip:** yes.
- `ARBridge.swift` is already built into both targets (two `PBXBuildFile` entries); add the new `HandTracker.swift` to both.
- App Clips can use Vision and ARKit, and the hand-pose model ships with iOS, so the Clip only grows by our code.
- Same gating: runs only when the page requests `hand-tracking`.

**Verification plan:**
- Unit tests (`hands.test.ts`):
  - One Euro step response and jitter reduction on a synthetic noisy hand;
  - squeeze hysteresis and pinch suppression;
  - event order for `squeezestart` / `squeeze` / `squeezeend`.
- Device:
  - `immersive-hands.html` and `webgpu/immersive-hands.html` show 25 boxes per hand;
  - the index box enters the rotating box;
  - log signposts for Vision ms per frame at 30 Hz, thermal state after 5 min, and the chirality check.

### G11 (native + JS, P2, S + S): visibility and interruption
Today `sessionWasInterrupted` only logs, there is no scene-phase handling, and `visibilityState` is always `visible`. Map it as follows:

| Native event | XR `visibilityState` | Notes |
|---|---|---|
| `UIApplication.willResignActive` / scenePhase `.inactive` (Control Center, notification shade, call banner, Siri) | `visible-blurred` | page still visible, input suppressed |
| scenePhase `.background` / `didEnterBackground` | `hidden` | rAF stops anyway; ARKit is interrupted by the system |
| `ARSessionObserver.sessionWasInterrupted` while active (camera taken, e.g. by multitasking) | `visible-blurred` | tracking `notAvailable`; poses become emulated/null |
| `sessionInterruptionEnded` / `didBecomeActive` | `visible` | also return `true` from `sessionShouldAttemptRelocalization` to keep the ARKit origin; if the origin resets, dispatch `reset` on `local`/`local-floor` |

- Protocol: `bridge.onVisibility(state)`.
- JS:
  - Set IWER's `device[P_DEVICE].visibilityState` and dispatch `XRSessionEvent('visibilitychange')` immediately. `device.updateVisibilityState` only fires on the next frame, which never comes while hidden.
  - On any state other than `visible`, cancel the active screen touch and any pinching hand (`selectend` without `select`), and suppress new input. IWER already empties `activeInputs` for its own inputs.
- Keep the session alive across background/foreground; end it only if ARKit fails.

### G12 (JS, P2, S): WebGPU subimage details
- Allocate `depthStencilTexture` (2-layer array, `depthStencilFormat`) when the page asks for it. That is spec behaviour, and it removes the 1x1 depth mismatch in the immersive-web renderer.
- Prime the inert 2nd view only when `globalThis.__THREE__` is defined. The workaround is three-specific; other renderers such as the samples' `GPURenderer` break on a 0x0 view.
- Check that three r186 behaves the same when `depthStencilTexture` is non-null before shipping.

### G13 (native + JS, P2, S): capabilities in `ready`
- `ready` reply gains `capabilities: { sceneReconstruction: bool, sceneDepth: bool }` (`supportsSceneReconstruction(.mesh)`, `supportsFrameSemantics(.sceneDepth)`).
- The polyfill builds `supportedFeatures` from it (`mesh-detection` only with LiDAR). Pages that require it then fail at `requestSession`, not later.

## Not worth doing now
- Fixing the "START VR" / "ENTER VR" labels: they are sample bugs, and the sessions requested are AR.
- `tracked-sources` (Meta-specific, optional).
- `bounded-floor` (optional, unused).
- `XRWebGLBinding.createProjectionLayer` for WebGL (G1's getter fix is enough).

---

## Website: gallery thumbnails (holoweb-website)

Conclusion: **lazy loading below the fold, not a file problem.** No fix needed. The headless check should scroll, or treat `loading="lazy"` images as expected-pending.

Evidence:
- All six files are valid baseline JPEGs:
  - `file`: "JPEG image data, JFIF standard 1.01, baseline, precision 8, 1200x750, components 3".
  - `sips`: 1200x750, RGB, 8 bit.
  - SOI `ffd8ff` and EOI `ffd9` markers are present (not truncated).
  - `sips -s format png` decodes every one.
  - PIL `Image.load()` with warnings raised as errors decodes all, and none is blank (mean/std luminance: playcanvas 92/24, model-viewer 225/59, aframe 40/46, ballshooter 89/28, three-ar-lighting 13/48, toji 61/28).
- `out/gallery/*.jpg` are byte-identical to `public/gallery/*.jpg` (`cmp`).
- `app/components/Gallery.tsx:57` renders `<img … loading="lazy" decoding="async">`. `out/index.html` has the same attributes.
- The six are exactly gallery.json entries 6-12 with thumbnails (11 babylon-measure-tape has none). At 390 px the single-column cards are ~620 px apart.
- Reproduced with Playwright on `out/` at 390x844 DPR 3:
  - After `networkidle`: entries 0-5 (top <= 3706 px) complete with `naturalWidth 1200`; the six at top >= 4329 px have `complete=false, naturalWidth=0`.
  - After scrolling to the bottom: all 12 complete with `naturalWidth 1200`.
