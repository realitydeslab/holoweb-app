// SPDX-FileCopyrightText: Copyright 2026 Reality Design Lab <dev@reality.design>
// SPDX-License-Identifier: MIT

import ARKit
import UIKit
import WebKit

/// Native side of the HoloWeb bridge (see plan/bridge_protocol.md).
///
/// JS -> native: one `holoweb` message handler with replies.
/// native -> JS: `callAsyncJavaScript` on the page's bridge object, addressed through the
/// `WKJSHandle` the polyfill hands over in its `ready` message (iOS 27). If the page could not
/// create a handle, calls go to `window.__holoweb` instead.
@MainActor
final class ARBridge: NSObject {
    static let handlerName = "holoweb"

    private weak var state: HoloWebState?
    private let session: ARSession
    private let webView: WKWebView

    private var bridgeHandle: WKJSHandle?
    private var pageReady = false
    private var streaming = false
    /// Calls not yet acknowledged by JS. One round trip takes ~17-20 ms on iPhone 15 Pro, so
    /// allowing two keeps 60 Hz while still bounding the queue if the page stalls.
    private var framesInFlight = 0
    private static let maxFramesInFlight = 2
    private var planesDirty = false
    private var lastPlanesSent: TimeInterval = 0
    private(set) var framesPushed = 0
    private(set) var framesSkipped = 0
    /// Recently pushed frames, newest last. Kept small: ARKit's capture buffer pool is shallow and
    /// holding too many ARFrames stalls tracking.
    private var recentFrames: [ARFrame] = []
    private static let recentFrameLimit = 3
    /// ARFrame timestamp (ms) the page reported as rendered most recently.
    private var renderedTimestamp: Double?

    private var arFrames = 0
    private var lastStatsTime: TimeInterval = 0

    init(state: HoloWebState, session: ARSession, webView: WKWebView) {
        self.state = state
        self.session = session
        self.webView = webView
        super.init()
        let controller = webView.configuration.userContentController
        controller.addScriptMessageHandler(self, contentWorld: .page, name: Self.handlerName)
        webView.navigationDelegate = self
        session.delegate = self
    }

    /// JS function body used for every native -> JS call. `bridge` is the WKJSHandle argument.
    private var target: String {
        bridgeHandle != nil ? "bridge" : "window.__holoweb"
    }

    private var callArgumentsBase: [String: Any] {
        guard let bridgeHandle else { return [:] }
        return ["bridge": bridgeHandle]
    }

    private func call(_ body: String, _ arguments: [String: Any], completion: (@MainActor () -> Void)? = nil) {
        var args = callArgumentsBase
        args.merge(arguments) { _, new in new }
        let guarded = "if (\(target)) { return \(target).\(body); }"
        webView.callAsyncJavaScript(guarded, arguments: args, in: nil, in: .page) { result in
            if case .failure(let error) = result {
                print("[bridge] call failed: \(error.localizedDescription)")
            }
            completion?()
        }
    }

    private func resetPageState() {
        bridgeHandle = nil
        recentFrames.removeAll()
        renderedTimestamp = nil
        pageReady = false
        streaming = false
        framesInFlight = 0
    }
}

// MARK: - Camera/content sync

extension ARBridge {
    /// The frame whose camera image the renderer should draw: the one matching the page's last
    /// rendered pose when the page reports it, otherwise nil (renderer uses the newest frame).
    var displayFrame: ARFrame? {
        guard streaming, let t = renderedTimestamp else { return nil }
        return recentFrames.last { $0.timestamp * 1000 <= t + 0.5 } ?? recentFrames.first
    }
}

// MARK: - JS -> native

extension ARBridge: WKScriptMessageHandlerWithReply {
    func userContentController(_ userContentController: WKUserContentController,
                               didReceive message: WKScriptMessage,
                               replyHandler: @escaping @MainActor @Sendable (Any?, String?) -> Void) {
        guard let body = message.body as? [String: Any], let type = body["type"] as? String else {
            replyHandler(nil, "message must be an object with a string 'type'")
            return
        }
        switch type {
        case "ready":
            bridgeHandle = body["bridge"] as? WKJSHandle
            pageReady = true
            print("[bridge] ready, transport: \(bridgeHandle != nil ? "WKJSHandle" : "window.__holoweb")")
            replyHandler(["ok": true, "device": DeviceInfo.current.dictionary,
                          "mode": state?.mode.rawValue ?? "mono",
                          "transport": bridgeHandle != nil ? "jshandle" : "global"], nil)
        case "requestSession":
            state?.startARSession()
            streaming = true
            planesDirty = true
            replyHandler(["ok": true, "mode": state?.mode.rawValue ?? "mono", "frameRate": 60], nil)
        case "endSession":
            streaming = false
            replyHandler(["ok": true], nil)
        case "hitTest":
            replyHandler(["hits": hitTest(body)], nil)
        case "setMode":
            guard let raw = body["mode"] as? String, let mode = RenderMode(rawValue: raw) else {
                replyHandler(nil, "mode must be 'mono' or 'stereo'")
                return
            }
            state?.setMode(mode)
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
        guard let origin = (body["origin"] as? [Double]).flatMap(Self.vector3),
              let direction = (body["direction"] as? [Double]).flatMap(Self.vector3) else { return [] }
        let query = ARRaycastQuery(origin: origin, direction: simd_normalize(direction),
                                   allowing: .estimatedPlane, alignment: .any)
        return session.raycast(query).map { result in
            let onPlane = result.target == .existingPlaneGeometry || result.target == .existingPlaneInfinite
            return ["pose": result.worldTransform.columnMajor, "type": onPlane ? "plane" : "estimated"]
        }
    }

    private static func vector3(_ values: [Double]) -> simd_float3? {
        values.count == 3 ? simd_float3(Float(values[0]), Float(values[1]), Float(values[2])) : nil
    }
}

// MARK: - native -> JS frames

extension ARBridge: ARSessionDelegate {
    nonisolated func session(_ session: ARSession, didUpdate frame: ARFrame) {
        // ARSession.delegateQueue is nil, so callbacks arrive on the main queue.
        nonisolated(unsafe) let frame = frame
        MainActor.assumeIsolated { self.push(frame) }
    }

    nonisolated func session(_ session: ARSession, didAdd anchors: [ARAnchor]) {
        MainActor.assumeIsolated { self.planesDirty = true }
    }

    nonisolated func session(_ session: ARSession, didUpdate anchors: [ARAnchor]) {
        MainActor.assumeIsolated { self.planesDirty = true }
    }

    nonisolated func session(_ session: ARSession, didRemove anchors: [ARAnchor]) {
        MainActor.assumeIsolated { self.planesDirty = true }
    }

    private func push(_ frame: ARFrame) {
        guard pageReady, streaming, let state else { return }
        logStats(frame)
        if framesInFlight >= Self.maxFramesInFlight {
            framesSkipped += 1
            return
        }
        let orientation = webView.window?.windowScene?.effectiveGeometry.interfaceOrientation ?? .portrait
        let size = webView.bounds.size
        guard size.width > 0, size.height > 0 else { return }
        let camera = frame.camera
        let view = camera.viewMatrix(for: orientation)
        let proj = camera.projectionMatrix(for: orientation, viewportSize: size, zNear: 0.01, zFar: 1000)
        var light: Any = NSNull()
        if let estimate = frame.lightEstimate {
            light = ["ambientIntensity": Double(estimate.ambientIntensity),
                     "ambientColorTemperature": Double(estimate.ambientColorTemperature)]
        }
        framesInFlight += 1
        recentFrames.append(frame)
        if recentFrames.count > Self.recentFrameLimit { recentFrames.removeFirst() }
        framesPushed += 1
        call("onFrame(t, mode, transform, view, proj, light, tracking, orientation, sentAt)", [
            "t": frame.timestamp * 1000,
            "mode": state.mode.rawValue,
            "transform": view.inverse.columnMajor,
            "view": view.columnMajor,
            "proj": proj.columnMajor,
            "light": light,
            "tracking": camera.trackingState.bridgeName,
            "orientation": orientation.bridgeName,
            "sentAt": Date().timeIntervalSince1970 * 1000,
        ]) { [weak self] in
            guard let self else { return }
            self.framesInFlight = max(0, self.framesInFlight - 1)
        }
        pushPlanesIfNeeded(frame, now: frame.timestamp)
    }

    private func logStats(_ frame: ARFrame) {
        arFrames += 1
        if lastStatsTime == 0 { lastStatsTime = frame.timestamp }
        let elapsed = frame.timestamp - lastStatsTime
        guard elapsed >= 2 else { return }
        let fps = session.configuration?.videoFormat.framesPerSecond ?? 0
        print(String(format: "[bridge] ARKit %.1f fps (format %d), pushed %d, skipped %d",
                     Double(arFrames) / elapsed, fps, framesPushed, framesSkipped))
        arFrames = 0
        lastStatsTime = frame.timestamp
    }

    private func pushPlanesIfNeeded(_ frame: ARFrame, now: TimeInterval) {
        guard planesDirty, now - lastPlanesSent >= 0.1 else { return }
        planesDirty = false
        lastPlanesSent = now
        let planes: [[String: Any]] = frame.anchors.compactMap { $0 as? ARPlaneAnchor }.map { plane in
            let extent = plane.planeExtent
            let local = simd_float4x4(translation: plane.center) * simd_float4x4(yRotation: extent.rotationOnYAxis)
            return ["id": plane.identifier.uuidString,
                    "transform": (plane.transform * local).columnMajor,
                    "extent": [Double(extent.width), Double(extent.height)],
                    "orientation": plane.alignment == .horizontal ? "horizontal" : "vertical"]
        }
        call("onPlanes(planes)", ["planes": planes])
    }
}

// MARK: - Navigation

extension ARBridge: WKNavigationDelegate {
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 preferences: WKWebpagePreferences) async -> (WKNavigationActionPolicy, WKWebpagePreferences) {
        preferences.allowsJSHandleCreationInPageWorld = true
        return (.allow, preferences)
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        resetPageState()
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
