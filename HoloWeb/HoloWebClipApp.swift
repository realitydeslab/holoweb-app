// SPDX-FileCopyrightText: Copyright 2024 Reality Design Lab <dev@reality.design>
// SPDX-License-Identifier: MIT

import SwiftUI

@main
struct HoloWebClipApp: App {
    @UIApplicationDelegateAdaptor(OrientationLockAppDelegate.self) private var orientationLock
    @State private var state = HoloWebState()

    private static let defaultURL = URL(string: "https://holoweb.app/test2/")!

    /// How long to wait for an invocation `NSUserActivity` before showing `defaultURL`.
    private static let invocationTimeout: Duration = .seconds(2)

    /// Xcode sets `_XCAppClipURL` from the scheme's App Clip invocation URL.
    private static func localTestURL() -> URL? {
        guard let raw = ProcessInfo.processInfo.environment["_XCAppClipURL"],
              let invocation = URL(string: raw) else { return nil }
        return HoloWebLink.targetURL(from: invocation)
    }

    private func load(_ url: URL, source: String) {
        print("[clip] \(source): \(url.absoluteString)")
        state.load(url)
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environment(state)
                .onContinueUserActivity(NSUserActivityTypeBrowsingWeb) { activity in
                    guard let invocation = activity.webpageURL,
                          let target = HoloWebLink.targetURL(from: invocation),
                          target != state.url else { return }
                    load(target, source: "invocation")
                }
                .task {
                    if state.url == nil, let target = Self.localTestURL() {
                        load(target, source: "_XCAppClipURL")
                        return
                    }
                    try? await Task.sleep(for: Self.invocationTimeout)
                    if state.url == nil {
                        load(Self.defaultURL, source: "default")
                    }
                }
        }
    }
}
