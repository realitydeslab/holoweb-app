// SPDX-FileCopyrightText: Copyright 2024 Reality Design Lab <dev@reality.design>
// SPDX-License-Identifier: MIT

import SwiftUI

@main
struct HoloWebApp: App {
    @State private var state = HoloWebState()

    /// Home page: the holoweb.app gallery of WebXR experiences.
    static let defaultURL = URL(string: "https://holoweb.app/")!

    /// `HOLOWEB_PAGE` selects a bundled page under `Web/`; `HOLOWEB_URL` any URL.
    private static func launchURL() -> URL {
        let env = ProcessInfo.processInfo.environment
        if let page = env["HOLOWEB_PAGE"], let url = HoloWebState.bundledPage(page) { return url }
        if let raw = env["HOLOWEB_URL"], let url = URL(string: raw) { return url }
        return defaultURL
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environment(state)
                .onAppear {
                    guard state.url == nil else { return }
                    state.load(Self.launchURL())
                }
                .onOpenURL { url in
                    if let target = HoloWebLink.targetURL(from: url) {
                        state.load(target)
                    }
                }
                .onContinueUserActivity(NSUserActivityTypeBrowsingWeb) { activity in
                    guard let invocation = activity.webpageURL,
                          let target = HoloWebLink.targetURL(from: invocation) else { return }
                    state.load(target)
                }
        }
    }
}
