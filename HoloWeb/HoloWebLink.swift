// SPDX-FileCopyrightText: Copyright 2024 Reality Design Lab <dev@reality.design>
// SPDX-License-Identifier: MIT

import Foundation

/// Parses HoloWeb invocation links:
/// - `https://holoweb.app/launch?url=<percent-encoded page URL>` (or `/c?url=`), and
/// - App Clip Code short links `https://holoweb.app/c/<code>`. These load the short page itself,
///   which redirects to its experience when it sees the polyfill (`window.__holoweb`).
enum HoloWebLink {
    static let queryKey = "url"

    static let host = "holoweb.app"
    static let invocationPaths: Set<String> = ["/launch", "/launch/", "/c", "/c/"]

    /// Target of a HoloWeb invocation link clicked inside the app's own web view, or nil for any
    /// other navigation (so ordinary pages, including holoweb.app itself, load normally).
    static func inAppTarget(from url: URL) -> URL? {
        guard url.host()?.lowercased() == host, invocationPaths.contains(url.path()) else { return nil }
        return targetURL(from: url)
    }

    static func targetURL(from invocation: URL) -> URL? {
        if isShortLink(invocation) { return invocation }
        guard let components = URLComponents(url: invocation, resolvingAgainstBaseURL: true),
              let value = components.queryItems?.first(where: { $0.name == queryKey })?.value,
              let target = URL(string: value),
              let scheme = target.scheme?.lowercased(),
              scheme == "https" else {
            return nil
        }
        return target
    }

    /// `https://holoweb.app/c/<code>` with a short alphanumeric code.
    static func isShortLink(_ url: URL) -> Bool {
        guard url.scheme?.lowercased() == "https", url.host()?.lowercased() == host else { return false }
        let parts = url.path().split(separator: "/")
        return parts.count == 2 && parts[0] == "c" && parts[1].count <= 16
            && parts[1].allSatisfy { $0.isLetter || $0.isNumber || $0 == "-" }
    }
}
