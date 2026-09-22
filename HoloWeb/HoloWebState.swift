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
    private(set) var bridge: ARBridge?

    private nonisolated static let logHandlerName = "holowebLog"

    override init() {
        let configuration = WKWebViewConfiguration()
        configuration.allowsInlineMediaPlayback = true
        configuration.allowsPictureInPictureMediaPlayback = false
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true
        configuration.defaultWebpagePreferences.allowsJSHandleCreationInPageWorld = true

        // Forward console output to Xcode so page-side failures are visible.
        let consoleForwarder = WKUserScript(
            source: Self.consoleForwarderSource,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        )
        configuration.userContentController.addUserScript(consoleForwarder)

        // The WebXR polyfill must run before any page script so navigator.xr exists on first use.
        if ProcessInfo.processInfo.environment["HOLOWEB_NO_POLYFILL"] == nil,
           let polyfillURL = Bundle.main.url(forResource: "holoweb-polyfill", withExtension: "js", subdirectory: "Web"),
           let polyfill = try? String(contentsOf: polyfillURL, encoding: .utf8) {
            configuration.userContentController.addUserScript(
                WKUserScript(source: polyfill, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        }

        configuration.setURLSchemeHandler(BundledPageSchemeHandler(), forURLScheme: BundledPageSchemeHandler.scheme)

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.scrollView.backgroundColor = .clear
        webView.scrollView.isScrollEnabled = false
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        #if DEBUG
        webView.isInspectable = true
        #endif
        self.webView = webView

        super.init()
        configuration.userContentController.add(WeakMessageHandler(self), name: Self.logHandlerName)
        bridge = ARBridge(state: self, session: session, webView: webView)
    }

    /// Switches mono/stereo. Stereo locks landscape with the home side on the right,
    /// which is how the phone sits in HoloKit X (Unity's LandscapeLeft).
    func setMode(_ newMode: RenderMode) {
        mode = newMode
        guard let scene = webView.window?.windowScene else { return }
        let mask: UIInterfaceOrientationMask = newMode == .stereo ? .landscapeRight : .allButUpsideDown
        scene.requestGeometryUpdate(.iOS(interfaceOrientations: mask)) { error in
            print("[state] orientation request failed: \(error.localizedDescription)")
        }
    }

    func load(_ url: URL) {
        self.url = url
        webView.load(URLRequest(url: url))
    }

    /// Resolves a page bundled under `Web/`, e.g. `webgpu-check.html` or
    /// `examples/three-ar.html?autostart`. A query string is kept.
    static func bundledPage(_ path: String) -> URL? {
        let file = String(path.split(separator: "?", maxSplits: 1)[0])
        guard let web = Bundle.main.resourceURL?.appending(path: "Web"),
              FileManager.default.fileExists(atPath: web.appending(path: file).path) else { return nil }
        return BundledPageSchemeHandler.url(forBundledPath: path)
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

    /// Called when ARKit reports a fatal error, so the next requestSession runs it again.
    func markARStopped() {
        isARRunning = false
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
