// SPDX-FileCopyrightText: Copyright 2024 Reality Design Lab <dev@reality.design>
// SPDX-FileContributor: Yuchen Zhang <yuchen@reality.design>
// SPDX-License-Identifier: MIT

import SwiftUI

/// Screen states (see `ViewerPhase`):
/// - browsing: the website on an opaque system background; only reload is offered.
/// - arMono: after the page's "Start AR", the camera shows through the transparent page.
/// - arStereo: via the top-right toggle; black background for HoloKit's optical see-through.
struct ContentView: View {
    @Environment(HoloWebState.self) private var state

    var body: some View {
        ZStack {
            background
            WebViewRepresentable()
            controls
        }
        .ignoresSafeArea()
        .statusBarHidden(state.phase != .browsing)
        .onDisappear { state.xrSessionEnded() }
    }

    @ViewBuilder private var background: some View {
        switch state.phase {
        case .browsing:
            Color(.systemBackground)
        case .arMono, .arStereo:
            // The renderer draws the camera in mono and leaves the screen black in stereo.
            Color.black
            MetalViewRepresentable()
        }
    }

    private var controls: some View {
        VStack {
            HStack(spacing: 18) {
                Spacer()
                if state.phase != .browsing {
                    Button {
                        state.setMode(state.mode == .mono ? .stereo : .mono)
                    } label: {
                        Label(state.mode == .mono ? "Stereo" : "Mono",
                              systemImage: state.mode == .mono ? "vision.pro" : "iphone")
                    }
                    .accessibilityHint("Switch between handheld AR and HoloKit stereo")
                    Button {
                        state.exitXR()
                    } label: {
                        Label("Exit AR", systemImage: "xmark")
                    }
                }
                Button {
                    state.goHome()
                } label: {
                    Label("Gallery", systemImage: "square.grid.2x2")
                }
                Button {
                    state.reload()
                } label: {
                    Label("Reload", systemImage: "arrow.clockwise")
                }
            }
            .labelStyle(.iconOnly)
            .font(.title3)
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
            .background(.ultraThinMaterial, in: Capsule())
            .padding(.top, 12)
            .padding(.horizontal, 16)
            Spacer()
        }
    }
}

#Preview {
    @Previewable @State var state = HoloWebState()
    ContentView()
        .environment(state)
}
