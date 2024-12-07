// SPDX-FileCopyrightText: Copyright 2024 Reality Design Lab <dev@reality.design>
// SPDX-FileContributor: Yuchen Zhang <yuchen@reality.design>
// SPDX-License-Identifier: MIT

import SwiftUI


struct ContentView: View {
    @State private var webView = WebView.shared

    var body: some View {
        
        VStack() {
            webView
                .edgesIgnoringSafeArea(webView.viewModel.isFullScreen ? .all : .horizontal)
            
            if !webView.viewModel.isFullScreen {
                HStack {
                    Button(action: {
                        // TODO: Show info
                    }) {
                        Image(systemName: "info.circle")
                    }

                    TextField("Enter address", text: $webView.viewModel.urlString)
                        .textFieldStyle(RoundedBorderTextFieldStyle())

                    Button(action: {
                        webView.load()
                    }) {
                        Image(systemName: "arrow.clockwise")
                    }
                }
                .padding([.leading, .trailing])
                .padding(.top, 8)
                
                HStack(spacing: 50) {
                    Button(action: {
                        webView.goBack()
                    }) {
                        Image(systemName: "chevron.left")
                    }
                    .disabled(!webView.viewModel.canGoBack)
                    
                    Button(action: {
                        webView.goForward()
                    }) {
                        Image(systemName: "chevron.right")
                    }
                    .disabled(!webView.viewModel.canGoForward)

                    Button(action: {
                        // TODO: Share action
                    }) {
                        Image(systemName: "square.and.arrow.up")
                    }
                    
                    Button(action: {
                        webView.goHome()
                    }) {
                        Image(systemName: "house")
                    }
                    
                    Button(action: {
                        // TODO: Screen list action
                    }) {
                        Image(systemName: "square.grid.2x2")
                    }
                }
                .padding()
            }
        } /* VStack */
        
        
    } /* body */
} /* ContentView */

#Preview {
    ContentView()
}
