// SPDX-FileCopyrightText: Copyright 2024 Reality Design Lab <dev@reality.design>
// SPDX-License-Identifier: MIT

import SwiftUI

@main
struct HoloWebClipApp: App {
    @State private var state = HoloWebState()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environment(state)
                .onContinueUserActivity(NSUserActivityTypeBrowsingWeb) { activity in
                    guard let invocation = activity.webpageURL,
                          let target = HoloWebLink.targetURL(from: invocation) else { return }
                    state.load(target)
                }
        }
    }
}
