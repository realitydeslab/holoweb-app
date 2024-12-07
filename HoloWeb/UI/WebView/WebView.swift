// SPDX-FileCopyrightText: Copyright 2024 Reality Design Lab <dev@reality.design>
// SPDX-FileContributor: Yuchen Zhang <yuchen@reality.design>
// SPDX-License-Identifier: MIT

import SwiftUI
import WebKit

struct WebView: UIViewRepresentable {
    typealias UIViewType = WKWebView
    var viewModel = ViewModel()

    static let shared = WebView()
    private init() {}

    func makeUIView(context: Context) -> UIViewType {
        
        let webPrefs = WKWebpagePreferences()
        webPrefs.allowsContentJavaScript = true
        
        let webConfiguration = WKWebViewConfiguration()
        webConfiguration.defaultWebpagePreferences = webPrefs
        webConfiguration.allowsInlineMediaPlayback = true
        webConfiguration.mediaTypesRequiringUserActionForPlayback = []
        
        // Inject webxr-polyfill.js
//        if let path = Bundle.main.path(forResource: "webxr-polyfill", ofType: "js"),
//           let webxrPolyfillScript = try? String(contentsOfFile: path) {
//            let userScript = WKUserScript(source: webxrPolyfillScript, injectionTime: .atDocumentStart, forMainFrameOnly: true)
//            webConfiguration.userContentController.addUserScript(userScript)
//        }

        
        if let path = Bundle.main.path(forResource: "webxr2.0", ofType: "js"),
           let webxrPolyfillScript = try? String(contentsOfFile: path, encoding: .utf8) {
            let userScript = WKUserScript(source: webxrPolyfillScript, injectionTime: .atDocumentStart, forMainFrameOnly: true)
            webConfiguration.userContentController.addUserScript(userScript)
        }
        
        // Inject holokit-ar.js
        if let path = Bundle.main.path(forResource: "holokit-ar", ofType: "js"),
           let holokitArScript = try? String(contentsOfFile: path, encoding: .utf8) {
            let userScript = WKUserScript(source: holokitArScript, injectionTime: .atDocumentStart, forMainFrameOnly: true)
            webConfiguration.userContentController.addUserScript(userScript)
        }
        
        webConfiguration.userContentController.add(Coordinator(self), name: "logHandler")
        
        let webView = WKWebView(frame: .zero, configuration: webConfiguration)
        webView.allowsBackForwardNavigationGestures = true
        webView.isMultipleTouchEnabled = true
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.scrollView.isScrollEnabled = true
        webView.navigationDelegate = context.coordinator
        viewModel.webView = webView
        load()
        return webView
    }
    
    func updateUIView(_ uiView: UIViewType, context: Context) {
    }
    
    func makeCoordinator() -> Coordinator {
        Coordinator(self)
    }

    class Coordinator: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
        var parent: WebView
        
        init(_ parent: WebView) {
            self.parent = parent
        }
        
        func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation) {
            parent.viewModel.urlString = webView.url?.absoluteString ?? ""
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            parent.viewModel.canGoBack = webView.canGoBack
            parent.viewModel.canGoForward = webView.canGoForward
        }

        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            if message.name == "logHandler", let logMessage = message.body as? String {
                print(logMessage)
            }
        }
    }
    
    func load() {
        guard let url = URL(string: viewModel.urlString) else {
            return
        }
        viewModel.webView.load(URLRequest(url: url))
    }
        
    func goBack() {
        viewModel.webView.goBack()
    }

    func goForward() {
        viewModel.webView.goForward()
    }
    
    func goHome() {
        viewModel.urlString = viewModel.homePage
        load()
    }
    
}
