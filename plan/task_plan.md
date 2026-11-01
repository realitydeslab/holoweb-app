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
- [x] Push holoweb-app + holoweb-website (2026-09-24; merged 6 remote 2024 README commits, c0e7f52)
- [x] TestFlight 1.0 (2610281251) uploaded via Scripts/testflight.sh (2026-10-28), from the uncommitted iOS 27 rotation-angle tree; same build (Debug) installed on Holo iPhone 15 A and Crack B; "Internal" group gets it automatically
- [x] TestFlight 1.0 (2610292249) uploaded (2026-10-29): 2610281251 + Swift concurrency warning cleanup (0 Swift warnings in a clean build)
- [x] TestFlight 1.0 (2611011702) uploaded (2026-11-01, VALID) from feat/ios27-iwer-2.7 at 95b87eb: iOS 27 APIs + concurrency cleanup + IWER 2.7.0 (PR #208)
- [x] iOS 27: replace deprecated `viewMatrix(for:)` / `projectionMatrix(for:…)` / `displayTransform(for:…)` with the rotation-angle APIs, and `UIScreen.main` with the window scene's screen (2026-10-29: clean build of app + tests has 0 deprecation warnings; on-device portrait/landscape AR check still pending)
- [ ] Cardboard viewer mode v1: viewer profiles (handheld / HoloKit / Cardboard), mode picker, Cardboard stereo math, opaque, tests, device check
- [ ] Cardboard v2: lens distortion mesh, camera passthrough for immersive-ar
- [x] IWER 2.4.0 -> 2.7.0 built from PR #208 (meta-quest/immersive-web-emulation-runtime, head ce99bce, upstream XRGPUBinding):
  - [x] build iwer-2.7.0.tgz from the PR head (pnpm build + pack)
  - [x] vendor the tgz in polyfill/vendor/ + a script that rebuilds it from the pinned SHA; package.json -> file:
  - [x] port patches/iwer+2.4.0.patch to 2.7.0: keep per-eye projection/viewport, mono 'none' view, XRRay, remote removal, full-framebuffer clear; drop layers render state, onFrameEnd, 'webgpu' type (upstream has them)
  - [x] switch to IWER's XRGPUBinding + compositor; remove src/gpu-binding.ts, src/gpu-presenter.ts; keep HoloKit stereo viewports, mono camera passthrough, visibility handling of IWER's WebGPU canvas
  - [x] gates: vitest 120/120, typecheck, build 251.6 KB (budget raised to 260 KB), e2e Chromium 41/41, Xcode build (WebKit e2e not run)
  - [x] device: three-ar-webgpu + WebGL examples, mono + stereo, on iPhone 15 Pro (Holo iPhone 15 I, 2026-11-01)

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
