// SPDX-FileCopyrightText: Copyright 2026 Reality Design Lab <dev@reality.design>
// SPDX-License-Identifier: MIT

import UIKit
import WebKit

/// Scheme, host and port of a frame. Default ports are normalised to 0, which is how
/// `WKSecurityOrigin` reports them, so a URL-derived origin compares equal to a frame's.
struct BridgeOrigin: Equatable, CustomStringConvertible {
    let scheme: String
    let host: String
    let port: Int

    init(scheme: String, host: String, port: Int) {
        self.scheme = scheme.lowercased()
        self.host = host.lowercased()
        let defaultPort = ["http": 80, "https": 443][self.scheme]
        self.port = port == defaultPort ? 0 : port
    }

    init(_ origin: WKSecurityOrigin) {
        self.init(scheme: origin.protocol, host: origin.host, port: origin.port)
    }

    init?(_ url: URL?) {
        guard let url, let scheme = url.scheme else { return nil }
        self.init(scheme: scheme, host: url.host() ?? "", port: url.port ?? 0)
    }

    /// Opaque origins (data: URLs, sandboxed frames) report an empty scheme and never match.
    var isOpaque: Bool { scheme.isEmpty }

    var description: String { "\(scheme)://\(host)\(port == 0 ? "" : ":\(port)")" }
}

/// A frame that sent `ready`: its bridge handle (nil on the `window.__holoweb` fallback) and the
/// frame to address with `callAsyncJavaScript`.
struct BridgeFrame {
    let handle: WKJSHandle?
    let info: WKFrameInfo
}

extension ARBridge {
    /// Main frame, or a sub-frame with the main frame's origin (e.g. playcanv.as runs the app
    /// in a same-origin iframe). Cross-origin frames (ads, embeds) are refused.
    func accepts(_ frame: WKFrameInfo) -> Bool {
        if frame.isMainFrame { return true }
        let origin = BridgeOrigin(frame.securityOrigin)
        return !origin.isOpaque && origin == mainOrigin
    }

    /// Key for a frame's state: the polyfill's `frame` id, else "main" or "iframe".
    static func frameKey(_ body: [String: Any], _ frame: WKFrameInfo) -> String {
        if let id = body["frame"] as? String, !id.isEmpty { return id }
        return frame.isMainFrame ? "main" : "iframe"
    }

    var activeFrame: BridgeFrame? { activeFrameKey.flatMap { frames[$0] } }

    /// Handle calls are addressed to: the frame that requested the session, else the first ready one.
    var bridgeHandle: WKJSHandle? { activeFrame?.handle }
}

// MARK: - Visibility

extension ARBridge {
    /// App/scene activation drives `onVisibility` alongside ARSession interruptions.
    func observeSceneActivation() {
        let center = NotificationCenter.default
        for (name, state) in [(UIScene.willDeactivateNotification, "hidden"),
                              (UIScene.didEnterBackgroundNotification, "hidden"),
                              (UIScene.didActivateNotification, "visible")] {
            center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.setVisibility(state) }
            }
        }
    }

    /// Sends `onVisibility(state)` while streaming, once per change.
    func setVisibility(_ state: String) {
        guard streaming, state != visibility else { return }
        visibility = state
        print("[bridge] visibility \(state)")
        call("onVisibility(state)", ["state": state])
    }
}
