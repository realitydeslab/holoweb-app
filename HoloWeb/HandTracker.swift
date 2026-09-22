// SPDX-FileCopyrightText: Copyright 2026 Reality Design Lab <dev@reality.design>
// SPDX-License-Identifier: MIT

import ARKit
import UIKit
import Vision

/// 3D hand joints for `bridge.onHands` (see plan/bridge_protocol.md).
///
/// Vision finds 2D joints in `ARFrame.capturedImage` on a background queue; each joint is lifted
/// to 3D with the LiDAR depth map and the camera intrinsics, then moved to world space with the
/// raw `ARCamera.transform` (sensor orientation, the same as capturedImage). Only the pixel
/// buffers and camera values of one frame are held, never the ARFrame, and frames arriving while
/// Vision is busy are dropped.
@MainActor
final class HandTracker {
    struct Hand: Sendable {
        let handedness: String
        let joints: [Double]
        let confidence: [Double]
    }

    struct Result: Sendable {
        let hands: [Hand]
        let visionMs: Double
    }

    private(set) var busy = false
    private let queue = DispatchQueue(label: "holoweb.hands", qos: .userInitiated)

    /// Starts tracking `frame` unless a frame is in progress; `completion` runs on the main actor.
    func submit(_ frame: ARFrame, interfaceOrientation: UIInterfaceOrientation,
                completion: @escaping @MainActor @Sendable (Result) -> Void) {
        guard !busy else { return }
        busy = true
        let depth = frame.smoothedSceneDepth ?? frame.sceneDepth
        let input = Input(image: frame.capturedImage, depth: depth?.depthMap, confidence: depth?.confidenceMap,
                          intrinsics: frame.camera.intrinsics, resolution: frame.camera.imageResolution,
                          cameraTransform: frame.camera.transform,
                          orientation: Self.visionOrientation(interfaceOrientation))
        queue.async {
            let result = Self.track(input)
            Task { @MainActor in
                self.busy = false
                completion(result)
            }
        }
    }

    // MARK: - Background work

    /// What one tracking pass needs from an ARFrame. The pixel buffers are only read.
    private struct Input: @unchecked Sendable {
        let image: CVPixelBuffer
        let depth: CVPixelBuffer?
        let confidence: CVPixelBuffer?
        let intrinsics: simd_float3x3
        let resolution: CGSize
        let cameraTransform: simd_float4x4
        let orientation: CGImagePropertyOrientation
    }

    /// Vision order: wrist; thumb CMC, MP, IP, tip; index/middle/ring/little MCP, PIP, DIP, tip.
    private nonisolated static let jointNames: [VNHumanHandPoseObservation.JointName] = [
        .wrist, .thumbCMC, .thumbMP, .thumbIP, .thumbTip,
        .indexMCP, .indexPIP, .indexDIP, .indexTip, .middleMCP, .middlePIP, .middleDIP, .middleTip,
        .ringMCP, .ringPIP, .ringDIP, .ringTip, .littleMCP, .littlePIP, .littleDIP, .littleTip,
    ]
    /// Used when the device has no depth (no LiDAR) or no joint has a valid depth sample.
    private nonisolated static let fallbackDepth: Float = 0.45

    private nonisolated static func track(_ input: Input) -> Result {
        let start = CACurrentMediaTime()
        let request = VNDetectHumanHandPoseRequest()
        request.maximumHandCount = 2
        let handler = VNImageRequestHandler(cvPixelBuffer: input.image, orientation: input.orientation)
        do {
            try handler.perform([request])
        } catch {
            print("[bridge] hand pose request failed: \(error.localizedDescription)")
        }
        let observations = request.results ?? []
        let visionMs = (CACurrentMediaTime() - start) * 1000
        let depth = DepthSampler(depth: input.depth, confidence: input.confidence)
        let hands = observations.compactMap { hand(from: $0, input: input, depth: depth) }
        return Result(hands: hands, visionMs: visionMs)
    }

    private nonisolated static func hand(from observation: VNHumanHandPoseObservation, input: Input,
                                         depth: DepthSampler?) -> Hand? {
        guard let points = try? observation.recognizedPoints(.all) else { return nil }
        // Raw capturedImage coordinates, normalised, origin top-left.
        let image: [simd_float2] = jointNames.map { name in
            guard let p = points[name] else { return simd_float2(0.5, 0.5) }
            return rawNormalized(p.location, orientation: input.orientation)
        }
        let confidence = jointNames.map { Double(points[$0]?.confidence ?? 0) }
        let sampled = image.enumerated().map { i, p in confidence[i] > 0 ? depth?.depth(at: p) : nil }
        let valid = sampled.compactMap { $0 }.sorted()
        let median = valid.isEmpty ? fallbackDepth : valid[valid.count / 2]
        let K = input.intrinsics
        let fx = K.columns.0.x, fy = K.columns.1.y, cx = K.columns.2.x, cy = K.columns.2.y
        let w = Float(input.resolution.width), h = Float(input.resolution.height)
        var joints: [Double] = []
        joints.reserveCapacity(63)
        for (i, p) in image.enumerated() {
            let d = sampled[i] ?? median
            let u = p.x * w, v = p.y * h
            let camera = simd_float4((u - cx) / fx * d, -(v - cy) / fy * d, -d, 1)
            let world = input.cameraTransform * camera
            joints += [Double(world.x), Double(world.y), Double(world.z)]
        }
        guard joints.allSatisfy(\.isFinite) else { return nil }
        // Vision labels chirality from the upright image. The rear camera does not mirror, so the
        // label is used as is (verify on device: raise the right hand, expect "right").
        let handedness = observation.chirality == .left ? "left" : "right"
        return Hand(handedness: handedness, joints: joints, confidence: confidence)
    }

    /// capturedImage is in the sensor's landscape-right orientation; Vision gets the EXIF
    /// orientation that makes the hand upright for the current interface orientation.
    nonisolated static func visionOrientation(_ orientation: UIInterfaceOrientation) -> CGImagePropertyOrientation {
        switch orientation {
        case .landscapeRight: .up
        case .landscapeLeft: .down
        case .portraitUpsideDown: .left
        default: .right
        }
    }

    /// Vision point (normalised, origin bottom-left, in the upright image) -> raw capturedImage
    /// point (normalised, origin top-left).
    nonisolated static func rawNormalized(_ p: CGPoint, orientation: CGImagePropertyOrientation) -> simd_float2 {
        let x = Float(p.x), y = Float(p.y)
        switch orientation {
        case .right: return simd_float2(1 - y, 1 - x)  // raw column 0 is the top row, raw row 0 the right column
        case .down: return simd_float2(1 - x, y)
        case .left: return simd_float2(y, x)
        default: return simd_float2(x, 1 - y)
        }
    }
}

/// Nearest-pixel reads from the depth map (Float32 metres) gated by its confidence map (UInt8
/// ARConfidenceLevel). Both have the same size, and the capturedImage's orientation and aspect at
/// lower resolution.
private struct DepthSampler {
    private let depth: CVPixelBuffer
    private let confidence: CVPixelBuffer?

    init?(depth: CVPixelBuffer?, confidence: CVPixelBuffer?) {
        guard let depth, CVPixelBufferGetPixelFormatType(depth) == kCVPixelFormatType_DepthFloat32 else { return nil }
        self.depth = depth
        self.confidence = confidence
    }

    /// Depth at a normalised top-left point, or nil if low confidence or invalid.
    func depth(at p: simd_float2) -> Float? {
        let w = CVPixelBufferGetWidth(depth), h = CVPixelBufferGetHeight(depth)
        let x = min(max(Int(p.x * Float(w)), 0), w - 1), y = min(max(Int(p.y * Float(h)), 0), h - 1)
        if let confidence {
            CVPixelBufferLockBaseAddress(confidence, .readOnly)
            defer { CVPixelBufferUnlockBaseAddress(confidence, .readOnly) }
            guard let base = CVPixelBufferGetBaseAddress(confidence) else { return nil }
            let row = CVPixelBufferGetBytesPerRow(confidence)
            let level = base.load(fromByteOffset: y * row + x, as: UInt8.self)
            guard level >= UInt8(ARConfidenceLevel.medium.rawValue) else { return nil }
        }
        CVPixelBufferLockBaseAddress(depth, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(depth, .readOnly) }
        guard let base = CVPixelBufferGetBaseAddress(depth) else { return nil }
        let d = base.load(fromByteOffset: y * CVPixelBufferGetBytesPerRow(depth) + x * 4, as: Float32.self)
        return d.isFinite && d > 0.05 ? d : nil
    }
}

// MARK: - Bridge side

/// Rolling numbers for the "[bridge] hands sent" log line.
struct HandStats {
    var results = 0
    var visionMs = 0.0
    var lastLog = CACurrentMediaTime()
}

extension ARBridge {
    /// While streaming with "hand-tracking" requested: hands the frame to the tracker (dropped if
    /// it is busy) and sends every result, `[]` when no hand is found.
    func pushHandsIfNeeded(_ frame: ARFrame) {
        guard handsRequested, !handTracker.busy else { return }
        let orientation = webView.window?.windowScene?.effectiveGeometry.interfaceOrientation ?? .portrait
        let generation = pageGeneration
        handTracker.submit(frame, interfaceOrientation: orientation) { [weak self] result in
            guard let self, self.streaming, self.handsRequested, self.pageGeneration == generation else { return }
            let hands: [[String: Any]] = result.hands.map {
                ["handedness": $0.handedness, "joints": $0.joints, "confidence": $0.confidence]
            }
            self.call("onHands(hands)", ["hands": hands])
            self.handStats.results += 1
            self.handStats.visionMs += result.visionMs
            let now = CACurrentMediaTime(), elapsed = now - self.handStats.lastLog
            guard elapsed >= 2 else { return }
            let stats = self.handStats
            let sides = result.hands.map(\.handedness).joined(separator: ",")
            print(String(format: "[bridge] hands sent n=%d visionMs=%.1f rate=%.1f%@", result.hands.count,
                         stats.visionMs / Double(max(stats.results, 1)), Double(stats.results) / elapsed,
                         sides.isEmpty ? "" : " (\(sides))"))
            self.handStats = HandStats(lastLog: now)
        }
    }
}
