# Task Plan: HoloWeb app architecture plan

## Goal
Deliver an executable plan for HoloWeb: (1) iOS app + App Clip that loads a webpage, with iOS 27 WebGPU status verified; (2) WebXR polyfill library selection; (3) real-time ARKit -> polyfill bridge that renders WebXR in mono and two stereoscopic modes.

## Phases
- [x] Phase 1: Survey repo (targets, existing polyfill, renderer, state)
- [x] Phase 2: Research — iOS 27 WKWebView WebGPU, WebXR polyfill candidates (webxr-polyfill, webxr-ios-js, IWER, Variant Launch), App Clip constraints
- [x] Phase 3: Design bridge architecture (message protocol, frame loop, stereo/mono view math, compositing)
- [x] Phase 4: Write deliverable plan/holoweb_plan.md with milestones + verification
- [x] Phase 5: Review and deliver summary
- [x] Execution: M0 cleanup, M1 WebGPU check, M2 polyfill, M3/M3b bridge + camera sync, M4 XRGPUBinding, M5 stereo (math + prediction), M6 App Clip, M7 anchors/light/floor — all verified on iPhone 15 Pro iOS 27 (see notes.md logs)
- [x] AASA deploy (holoweb.app, cached by Apple CDN)
- [x] App Store Connect record "HoloWeb: WebXR for iPhone" (6815450023) + TestFlight: 1.0 (2609240146) uploaded via Scripts/testflight.sh, VALID; internal group "Internal" with amber@reality.design (2026-09-24)
- [ ] Push holoweb-app (website pushed 2026-09-24; app blocked on 6 remote README commits from 2024, merge pending)
- [ ] iOS 27: replace deprecated `viewMatrix(for:)` / `projectionMatrix(for:…)` / `displayTransform(for:…)` with the rotation-angle APIs
- [ ] Cardboard viewer mode v1: viewer profiles (handheld / HoloKit / Cardboard), mode picker, Cardboard stereo math, opaque, tests, device check
- [ ] Cardboard v2: lens distortion mesh, camera passthrough for immersive-ar

## Key Questions
1. Does WKWebView on iOS 27 expose navigator.gpu (WebGPU)? Any feature flag needed?
2. Which polyfill: keep Mozilla webxr-ios-js fork (already bundled) vs. IWER vs. fresh webxr-polyfill CustomWebXRDevice?
3. How to push ARKit poses per frame with low latency (postMessage vs callJavaScript vs SharedArrayBuffer-free approach)?
4. Stereo: HoloKit-style side-by-side with per-eye projection + IPD offset; who composites camera background (Metal) vs. web content (transparent WKWebView)?
5. App Clip: size limit, ARKit/camera allowed, WKWebView allowed, Info.plist keys.

## Decisions Made
- Polyfill base: fork IWER 2.4.0 core with per-eye projection/viewport override patches; retire webxr2.0.js. Rationale: maintained, modern API surface; only two small patches needed.
- Transport: native-push FramePacket per ARFrame via evaluateJavaScript; JS keeps latest packet. Rationale: removes one round trip vs the legacy onUpdate poll.
- WebGPU: rely on iOS 26+ default; content must use WebGL2 backend for XR until XRGPUBinding is polyfilled (P2).
- App Clip: digital invocation first (100 MB cap), keep bundle small for a later 15 MB QR option.
- Brand (2026-09-24): HoloWeb is a device-agnostic WebXR runtime; HoloKit and Cardboard are viewer modes. A brief HoloKit Web rename was reverted.
- Cardboard v1: opaque (no camera) and no lens-distortion correction; both are v2. AR Module mapping: handheld = alpha-blend/screen-space, HoloKit = additive/world-space, Cardboard = opaque/world-space.

## Errors Encountered
- (none yet)

## Execution log
- 2026-09-22: M0 project cleanup done by orchestrator (aaa target removed, deployment target 27.0, Swift consolidated, scratch dirs moved to session scratchpad). Metal toolchain component downloaded. User requires min iOS 27, WKJSHandle transport, Opus subagents for implementation. Protocol in plan/bridge_protocol.md.

## Status
**Automatable work complete.** Remaining items need a person with the phone/HoloKit or a product decision: HoloKit X optical alignment + prediction tuning, visual mono alignment, tap-to-place on a real floor, rotation mid-session, AASA deploy + App Store Connect App Clip experience + TestFlight, consent/origin display for third-party pages, optional CoreMotion gyro prediction (full app only).
