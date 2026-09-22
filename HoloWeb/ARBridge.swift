// SPDX-FileCopyrightText: Copyright 2026 Reality Design Lab <dev@reality.design>
// SPDX-License-Identifier: MIT

import ARKit
import UIKit
import WebKit

/// Native side of the HoloWeb bridge (see plan/bridge_protocol.md).
///
/// JS -> native: one `holoweb` message handler with replies, main frame and same-origin iframes.
/// native -> JS: `callAsyncJavaScript` on the page's bridge object, addressed through the
/// `WKJSHandle` the polyfill hands over in its `ready` message (iOS 27). If the page could not
/// create a handle, calls go to `window.__holoweb` instead.
/// Frame streaming, planes and anchors live in ARBridge+Frames.swift.
@MainActor
final class ARBridge: NSObject {
    static let handlerName = "holoweb"

    weak var state: HoloWebState?
    let session: ARSession
    let webView: WKWebView

    /// Frames that sent `ready` (main frame and same-origin iframes), by frame key.
    var frames: [String: BridgeFrame] = [:]
    var activeFrameKey: String?
    /// Origin of the current main-frame document; same-origin iframes may use the bridge.
    var mainOrigin: BridgeOrigin?
    var pageReady = false
    var streaming = false
    /// Bumped whenever the page changes, so completions from an old page are ignored.
    var pageGeneration = 0
    /// onFrame calls not yet acknowledged. The completion arrives ~17-20 ms after delivery on
    /// iPhone 15 Pro, so two in flight keep 60 Hz while bounding the queue if the page stalls.
    var framesInFlight = 0
    static let maxFramesInFlight = 2
    var planesDirty = false
    var lastPlanesSent: TimeInterval = 0
    var lastPlanesLog: TimeInterval = 0
    var loggedPlaneWinding = false
    /// Planes added or updated since the last ARFrame; stamped with that frame's timestamp.
    var pendingPlaneUpdates: Set<UUID> = []
    /// ARFrame timestamp (ms) of each plane's last add/update, sent as `lastChanged`.
    var planeLastChanged: [UUID: Double] = [:]
    /// Environment probes ARKit maintains (`environmentTexturing = .automatic`), by identifier.
    var environmentProbes: [UUID: AREnvironmentProbeAnchor] = [:]
    var environmentDirty = false
    /// The page asked for "light-estimation"; environment maps (~33 KB each) are sent only then.
    var environmentRequested = false
    var lastEnvironmentSent: TimeInterval = 0
    let environmentReader = EnvironmentProbeReader()
    var loggedEnvironment = false
    /// The page asked for "hand-tracking".
    var handsRequested = false
    let handTracker = HandTracker()
    var handStats = HandStats()
    /// The page asked for "mesh-detection".
    var meshesRequested = false
    let meshStreamer = MeshStreamer()
    /// Last `onVisibility` state sent this session.
    var visibility = "visible"
    /// Anchors the page created, by identifier. Held directly so removal never depends on
    /// `session.currentFrame` (nil while paused, stale right after creation).
    var pageAnchors: [String: ARAnchor] = [:]
    var removedAnchorIDs: Set<String> = []
    var anchorsDirty = false
    var lastAnchorsSent: TimeInterval = 0
    /// Recently pushed frames, newest last. Kept small and cleared whenever streaming stops:
    /// ARKit's capture buffer pool is shallow and retained frames stall tracking.
    var recentFrames: [ARFrame] = []
    static let recentFrameLimit = 3
    /// ARFrame timestamp (ms) the page reported as rendered most recently.
    var renderedTimestamp: Double?
    var framesPushed = 0
    var framesSkipped = 0
    var statsFrames = 0
    var lastStatsTime: TimeInterval = 0

    init(state: HoloWebState, session: ARSession, webView: WKWebView) {
        self.state = state
        self.session = session
        self.webView = webView
        super.init()
        // WKUserContentController retains handlers strongly; the proxy breaks the cycle.
        webView.configuration.userContentController.addScriptMessageHandler(
            WeakReplyHandler(self), contentWorld: .page, name: Self.handlerName)
        webView.navigationDelegate = self
        session.delegate = self
        observeSceneActivation()
    }

    private var target: String { bridgeHandle != nil ? "bridge" : "window.__holoweb" }

    /// Calls `target.<body>` in the page. The completion runs only if the page is unchanged.
    func call(_ body: String, _ arguments: [String: Any], completion: (@MainActor () -> Void)? = nil) {
        var args = arguments
        if let bridgeHandle { args["bridge"] = bridgeHandle }
        let generation = pageGeneration
        let frame = activeFrame.flatMap { $0.info.isMainFrame ? nil : $0.info }
        webView.callAsyncJavaScript("if (\(target)) { return \(target).\(body); }",
                                    arguments: args, in: frame, in: .page) { [weak self] result in
            if case .failure(let error) = result {
                let detail = (error as NSError).userInfo["WKJavaScriptExceptionMessage"] as? String ?? error.localizedDescription
                print("[bridge] call failed \(body.prefix { $0 != "(" }): \(detail)")
            }
            guard let self, self.pageGeneration == generation else { return }
            completion?()
        }
    }

    func stopStreaming() {
        streaming = false
        recentFrames.removeAll()
        renderedTimestamp = nil
        framesInFlight = 0
    }

    func resetPageState() {
        pageGeneration += 1
        stopStreaming()
        frames.removeAll()
        activeFrameKey = nil
        pageReady = false
        pageAnchors.values.forEach(session.remove(anchor:))
        pageAnchors.removeAll()
        removedAnchorIDs.removeAll()
        state?.xrSessionEnded()
    }

    /// Ends the page's XR session from the native side (failure, interruption).
    func endSessionFromNative(reason: String) {
        guard streaming else { return }
        stopStreaming()
        call("onSessionEnded(reason)", ["reason": reason])
    }
}

// MARK: - JS -> native

extension ARBridge: WKScriptMessageHandlerWithReply {
    func userContentController(_ userContentController: WKUserContentController,
                               didReceive message: WKScriptMessage,
                               replyHandler: @escaping @MainActor @Sendable (Any?, String?) -> Void) {
        // Cross-origin iframes (ads, embeds) share the page world but must not drive the camera.
        guard accepts(message.frameInfo) else {
            print("[bridge] rejected message from \(BridgeOrigin(message.frameInfo.securityOrigin)) (main \(mainOrigin?.description ?? "none"))")
            replyHandler(nil, "holoweb bridge is available to the main frame only")
            return
        }
        guard let body = message.body as? [String: Any], let type = body["type"] as? String else {
            replyHandler(nil, "message must be an object with a string 'type'")
            return
        }
        switch type {
        case "ready":
            let key = Self.frameKey(body, message.frameInfo)
            let handle = body["bridge"] as? WKJSHandle
            frames[key] = BridgeFrame(handle: handle, info: message.frameInfo)
            if activeFrameKey == nil || frames[activeFrameKey!] == nil { activeFrameKey = key }
            pageReady = true
            print("[bridge] ready \(key)\(message.frameInfo.isMainFrame ? "" : " (iframe)"), transport: \(handle != nil ? "WKJSHandle" : "window.__holoweb")")
            replyHandler(["ok": true, "device": DeviceInfo.current.dictionary,
                          "mode": state?.mode.rawValue ?? "mono",
                          "transport": handle != nil ? "jshandle" : "global"], nil)
        case "requestSession":
            guard let state else { return replyHandler(nil, "app state unavailable") }
            let key = Self.frameKey(body, message.frameInfo)
            if frames[key] != nil { activeFrameKey = key }
            let features = body["features"] as? [String] ?? []
            print("[bridge] requestSession features=\(features.joined(separator: ","))")
            state.xrSessionStarted(features: Set(features))
            streaming = true
            planesDirty = true
            anchorsDirty = true
            environmentDirty = true
            environmentRequested = features.contains("light-estimation")
            handsRequested = features.contains("hand-tracking")
            handStats = HandStats()
            meshesRequested = features.contains("mesh-detection")
            if meshesRequested { meshStreamer.markAllDirty() }
            visibility = "visible"
            replyHandler(["ok": true, "mode": state.mode.rawValue, "frameRate": 60], nil)
        case "endSession":
            stopStreaming()
            state?.xrSessionEnded()
            replyHandler(["ok": true], nil)
        case "hitTest":
            replyHandler(["hits": hitTest(body)], nil)
        case "setMode":
            guard let raw = body["mode"] as? String, let mode = RenderMode(rawValue: raw) else {
                return replyHandler(nil, "mode must be 'mono' or 'stereo'")
            }
            state?.setMode(mode)
            replyHandler(["ok": true], nil)
        case "createAnchor":
            guard let pose = Self.finite(body["pose"], count: 16) else {
                return replyHandler(nil, "pose must be 16 finite numbers")
            }
            let anchor = ARAnchor(name: "holoweb", transform: simd_float4x4(columnMajor: pose))
            session.add(anchor: anchor)
            pageAnchors[anchor.identifier.uuidString] = anchor
            anchorsDirty = true
            replyHandler(["id": anchor.identifier.uuidString], nil)
        case "deleteAnchor":
            if let id = body["id"] as? String, let anchor = pageAnchors.removeValue(forKey: id) {
                session.remove(anchor: anchor)
            }
            replyHandler(["ok": true], nil)
        case "rendered":
            renderedTimestamp = body["t"] as? Double
            replyHandler(nil, nil)
        case "log":
            print("[web:\(body["level"] as? String ?? "log")] \(body["message"] as? String ?? "")")
            replyHandler(["ok": true], nil)
        default:
            replyHandler(nil, "unknown message type '\(type)'")
        }
    }

    private func hitTest(_ body: [String: Any]) -> [[String: Any]] {
        guard let o = Self.finite(body["origin"], count: 3), let d = Self.finite(body["direction"], count: 3) else { return [] }
        let origin = simd_float3(Float(o[0]), Float(o[1]), Float(o[2]))
        let direction = simd_float3(Float(d[0]), Float(d[1]), Float(d[2]))
        guard simd_length(direction) > 1e-6 else { return [] }
        // Prefer detected plane geometry; fall back to ARKit's estimate.
        for (target, type) in [(ARRaycastQuery.Target.existingPlaneGeometry, "plane"), (.estimatedPlane, "estimated")] {
            let query = ARRaycastQuery(origin: origin, direction: simd_normalize(direction), allowing: target, alignment: .any)
            let results = session.raycast(query)
            if !results.isEmpty {
                return results.map { ["pose": $0.worldTransform.columnMajor, "type": type] }
            }
        }
        return []
    }

    /// `count` finite numbers, or nil (structured clone lets NaN and Infinity through).
    private static func finite(_ value: Any?, count: Int) -> [Double]? {
        guard let values = value as? [Double], values.count == count, values.allSatisfy(\.isFinite) else { return nil }
        return values
    }
}

// MARK: - Navigation

extension ARBridge: WKNavigationDelegate {
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 preferences: WKWebpagePreferences) async -> (WKNavigationActionPolicy, WKWebpagePreferences) {
        preferences.allowsJSHandleCreationInPageWorld = true
        // Inside the app, gallery links (holoweb.app/launch?url=… or /c?url=…) open the
        // experience directly instead of showing the App Clip landing page.
        if navigationAction.targetFrame?.isMainFrame ?? true,
           let url = navigationAction.request.url, let target = HoloWebLink.inAppTarget(from: url) {
            state?.load(target)
            return (.cancel, preferences)
        }
        return (.allow, preferences)
    }

    /// Reset on commit, not on provisional start: a navigation that fails before committing
    /// leaves the old page (and its bridge) in place.
    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        resetPageState()
        mainOrigin = BridgeOrigin(webView.url)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        #if DEBUG
        state?.runTestClick()
        #endif
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: any Error) {
        print("[bridge] navigation failed: \(error.localizedDescription)")
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: any Error) {
        print("[bridge] provisional navigation failed: \(error.localizedDescription)")
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        print("[bridge] web content process terminated, reloading")
        resetPageState()
        webView.reload()
    }
}

/// Forwards script messages to a weakly held handler (WKUserContentController retains strongly).
final class WeakReplyHandler: NSObject, WKScriptMessageHandlerWithReply {
    private weak var target: (any WKScriptMessageHandlerWithReply)?

    init(_ target: any WKScriptMessageHandlerWithReply) { self.target = target }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping @MainActor @Sendable (Any?, String?) -> Void) {
        guard let target else { return replyHandler(nil, "bridge is gone") }
        target.userContentController(controller, didReceive: message, replyHandler: replyHandler)
    }
}

final class WeakMessageHandler: NSObject, WKScriptMessageHandler {
    private weak var target: (any WKScriptMessageHandler)?

    init(_ target: any WKScriptMessageHandler) { self.target = target }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(controller, didReceive: message)
    }
}
