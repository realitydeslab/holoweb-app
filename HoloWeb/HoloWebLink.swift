// SPDX-FileCopyrightText: Copyright 2024 Reality Design Lab <dev@reality.design>
// SPDX-License-Identifier: MIT

import Foundation

/// Parses HoloWeb invocation links of the form
/// `https://holoweb.app/c?url=<percent-encoded page URL>`.
enum HoloWebLink {
    static let queryKey = "url"

    static func targetURL(from invocation: URL) -> URL? {
        guard let components = URLComponents(url: invocation, resolvingAgainstBaseURL: true),
              let value = components.queryItems?.first(where: { $0.name == queryKey })?.value,
              let target = URL(string: value),
              let scheme = target.scheme?.lowercased(),
              scheme == "https" else {
            return nil
        }
        return target
    }
}
