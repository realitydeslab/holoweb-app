# HoloWeb native <-> polyfill bridge protocol (v1)

Minimum OS: iOS 27.0. Transport uses `WKJSHandle` (iOS 27) so native calls into a JS object by reference.

## Setup
1. Polyfill (`holoweb-polyfill.js`) is injected as a `WKUserScript` at document start, in all frames, in the page world. Native accepts messages from the main frame and from iframes whose security origin (scheme/host/port) equals the main frame's; cross-origin (incl. opaque, e.g. data:) frames are rejected with "holoweb bridge is available to the main frame only". Each frame's `ready` (optional `frame` id field) is stored separately; the frame that sends `requestSession` becomes the target of native -> JS calls (`callAsyncJavaScript(..., in: thatFrame, ...)`).
2. Native enables `WKWebpagePreferences.allowsJSHandleCreationInPageWorld = true` in
   `webView(_:decidePolicyFor:preferences:decisionHandler:)` for every navigation.
3. Native registers ONE message handler with reply: `holoweb` (`WKScriptMessageHandlerWithReply`).
4. On load the polyfill creates `const bridge = { onFrame(...) {...}, onTracking(...) {...}, onPlanes(...) {...}, onSessionEnded() {...} }`
   and posts `{ type: "ready", bridge: window.webkit.createJSHandle(bridge) }`. Native stores the `WKJSHandle`.
   If `window.webkit.createJSHandle` is missing the polyfill posts `{ type: "ready", bridge: null }` and native falls back to
   `evaluateJavaScript("window.__holoweb.onFrame(...)")` (dev/emulator path only).

## JS -> native messages (all via `window.webkit.messageHandlers.holoweb.postMessage(obj)`, all return a Promise)
| type | payload | reply |
|---|---|---|
| `ready` | `{ bridge: WKJSHandle \| null }` | `{ ok, device: { model, screenWidthPx, screenHeightPx, scale, dpi }, mode }` |
| `requestSession` | `{ mode: "immersive-ar" \| "inline", features: string[] }` | `{ ok, mode: "mono" \| "stereo", frameRate }` — native starts pushing frames |
| `endSession` | `{}` | `{ ok }` — native stops pushing frames |
| `hitTest` | `{ origin: [x,y,z], direction: [x,y,z] }` (world space, metres) | `{ hits: [{ pose: number[16], type: "plane" \| "estimated" }] }` |
| `setMode` | `{ mode: "mono" \| "stereo" }` | `{ ok }` |
| `createAnchor` | `{ pose: number[16] }` world pose, column-major | `{ id }` — native adds an `ARAnchor`; its tracked pose then arrives via `onAnchors` |
| `deleteAnchor` | `{ id }` | `{ ok }` |
| `rendered` | `{ t }` ARFrame timestamp (ms) of the pose used for the XR frame just drawn; send once per XR frame, do not await | `null` — native draws the matching camera image (mono) |
| `log` | `{ level, message }` | `{ ok }` |

## native -> JS calls (via `callAsyncJavaScript(functionBody, arguments:, in: nil, in: .page)` with the stored handle passed as `bridge`)
`bridge.onFrame(t, mode, transform, view, proj, light, tracking, orientation, sentAt)` once per ARFrame (60 Hz, coalesced: skip if previous call has not returned).
- `t`: ARFrame.timestamp in ms (Double)
- `mode`: "mono" | "stereo"
- `transform`: number[16] column-major display-oriented camera pose = `inverse(view)` (NOT raw `ARCamera.transform`, which is in sensor/landscape-right orientation). Use it directly as the WebXR viewer pose in `local` space.
- `view`: number[16] column-major `ARCamera.viewMatrix(for: orientation)` where orientation = the live interface orientation (stereo locks it to `.landscapeRight`)
- `proj`: number[16] column-major `ARCamera.projectionMatrix(for: orientation, viewportSize: webViewSizePx, zNear: 0.01, zFar: 1000)`. JS rewrites entries [10] and [14] from the session's depthNear/depthFar.
- `light`: `{ ambientIntensity, ambientColorTemperature }` (lux, kelvin) or null
- `tracking`: "normal" | "limited" | "notAvailable"
- `sentAt`: native wall-clock send time, epoch ms (diagnostics: page computes one-way latency as `performance.timeOrigin + performance.now() - sentAt`)
- `orientation`: "portrait" | "portraitUpsideDown" | "landscapeLeft" | "landscapeRight" (interface orientation used for view/proj)

`bridge.onPlanes(planes)` at most 10 Hz when the plane set changed: `[{ id, transform: number[16], extent: [w, h], orientation: "horizontal" | "vertical", polygon: number[] (flat x,y,z triples in the plane's local space, y = 0, counter-clockwise seen from +Y, from ARPlaneAnchor.geometry.boundaryVertices, relative to the same `transform`), lastChanged: ms (ARFrame timestamp of the last update of this plane) }]`. Plane `transform` is the plane-centre pose with +Y = plane normal.
`bridge.onAnchors(anchors)` at most 10 Hz when any app-created anchor moved: `[{ id, transform: number[16] }]`; an anchor ARKit removed is sent once with `transform: null`.
`bridge.onEnvironment(env)` only if the `requestSession` features include `light-estimation`, at most 1 Hz when ARKit's environment probe (AREnvironmentProbeAnchor, `environmentTexturing = .automatic`) changes: `{ size: 32, format: "rgba8", colorSpace: "srgb", faces: [px, nx, py, ny, pz, nz] (6 base64 strings of size*size*4 bytes, row 0 = top, WebGL/OpenGL cube-face order and orientation), timestamp: ms }`. The polyfill turns it into `XRWebGLBinding.getReflectionCubeMap(probe)` and fires `reflectionchange` on the light probe.
`bridge.onHands(hands)` only when requestSession.features contains 'hand-tracking', after each Vision result (~30 Hz), `[]` when no hand: `[{ handedness: "left" | "right", joints: number[63] (21 x world-space xyz in metres, Vision order: 0 wrist; 1-4 thumb CMC, MP, IP, tip; 5-8 index MCP, PIP, DIP, tip; 9-12 middle; 13-16 ring; 17-20 little), confidence: number[21] }]`. Native pipeline: Vision DetectHumanHandPoseRequest (max 2 hands) on ARFrame.capturedImage off the main thread, dropping frames while busy; sample smoothedSceneDepth at each joint (confidence map; fall back to the median valid joint depth); unproject with the camera intrinsics X=(u-cx)/fx*d, Y=-(v-cy)/fy*d, Z=-d; transform by the raw ARCamera.transform (sensor orientation, matching capturedImage). The polyfill builds the 25 XRHand joints, radii, and pinch select.
`bridge.onMeshes(update)` only when requestSession.features contains 'mesh-detection' (LiDAR, ARWorldTrackingConfiguration.sceneReconstruction = .mesh), at most 2 Hz, only changed meshes: `{ meshes: [{ id, transform: number[16], vertices: base64 Float32 xyz (mesh-local), indices: base64 Uint32 triangle list, lastChanged: ms, semanticLabel?: string }], removed: [id] }`.
`bridge.onVisibility(state)` on ARSession interruption / app background / foreground: `"visible" | "visible-blurred" | "hidden"`; the polyfill maps it to XRSession.visibilityState + visibilitychange.
`bridge.onSessionEnded(reason)` when native ends the session (interruption, background).

## Coordinate conventions
ARKit world == WebXR `local` reference space (right-handed, Y-up, metres, origin at session start). `viewer` = camera (mono) or centre-eye (stereo). `local-floor` = `local` translated down by the lowest horizontal plane, else 1.3 m.

## Stereo (HoloKit) responsibilities
Native: locks UIInterfaceOrientation.landscapeRight (= Unity LandscapeLeft, home side on the right), draws black background, reports device model/screen metrics in `ready`.
Polyfill: computes centre-eye pose = cameraPose * T(CameraOffset + MrOffset), per-eye offsets +-ipd/2, per-eye off-axis projection and pixel viewport rects from the HoloKit constants and phone table (see plan/notes.md "HoloKit stereo math").
