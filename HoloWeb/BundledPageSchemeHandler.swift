// SPDX-FileCopyrightText: Copyright 2026 Reality Design Lab <dev@reality.design>
// SPDX-License-Identifier: MIT

import Foundation
import UniformTypeIdentifiers
import WebKit

/// Serves the app's bundled `Web/` folder at `holoweb-app://local/...`.
///
/// `file://` pages cannot import local ES modules (WebKit rejects them as cross-origin), so bundled
/// test pages and examples are served from this scheme, which gives them one stable origin.
final class BundledPageSchemeHandler: NSObject, WKURLSchemeHandler {
    static let scheme = "holoweb-app"
    static let host = "local"

    private let root: URL?

    override init() {
        root = Bundle.main.resourceURL?.appending(path: "Web").standardizedFileURL
        super.init()
    }

    static func url(forBundledPath path: String) -> URL? {
        URL(string: "\(scheme)://\(host)/\(path)")
    }

    func webView(_ webView: WKWebView, start urlSchemeTask: any WKURLSchemeTask) {
        guard let url = urlSchemeTask.request.url, let root else {
            urlSchemeTask.didFailWithError(URLError(.badURL))
            return
        }
        let file = root.appending(path: url.path(percentEncoded: false)).standardizedFileURL
        // Refuse paths that escape Web/ (e.g. "/../Info.plist").
        guard file.path.hasPrefix(root.path + "/"), let data = try? Data(contentsOf: file) else {
            let response = HTTPURLResponse(url: url, statusCode: 404, httpVersion: "HTTP/1.1", headerFields: nil)
            if let response { urlSchemeTask.didReceive(response) }
            urlSchemeTask.didReceive(Data())
            urlSchemeTask.didFinish()
            return
        }
        let mime = UTType(filenameExtension: file.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
        let headers = ["Content-Type": mime, "Content-Length": String(data.count), "Cache-Control": "no-store"]
        if let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: headers) {
            urlSchemeTask.didReceive(response)
        }
        urlSchemeTask.didReceive(data)
        urlSchemeTask.didFinish()
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: any WKURLSchemeTask) {}
}
