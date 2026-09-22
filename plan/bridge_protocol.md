# HoloWeb native <-> polyfill bridge protocol (v1)

Minimum OS: iOS 27.0. Transport uses `WKJSHandle` (iOS 27) so native calls into a JS object by reference.

## Setup
1. Polyfill (`holoweb-polyfill.js`) is injected as a `WKUserScript` at document start, main frame only, in the page world.
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
| `log` | `{ level, message }` | `{ ok }` |

## native -> JS calls (via `callAsyncJavaScript(functionBody, arguments:, in: nil, in: .page)` with the stored handle passed as `bridge`)
`bridge.onFrame(t, mode, transform, view, proj, light, tracking, orientation)` once per ARFrame (60 Hz, coalesced: skip if previous call has not returned).
- `t`: ARFrame.timestamp in ms (Double)
- `mode`: "mono" | "stereo"
- `transform`: number[16] column-major display-oriented camera pose = `inverse(view)` (NOT raw `ARCamera.transform`, which is in sensor/landscape-right orientation). Use it directly as the WebXR viewer pose in `local` space.
- `view`: number[16] column-major `ARCamera.viewMatrix(for: orientation)` where orientation = current interface orientation (mono) or `.landscapeLeft` (stereo)
- `proj`: number[16] column-major `ARCamera.projectionMatrix(for: orientation, viewportSize: webViewSizePx, zNear: 0.01, zFar: 1000)`. JS rewrites entries [10] and [14] from the session's depthNear/depthFar.
- `light`: `{ ambientIntensity, ambientColorTemperature }` (lux, kelvin) or null
- `tracking`: "normal" | "limited" | "notAvailable"
- `orientation`: "portrait" | "portraitUpsideDown" | "landscapeLeft" | "landscapeRight" (interface orientation used for view/proj)

`bridge.onPlanes(planes)` at most 10 Hz when the plane set changed: `[{ id, transform: number[16], extent: [w, h], orientation: "horizontal" | "vertical" }]`.
`bridge.onSessionEnded(reason)` when native ends the session (interruption, background).

## Coordinate conventions
ARKit world == WebXR `local` reference space (right-handed, Y-up, metres, origin at session start). `viewer` = camera (mono) or centre-eye (stereo). `local-floor` = `local` translated down by the lowest horizontal plane, else 1.3 m.

## Stereo (HoloKit) responsibilities
Native: locks landscapeLeft, draws black background, reports device model/screen metrics in `ready`.
Polyfill: computes centre-eye pose = cameraPose * T(CameraOffset + MrOffset), per-eye offsets +-ipd/2, per-eye off-axis projection and pixel viewport rects from the HoloKit constants and phone table (see plan/notes.md "HoloKit stereo math").
