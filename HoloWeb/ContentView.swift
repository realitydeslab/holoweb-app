// SPDX-FileCopyrightText: Copyright 2024 Reality Design Lab <dev@reality.design>
// SPDX-FileContributor: Yuchen Zhang <yuchen@reality.design>
// SPDX-License-Identifier: MIT

import SwiftUI

/// Screen states (see `ViewerPhase`):
/// - browsing: the website on an opaque system background; only reload is offered.
/// - arMono: after the page's "Start AR", the camera shows through the transparent page.
/// - arStereo: via the top-right toggle; black background for HoloKit's optical see-through.
/// - vrMono / vrStereo: immersive-vr; always black, ARKit only provides tracking.
struct ContentView: View {
    @Environment(HoloWebState.self) private var state

    var body: some View {
        ZStack {
            background
            WebViewRepresentable()
        }
        .ignoresSafeArea()
        // Controls stay inside the safe area so they never sit under the status bar or the notch.
        .overlay(alignment: .bottomTrailing) {
            // Hug the physical edge in landscape too: the landscape safe-area inset (~59 pt) would push
            // the capsule into the right HoloKit eye (it ends ~53 pt from the edge on iPhone 15 Pro).
            controls.ignoresSafeArea(.container, edges: .horizontal)
        }
        .statusBarHidden(state.phase != .browsing)
        .onDisappear { state.xrSessionEnded() }
    }

    @ViewBuilder private var background: some View {
        switch state.phase {
        case .browsing:
            Color(.systemBackground)
        case .arMono, .arStereo, .vrMono, .vrStereo:
            // The renderer draws the camera in AR mono and leaves the screen black otherwise.
            Color.black
            MetalViewRepresentable()
        }
    }

    /// Compact vertical icon group floating in the bottom-right corner (inside the safe area): the
    /// same corner in portrait and landscape, clear of the HoloKit eye viewports (they hug the
    /// physical landscape bottom edge and centre), and the page underneath stays touchable.
    private var controls: some View {
        VStack(spacing: 18) {
            // All four slots in every state, each icon in a fixed frame: the capsule never changes size
            // (entering AR or switching mono/stereo). AR-only buttons are disabled while browsing.
            Group {
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
                    Label(state.phase.isVR ? "Exit VR" : "Exit AR", systemImage: "xmark")
                }
            }
            .disabled(state.phase == .browsing)
            .frame(width: 28, height: 28)
            Group {
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
            .frame(width: 28, height: 28)
        }
        .labelStyle(.iconOnly)
        .font(.title3)
        .padding(.horizontal, 8)
        .padding(.vertical, 14)
        .background(.ultraThinMaterial, in: Capsule())
        .padding(.trailing, 8)
        .padding(.bottom, 12)
    }
}

#Preview {
    @Previewable @State var state = HoloWebState()
    ContentView()
        .environment(state)
}
