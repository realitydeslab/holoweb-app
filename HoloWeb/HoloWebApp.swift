// SPDX-FileCopyrightText: Copyright 2024 Reality Design Lab <dev@reality.design>
// SPDX-License-Identifier: MIT

import SwiftUI

@main
struct HoloWebApp: App {
    @State private var state = HoloWebState()

    private static let defaultURL = URL(string: "https://holoweb.app/test2/")!

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environment(state)
                .onAppear {
                    if state.url == nil {
                        state.load(Self.defaultURL)
                    }
                }
                .onOpenURL { url in
                    if let target = HoloWebLink.targetURL(from: url) {
                        state.load(target)
                    }
                }
        }
    }
}
