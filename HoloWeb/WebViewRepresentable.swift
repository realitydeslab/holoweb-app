// SPDX-FileCopyrightText: Copyright 2024 Reality Design Lab <dev@reality.design>
// SPDX-License-Identifier: MIT

import SwiftUI
import WebKit

/// Hosts the single `WKWebView` owned by `HoloWebState`.
struct WebViewRepresentable: UIViewRepresentable {
    @Environment(HoloWebState.self) private var state

    func makeUIView(context: Context) -> WKWebView {
        state.webView
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}
}
