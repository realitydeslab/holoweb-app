// SPDX-FileCopyrightText: Copyright 2024 Reality Design Lab <dev@reality.design>
// SPDX-License-Identifier: MIT

import ARKit
import Observation
import SwiftUI
import WebKit

/// How the web content is presented on the phone screen.
enum RenderMode: String {
    /// Handheld AR: one view, camera image drawn behind the web page.
    case mono
    /// HoloKit stereoscopic AR: two views, black background (optical see-through).
    case stereo
}

/// Single source of truth shared by the app and the App Clip.
///
/// Owns the `WKWebView` (so its configuration is built exactly once), the
/// `ARSession`, and the current render mode. The WebXR bridge (M3) hangs off
/// this object.
@Observable
@MainActor
final class HoloWebState: NSObject {
    private(set) var url: URL?
    var mode: RenderMode = .mono
    private(set) var isARRunning = false

    let session = ARSession()
    let webView: WKWebView

    private nonisolated static let logHandlerName = "holowebLog"

    override init() {
        let configuration = WKWebViewConfiguration()
        configuration.allowsInlineMediaPlayback = true
        configuration.allowsPictureInPictureMediaPlayback = false
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true

        // Forward console output to Xcode so page-side failures are visible.
        let consoleForwarder = WKUserScript(
            source: Self.consoleForwarderSource,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        )
        configuration.userContentController.addUserScript(consoleForwarder)

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.scrollView.backgroundColor = .clear
        webView.scrollView.isScrollEnabled = false
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.isInspectable = true
        self.webView = webView

        super.init()
        configuration.userContentController.add(self, name: Self.logHandlerName)
    }

    func load(_ url: URL) {
        self.url = url
        webView.load(URLRequest(url: url))
    }

    func reload() {
        webView.reload()
    }

    func startARSession() {
        guard !isARRunning else { return }
        let configuration = ARWorldTrackingConfiguration()
        configuration.planeDetection = [.horizontal, .vertical]
        configuration.environmentTexturing = .automatic
        session.run(configuration)
        isARRunning = true
    }

    func pauseARSession() {
        guard isARRunning else { return }
        session.pause()
        isARRunning = false
    }

    private static let consoleForwarderSource = """
    (() => {
      const post = (level, args) => {
        try {
          window.webkit.messageHandlers.\(logHandlerName).postMessage(
            level + ": " + Array.from(args).map(a => {
              try { return typeof a === "string" ? a : JSON.stringify(a); } catch { return String(a); }
            }).join(" "));
        } catch (_) {}
      };
      for (const level of ["log", "info", "warn", "error"]) {
        const original = console[level].bind(console);
        console[level] = (...args) => { original(...args); post(level, args); };
      }
      window.addEventListener("error", e => post("uncaught", [e.message, e.filename + ":" + e.lineno]));
      window.addEventListener("unhandledrejection", e => post("unhandledrejection", [String(e.reason)]));
    })();
    """
}

extension HoloWebState: WKScriptMessageHandler {
    nonisolated func userContentController(_ userContentController: WKUserContentController,
                                           didReceive message: WKScriptMessage) {
        guard message.name == Self.logHandlerName, let text = message.body as? String else { return }
        print("[web] \(text)")
    }
}
