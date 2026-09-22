// SPDX-FileCopyrightText: Copyright 2026 Reality Design Lab <dev@reality.design>
// SPDX-License-Identifier: MIT

import ARKit
import ImageIO

/// WebXR image tracking (plan/bridge_protocol.md `setTrackedImages` / `onImages`).
///
/// `setTrackedImages` turns each page image into an ARReferenceImage and validates it; the
/// trackable ones become the next session's `detectionImages`. Each reference image is named
/// `holoweb-<index>` so an ARImageAnchor maps back to the page's index.
///
/// Pose convention. WebXR imageSpace (image-tracking explainer): origin at the image centre,
/// +X toward the image's right edge, +Y toward its top edge, +Z out of the image toward the
/// viewer. ARImageAnchor: the image lies in the anchor's XZ plane, +Y is the normal (out of the
/// image), +X is image right and the image top points to -Z. So
///     imageSpace = anchor.transform * Rx(-90°),  Rx(-90°) columns (1,0,0), (0,0,-1), (0,1,0),
/// i.e. new X = anchor X, new Y = anchor -Z (image top), new Z = anchor +Y (normal).
@MainActor
final class ImageTracker {
    /// ARKit tracks at most this many images at once; extra images are reported untrackable.
    static let maxTracked = 4
    static let namePrefix = "holoweb-"

    struct Entry {
        let index: Int
        let widthInMeters: Double
        let reference: ARReferenceImage
    }

    /// Trackable images from the last `setTrackedImages`, in page order.
    private(set) var trackable: [Entry] = []

    var detectionImages: Set<ARReferenceImage> { Set(trackable.map(\.reference)) }

    func clear() { trackable.removeAll() }

    /// Builds and validates reference images; returns one score per requested image, in order.
    func setImages(_ images: [[String: Any]]) async -> [String] {
        var scores: [String] = []
        var accepted: [Entry] = []
        for image in images {
            guard let index = image["index"] as? Int,
                  let width = image["widthInMeters"] as? Double, width.isFinite, width > 0,
                  let png = (image["png"] as? String).flatMap({ Data(base64Encoded: $0) }),
                  let source = CGImageSourceCreateWithData(png as CFData, nil),
                  let cgImage = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
                scores.append("untrackable")
                continue
            }
            let reference = ARReferenceImage(cgImage, orientation: .up, physicalWidth: CGFloat(width))
            reference.name = "\(Self.namePrefix)\(index)"
            var score = "trackable"
            do {
                try await reference.validate()
            } catch {
                print("[bridge] image \(index) untrackable: \(error.localizedDescription)")
                score = "untrackable"
            }
            if score == "trackable", accepted.count >= Self.maxTracked { score = "untrackable" }
            if score == "trackable" { accepted.append(Entry(index: index, widthInMeters: width, reference: reference)) }
            scores.append(score)
        }
        trackable = accepted
        return scores
    }

    /// `onImages` results for the image anchors in `frame`, or nil if there are none.
    func results(_ frame: ARFrame) -> [[String: Any]]? {
        guard !trackable.isEmpty else { return nil }
        let results: [[String: Any]] = frame.anchors.compactMap { anchor in
            guard let image = anchor as? ARImageAnchor, let name = image.referenceImage.name,
                  name.hasPrefix(Self.namePrefix), let index = Int(name.dropFirst(Self.namePrefix.count)),
                  let entry = trackable.first(where: { $0.index == index }) else { return nil }
            let scale = Double(image.estimatedScaleFactor)
            return ["index": index,
                    "transform": Self.imageSpace(image.transform).columnMajor,
                    "tracked": image.isTracked,
                    "measuredWidthInMeters": scale.isFinite && scale > 0 ? entry.widthInMeters * scale : 0]
        }
        return results.isEmpty ? nil : results
    }

    /// ARImageAnchor transform -> WebXR imageSpace (see the type comment).
    nonisolated static func imageSpace(_ anchor: simd_float4x4) -> simd_float4x4 {
        anchor * simd_float4x4(columns: (simd_float4(1, 0, 0, 0), simd_float4(0, 0, -1, 0),
                                         simd_float4(0, 1, 0, 0), simd_float4(0, 0, 0, 1)))
    }
}

// MARK: - Bridge side

extension ARBridge {
    /// `setTrackedImages` message: validates, stores, replies `{ scores }`.
    func setTrackedImages(_ body: [String: Any], replyHandler: @escaping @MainActor @Sendable (Any?, String?) -> Void) {
        let images = body["images"] as? [[String: Any]] ?? []
        nonisolated(unsafe) let payload = images
        let generation = pageGeneration
        Task { @MainActor in
            let scores = await self.imageTracker.setImages(payload)
            guard self.pageGeneration == generation else { return replyHandler(nil, "page changed") }
            print("[bridge] setTrackedImages n=\(scores.count) scores=\(scores.joined(separator: ","))")
            replyHandler(["scores": scores], nil)
        }
    }

    func pushImagesIfNeeded(_ frame: ARFrame) {
        guard imagesRequested, let results = imageTracker.results(frame) else { return }
        call("onImages(results)", ["results": results])
        let now = frame.timestamp
        guard now - lastImagesLog >= 2 else { return }
        lastImagesLog = now
        let summary = results.map { r -> String in
            let t = (r["transform"] as? [Double]) ?? []
            let position = t.count == 16 ? String(format: "(%.2f,%.2f,%.2f)", t[12], t[13], t[14]) : "?"
            return "#\(r["index"] ?? "?") tracked=\(r["tracked"] ?? "?") width=\(String(format: "%.3f", r["measuredWidthInMeters"] as? Double ?? 0)) at \(position)"
        }
        print("[bridge] images sent \(summary.joined(separator: "; "))")
    }
}
