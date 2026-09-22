// SPDX-FileCopyrightText: Copyright 2024 Reality Design Lab <dev@reality.design>
// SPDX-FileContributor: Yuchen Zhang <yuchen@reality.design>
// SPDX-License-Identifier: MIT

import SwiftUI

struct ContentView: View {
    @Environment(HoloWebState.self) private var state

    var body: some View {
        ZStack {
            Color.black
            MetalViewRepresentable()
            WebViewRepresentable()
            controls
        }
        .ignoresSafeArea()
        .statusBarHidden()
        .onAppear { state.startARSession() }
        .onDisappear { state.pauseARSession() }
    }

    private var controls: some View {
        VStack {
            HStack {
                Spacer()
                Button {
                    state.setMode(state.mode == .mono ? .stereo : .mono)
                } label: {
                    Image(systemName: state.mode == .mono ? "vision.pro" : "iphone")
                }
                Button {
                    state.reload()
                } label: {
                    Image(systemName: "arrow.clockwise")
                }
            }
            .font(.title2)
            .padding()
            .foregroundStyle(.white)
            Spacer()
        }
    }
}

#Preview {
    @Previewable @State var state = HoloWebState()
    ContentView()
        .environment(state)
}
