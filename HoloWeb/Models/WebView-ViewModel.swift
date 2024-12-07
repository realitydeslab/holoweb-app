//
//  ContentView-ViewModel.swift
//  HoloWeb
//
//  Created by Alex on 04/12/2024.
//

import Observation
import SwiftUI
import WebKit


extension WebView {
    @Observable class ViewModel {
        var homePage: String = "https://toji.github.io/webxr-particles/"
        var urlString: String = "https://immersive-web.github.io/webxr-samples/"
        var isFullScreen = false
        
        var canGoBack = false
        var canGoForward = false
        
        var webView: WKWebView!
    }
}
