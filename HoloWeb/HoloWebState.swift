// SPDX-FileCopyrightText: Copyright 2024 Reality Design Lab <dev@reality.design>
// SPDX-License-Identifier: MIT

import ARKit
import Observation
import SwiftUI
import WebKit

/// What the screen is doing. Browsing is an ordinary web page; the other states exist only
/// while the page holds an immersive session.
enum ViewerPhase: Equatable {
    /// Normal website on an opaque background, camera off.
    case browsing
    /// "Start AR": page turns transparent over the camera image.
    case arMono
    /// HoloKit stereo via the top-right toggle: black background, two eye views, landscape lock.
    case arStereo
    /// immersive-vr: ARKit still tracks 6DoF, but the camera image is never drawn (black).
    case vrMono
    /// immersive-vr in HoloKit stereo.
    case vrStereo

    /// The camera image is drawn behind the page.
    var blendsCamera: Bool { self == .arMono }
    var isImmersive: Bool { self != .browsing }
    var isVR: Bool { self == .vrMono || self == .vrStereo }
}

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
    private(set) var mode: RenderMode = .mono
    private(set) var isARRunning = false
    /// True while the page holds an immersive session (between requestSession and its end).
    private(set) var isInXRSession = false
    /// The current session is immersive-vr (opaque) rather than immersive-ar.
    private(set) var isVRSession = false

    var phase: ViewerPhase {
        guard isInXRSession else { return .browsing }
        if isVRSession { return mode == .stereo ? .vrStereo : .vrMono }
        return mode == .stereo ? .arStereo : .arMono
    }

    let session = ARSession()
    let webView: WKWebView
    private(set) var bridge: ARBridge?
    @ObservationIgnored private var testClickTask: Task<Void, Never>?
    @ObservationIgnored private var debugCycles = 0

    private nonisolated static let logHandlerName = "holowebLog"

    override init() {
        let configuration = WKWebViewConfiguration()
        configuration.allowsInlineMediaPlayback = true
        configuration.allowsPictureInPictureMediaPlayback = false
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true
        configuration.defaultWebpagePreferences.allowsJSHandleCreationInPageWorld = true

        // Forward console output to Xcode so page-side failures are visible. All frames, but only
        // the main frame and same-origin iframes (where the app may live) are printed.
        let consoleForwarder = WKUserScript(
            source: Self.consoleForwarderSource,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: false
        )
        configuration.userContentController.addUserScript(consoleForwarder)

        // The WebXR polyfill must run before any page script so navigator.xr exists on first use.
        // All frames: some hosts (playcanv.as) run the app in a same-origin iframe; the bridge
        // refuses cross-origin ones.
        if ProcessInfo.processInfo.environment["HOLOWEB_NO_POLYFILL"] == nil,
           let polyfillURL = Bundle.main.url(forResource: "holoweb-polyfill", withExtension: "js", subdirectory: "Web"),
           let polyfill = try? String(contentsOf: polyfillURL, encoding: .utf8) {
            configuration.userContentController.addUserScript(
                WKUserScript(source: polyfill, injectionTime: .atDocumentStart, forMainFrameOnly: false))
        }

        configuration.setURLSchemeHandler(BundledPageSchemeHandler(), forURLScheme: BundledPageSchemeHandler.scheme)

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.scrollView.backgroundColor = .clear
        // Browsing scrolls like a normal page; scrolling is turned off only while an XR session runs.
        webView.scrollView.isScrollEnabled = true
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        #if DEBUG
        webView.isInspectable = true
        #endif
        self.webView = webView

        super.init()
        configuration.userContentController.add(WeakMessageHandler(self), name: Self.logHandlerName)
        bridge = ARBridge(state: self, session: session, webView: webView)
    }

    /// Switches mono/stereo. Stereo locks the interface in its current orientation: the page's
    /// framebuffer was sized at session start and cannot follow a rotation, so the polyfill lays the
    /// HoloKit eyes out in physical landscape and turns them into that framebuffer (stereo.ts).
    func setMode(_ newMode: RenderMode) {
        mode = newMode
        print("[state] mode -> \(newMode.rawValue), phase -> \(phase)")
        guard let scene = webView.window?.windowScene else { return }
        let mask: UIInterfaceOrientationMask = newMode == .stereo
            ? Self.lockMask(for: scene.effectiveGeometry.interfaceOrientation) : .allButUpsideDown
        OrientationLock.mask = mask
        scene.keyWindow?.rootViewController?.setNeedsUpdateOfSupportedInterfaceOrientations()
        scene.requestGeometryUpdate(.iOS(interfaceOrientations: mask)) { error in
            print("[state] orientation request failed: \(error.localizedDescription)")
        }
    }

    private static func lockMask(for orientation: UIInterfaceOrientation) -> UIInterfaceOrientationMask {
        switch orientation {
        case .landscapeLeft: .landscapeLeft
        case .landscapeRight: .landscapeRight
        default: .portrait
        }
    }

    /// Page started an immersive session ("Start AR"/"Enter VR"). The mode stays whatever it is
    /// (mono unless a test page asked for stereo before starting).
    func xrSessionStarted(features: Set<String> = [], vr: Bool = false,
                          detectionImages: Set<ARReferenceImage> = []) {
        isInXRSession = true
        isVRSession = vr
        webView.scrollView.isScrollEnabled = false
        startARSession(features: features, detectionImages: detectionImages)
        print("[state] phase -> \(phase)")
        #if DEBUG
        startDebugToggle()
        startDebugCycle()
        #endif
    }

    /// The session ended (page exit, native exit button, navigation, or ARKit failure):
    /// back to browsing, camera off, mono, orientation unlocked.
    func xrSessionEnded() {
        isInXRSession = false
        isVRSession = false
        webView.scrollView.isScrollEnabled = true
        pauseARSession()
        if mode != .mono { setMode(.mono) }
        print("[state] phase -> \(phase)")
    }

    #if DEBUG
    /// Test aid: HOLOWEB_TEST_TOGGLE=<seconds> presses the mono/stereo button on that interval.
    private func startDebugToggle() {
        guard let raw = ProcessInfo.processInfo.environment["HOLOWEB_TEST_TOGGLE"],
              let seconds = Double(raw), seconds > 0 else { return }
        Task { @MainActor [weak self] in
            while let self, self.isInXRSession {
                try? await Task.sleep(for: .seconds(seconds))
                guard self.isInXRSession else { return }
                self.setMode(self.mode == .mono ? .stereo : .mono)
            }
        }
    }

    /// Test aid: HOLOWEB_TEST_CYCLE=<seconds> exits the XR session after that long (tearing down the
    /// Metal view with frames possibly still on the GPU) and reloads, so an `?autostart` page
    /// re-enters AR: a stress loop for session teardown.
    private func startDebugCycle() {
        guard let raw = ProcessInfo.processInfo.environment["HOLOWEB_TEST_CYCLE"],
              let seconds = Double(raw), seconds > 0 else { return }
        Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(seconds))
            guard let self, self.isInXRSession else { return }
            self.debugCycles += 1
            print("[test] cycle \(self.debugCycles): exit XR + reload")
            self.exitXR()
            self.reload()
        }
    }

    /// Test aid: HOLOWEB_TEST_CLICK=<CSS selector | js:expression> clicks the first matching element
    /// 2.5 s after each main-frame load, retrying every 1 s for HOLOWEB_TEST_CLICK_WAIT seconds
    /// (default 6), e.g. "#ARButton". Disabled buttons count as not found, since a click on them is a
    /// silent no-op (SuperSplat keeps its AR button disabled until the splat has loaded).
    func runTestClick() {
        guard let selector = ProcessInfo.processInfo.environment["HOLOWEB_TEST_CLICK"], !selector.isEmpty else { return }
        testClickTask?.cancel()
        testClickTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(2.5))
            let attempts = max(1, Int(ProcessInfo.processInfo.environment["HOLOWEB_TEST_CLICK_WAIT"] ?? "") ?? 6)
            for attempt in 0..<attempts {
                guard !Task.isCancelled, let webView = self?.webView else { return }
                let clicked = try? await webView.callAsyncJavaScript(
                    Self.testClickSource,
                    arguments: ["selector": selector], in: nil, contentWorld: .page) as? Bool
                if clicked == true { return print("[test] clicked \(selector)") }
                if attempt == attempts - 1 { return print("[test] no element \(selector)") }
                try? await Task.sleep(for: .seconds(1))
            }
        }
    }

    /// Looks in the document, its open shadow roots and every same-origin iframe (recursively). A CSS selector clicks the
    /// first match; "js:<expression>" instead evaluates the expression in each frame's window until
    /// one returns truthy, for canvas-drawn buttons (e.g. PlayCanvas UI) that have no element.
    private static let testClickSource = """
    const windows = [];
    const collect = (win) => {
      windows.push(win);
      for (const frame of win.document.querySelectorAll("iframe")) {
        try { if (frame.contentDocument) collect(frame.contentWindow); } catch (_) {}
      }
    };
    collect(window);
    // Open shadow roots too (e.g. Needle's <needle-menu> buttons).
    const enabled = (el) => !el.disabled && el.getAttribute("aria-disabled") !== "true";
    const find = (root) => {
      const hit = [...root.querySelectorAll(selector)].find(enabled);
      if (hit) return hit;
      for (const el of root.querySelectorAll("*")) {
        if (el.shadowRoot) { const inner = find(el.shadowRoot); if (inner) return inner; }
      }
      return null;
    };
    for (const win of windows) {
      try {
        if (selector.startsWith("js:")) {
          if (new win.Function("return (" + selector.slice(3) + ");")()) return true;
          continue;
        }
        const el = find(win.document);
        if (el) { el.click(); return true; }
      } catch (_) {}
    }
    return false;
    """
    #endif

    /// Top-right exit button.
    func exitXR() {
        bridge?.endSessionFromNative(reason: "user")
        xrSessionEnded()
    }

    func load(_ url: URL) {
        print("[state] load \(url.absoluteString)")
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

    /// Gallery home page (web.holokit.io).
    static let homeURL = URL(string: "https://web.holokit.io/")!

    func goHome() {
        if isInXRSession { exitXR() }
        load(Self.homeURL)
    }

    func reload() {
        webView.reload()
    }

    /// Runs world tracking. Costly extras are enabled only for the WebXR features that need them:
    /// "hand-tracking" adds LiDAR depth (joint depth), "mesh-detection" adds scene reconstruction.
    /// `detectionImages` (image-tracking) re-runs an already running session with them, keeping
    /// its anchors (no reset options).
    func startARSession(features: Set<String> = [], detectionImages: Set<ARReferenceImage> = []) {
        guard !isARRunning || !detectionImages.isEmpty else { return }
        let configuration = ARWorldTrackingConfiguration()
        // Only what the page asked for: plane detection and environment probes cost CPU/GPU (heat).
        configuration.planeDetection = Self.planeDetection(for: features)
        configuration.environmentTexturing = features.contains("light-estimation") ? .automatic : .none
        #if DEBUG
        // A/B for heat measurements: the old always-on configuration.
        if ProcessInfo.processInfo.environment["HOLOWEB_ARKIT_ALL"] != nil {
            configuration.planeDetection = [.horizontal, .vertical]
            configuration.environmentTexturing = .automatic
        }
        #endif
        if features.contains("hand-tracking"), ARWorldTrackingConfiguration.supportsFrameSemantics(.smoothedSceneDepth) {
            configuration.frameSemantics.insert(.smoothedSceneDepth)
        }
        if features.contains("mesh-detection") {
            if ARWorldTrackingConfiguration.supportsSceneReconstruction(.meshWithClassification) {
                configuration.sceneReconstruction = .meshWithClassification
            } else if ARWorldTrackingConfiguration.supportsSceneReconstruction(.mesh) {
                configuration.sceneReconstruction = .mesh
            }
        }
        if !detectionImages.isEmpty {
            configuration.detectionImages = detectionImages
            configuration.maximumNumberOfTrackedImages = min(detectionImages.count, ImageTracker.maxTracked)
            configuration.automaticImageScaleEstimationEnabled = true
            print("[bridge] image tracking n=\(detectionImages.count)")
        }
        print("[state] ARKit run planeDetection=\(configuration.planeDetection.rawValue) frameSemantics=\(configuration.frameSemantics.rawValue) sceneReconstruction=\(configuration.sceneReconstruction.rawValue) environmentTexturing=\(configuration.environmentTexturing.rawValue)")
        session.run(configuration)
        isARRunning = true
    }

    /// Planes feed plane-detection, hit-test (native raycasts against existing planes and the
    /// polyfill's plane hit-test, walls included) and local-floor (lowest horizontal plane).
    nonisolated static func planeDetection(for features: Set<String>) -> ARWorldTrackingConfiguration.PlaneDetection {
        if features.contains("plane-detection") || features.contains("hit-test") { return [.horizontal, .vertical] }
        if features.contains("local-floor") { return .horizontal }
        return []
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
              if (typeof a === "string") return a;
              // Errors (and DOMExceptions) stringify to "{}"; keep name, message and first stack frame.
              if (a instanceof Error || a instanceof DOMException) return `${a.name}: ${a.message}` + (a.stack ? ` @ ${a.stack.split("\\n")[0]}` : "");
              try { return JSON.stringify(a); } catch { return String(a); }
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
        nonisolated(unsafe) let frame = message.frameInfo
        MainActor.assumeIsolated {
            guard frame.isMainFrame || bridge?.accepts(frame) == true else { return }
            print("[web] \(text)")
        }
    }
}

/// Interface orientations the app allows right now; stereo narrows it to the current orientation.
/// `requestGeometryUpdate` alone rotates once but does not stop later auto-rotation.
@MainActor
enum OrientationLock {
    static var mask: UIInterfaceOrientationMask = .allButUpsideDown
}

final class OrientationLockAppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication,
                     supportedInterfaceOrientationsFor window: UIWindow?) -> UIInterfaceOrientationMask {
        MainActor.assumeIsolated { OrientationLock.mask }
    }
}
