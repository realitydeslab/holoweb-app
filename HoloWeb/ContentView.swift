// SPDX-FileCopyrightText: Copyright 2024 Reality Design Lab <dev@reality.design>
// SPDX-FileContributor: Yuchen Zhang <yuchen@reality.design>
// SPDX-License-Identifier: MIT

import SwiftUI

/// Screen states (see `ViewerPhase`):
/// - browsing: the website on an opaque system background; only reload is offered.
/// - arMono: after the page's "Start AR", the camera shows through the transparent page.
/// - arStereo: via the corner toggle; black background for HoloKit's optical see-through.
/// - vrMono / vrStereo: immersive-vr; always black, ARKit only provides tracking.
struct ContentView: View {
    @Environment(HoloWebState.self) private var state
    @State private var orientation: UIInterfaceOrientation = .portrait

    var body: some View {
        ZStack {
            background
            WebViewRepresentable()
        }
        .ignoresSafeArea()
        // Controls stay inside the safe area so they never sit under the status bar or the notch.
        .overlay(alignment: controlsCorner) { controls }
        .background(InterfaceOrientationReader(orientation: $orientation))
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

    /// The capsule is pinned to one physical corner of the phone (portrait bottom-right) whatever the
    /// interface orientation, with Reload nearest that corner. With the Dynamic Island on the left
    /// (HoloKit, interface landscapeRight) that corner is the top-right, above the HoloKit eyes, which
    /// hug the bottom edge; with it on the right (landscapeLeft) it is the bottom-left.
    private var controlsCorner: Alignment {
        switch orientation {
        case .landscapeRight: .topTrailing
        case .landscapeLeft: .bottomLeading
        default: .bottomTrailing
        }
    }

    private enum Control: CaseIterable { case mode, exit, gallery, reload }

    /// Compact icon group: all four slots in every state, each icon in a fixed frame, so the capsule
    /// never changes size (entering AR, switching mono/stereo). AR-only buttons are disabled while browsing.
    private var controls: some View {
        let vertical = orientation != .landscapeRight && orientation != .landscapeLeft
        let order = orientation == .landscapeLeft ? Control.allCases.reversed() : Control.allCases
        let layout = vertical ? AnyLayout(VStackLayout(spacing: 18)) : AnyLayout(HStackLayout(spacing: 18))
        return layout {
            ForEach(order, id: \.self) { control in
                button(control).frame(width: 28, height: 28)
            }
        }
        .labelStyle(.iconOnly)
        .font(.title3)
        .padding(.horizontal, vertical ? 8 : 14)
        .padding(.vertical, vertical ? 14 : 8)
        .background(.ultraThinMaterial, in: Capsule())
        .padding(12)
    }

    @ViewBuilder private func button(_ control: Control) -> some View {
        switch control {
        case .mode:
            Button {
                state.setMode(state.mode == .mono ? .stereo : .mono)
            } label: {
                Label(state.mode == .mono ? "Stereo" : "Mono",
                      systemImage: state.mode == .mono ? "vision.pro" : "iphone")
            }
            .accessibilityHint("Switch between handheld AR and HoloKit stereo")
            .disabled(state.phase == .browsing)
        case .exit:
            Button {
                state.exitXR()
            } label: {
                Label(state.phase.isVR ? "Exit VR" : "Exit AR", systemImage: "xmark")
            }
            .disabled(state.phase == .browsing)
        case .gallery:
            Button {
                state.goHome()
            } label: {
                Label("Gallery", systemImage: "square.grid.2x2")
            }
        case .reload:
            Button {
                state.reload()
            } label: {
                Label("Reload", systemImage: "arrow.clockwise")
            }
        }
    }
}

/// Reports the window scene's interface orientation. KVO on `effectiveGeometry` also catches the
/// 180-degree landscape flip, which does not change the view size.
private struct InterfaceOrientationReader: UIViewRepresentable {
    @Binding var orientation: UIInterfaceOrientation

    func makeUIView(context: Context) -> ProbeView {
        let view = ProbeView()
        view.isUserInteractionEnabled = false
        view.onChange = { orientation = $0 }
        return view
    }

    func updateUIView(_ view: ProbeView, context: Context) {
        view.onChange = { orientation = $0 }
    }

    final class ProbeView: UIView {
        var onChange: ((UIInterfaceOrientation) -> Void)?
        private var observation: NSKeyValueObservation?

        override func didMoveToWindow() {
            super.didMoveToWindow()
            observation = window?.windowScene?.observe(\.effectiveGeometry, options: [.initial, .new]) { [weak self] scene, _ in
                MainActor.assumeIsolated {
                    self?.onChange?(scene.effectiveGeometry.interfaceOrientation)
                }
            }
        }
    }
}

#Preview {
    @Previewable @State var state = HoloWebState()
    ContentView()
        .environment(state)
}
