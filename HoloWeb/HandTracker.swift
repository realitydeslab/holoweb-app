// SPDX-FileCopyrightText: Copyright 2026 Reality Design Lab <dev@reality.design>
// SPDX-License-Identifier: MIT

import ARKit
import UIKit
import Vision

/// 3D hand joints for `bridge.onHands` (plan/bridge_protocol.md, plan/samples_requirements.md G10).
///
/// Vision finds 21 2D joints per hand in `ARFrame.capturedImage` on a serial background queue. The
/// buffer is in sensor orientation (upright for interface landscapeRight); Vision is told the
/// orientation that makes it upright for the current interface orientation (a hand rotated 90 degrees
/// is detected far less often), and its joints are mapped back to buffer coordinates, the frame of
/// the depth map and the intrinsics.
/// Handedness comes from hand geometry (see `firstPersonHandedness`), not Vision's chirality. Each
/// joint is lifted to 3D with the LiDAR depth map: a 3x3 median of medium/high-confidence pixels,
/// clamped to the palm depth +- 8 cm, since thin fingers often sample the background at their
/// silhouette. Joints are unprojected with the intrinsics and moved to world space with the raw
/// `ARCamera.transform`. Only one frame's pixel buffers are held, never the ARFrame; frames
/// arriving while Vision is busy are dropped. Runs at 60 Hz (Vision ~8 ms), 30 Hz when the device is hot.
@MainActor
final class HandTracker {
    struct Hand: Sendable {
        let handedness: String
        let joints: [Double]
        let confidence: [Double]
        /// Bit i set: joint i has measured depth (not inferred from the palm).
        let depthValid: Int
        /// Vision's own chirality label, for debugging only (unreliable for this view).
        let visionChirality: String
        /// Thumb-tip to index-tip distance, for the log: 3D in metres scaled to a 0.095 m hand
        /// (what the polyfill's pinch test sees) and 2D in the image over wrist-to-middle-knuckle.
        let pinch3D: Double
        let pinch2D: Double
        /// Both fingertips (4, 8) had measured depth.
        var tipsHaveDepth: Bool { depthValid & (1 << 4) != 0 && depthValid & (1 << 8) != 0 }
    }

    struct Result: Sendable {
        /// ARFrame timestamp (ms) of the image the hands were found in.
        let t: Double
        let hands: [Hand]
        let visionMs: Double
    }

    private(set) var busy = false
    private var lastSubmit: TimeInterval = 0
    private let queue = DispatchQueue(label: "holoweb.hands", qos: .userInitiated)
    /// Per-hand depth offsets from the palm, touched only on `queue`.
    private let memory = DepthMemory()

    /// Starts tracking `frame` if due and idle; `completion` runs on the main actor.
    func submit(_ frame: ARFrame, interfaceOrientation: UIInterfaceOrientation,
                completion: @escaping @MainActor @Sendable (Result) -> Void) {
        let thermal = ProcessInfo.processInfo.thermalState
        guard !busy, thermal != .critical else { return }
        let interval = thermal == .serious ? 1.0 / 30 : 1.0 / 60
        // Small margin so 60 Hz frames (16.7 ms apart) are not skipped by timestamp jitter.
        guard frame.timestamp - lastSubmit >= interval - 0.004 else { return }
        lastSubmit = frame.timestamp
        busy = true
        let depth = frame.smoothedSceneDepth ?? frame.sceneDepth
        let input = Input(image: frame.capturedImage, orientation: Self.visionOrientation(interfaceOrientation),
                          depth: depth?.depthMap, confidence: depth?.confidenceMap,
                          intrinsics: frame.camera.intrinsics, resolution: frame.camera.imageResolution,
                          cameraTransform: frame.camera.transform, t: frame.timestamp * 1000)
        let memory = self.memory
        queue.async {
            let result = Self.track(input, memory: memory)
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
        let orientation: CGImagePropertyOrientation
        let depth: CVPixelBuffer?
        let confidence: CVPixelBuffer?
        let intrinsics: simd_float3x3
        let resolution: CGSize
        let cameraTransform: simd_float4x4
        let t: Double
    }

    /// Orientation that makes the rear camera's sensor-oriented buffer upright for the interface.
    nonisolated static func visionOrientation(_ interface: UIInterfaceOrientation) -> CGImagePropertyOrientation {
        switch interface {
        case .landscapeRight: .up
        case .landscapeLeft: .down
        case .portraitUpsideDown: .left
        default: .right
        }
    }

    /// A Vision point in the image as oriented by `orientation` (normalised, origin bottom-left) ->
    /// the unrotated buffer (normalised, origin top-left). `.right`: the buffer is shown rotated
    /// 90 degrees clockwise, so display (x, y-down) = (1 - by, bx).
    nonisolated static func bufferPoint(_ p: CGPoint, orientation: CGImagePropertyOrientation) -> simd_float2 {
        let x = Float(p.x), y = Float(p.y)
        switch orientation {
        case .down: return simd_float2(1 - x, y)
        case .right: return simd_float2(1 - y, 1 - x)
        case .left: return simd_float2(y, x)
        default: return simd_float2(x, 1 - y)
        }
    }

    /// Vision order: wrist; thumb CMC, MP, IP, tip; index/middle/ring/little MCP, PIP, DIP, tip.
    private nonisolated static let jointNames: [VNHumanHandPoseObservation.JointName] = [
        .wrist, .thumbCMC, .thumbMP, .thumbIP, .thumbTip,
        .indexMCP, .indexPIP, .indexDIP, .indexTip, .middleMCP, .middlePIP, .middleDIP, .middleTip,
        .ringMCP, .ringPIP, .ringDIP, .ringTip, .littleMCP, .littlePIP, .littleDIP, .littleTip,
    ]
    /// Wrist, thumb CMC and the four finger MCPs: large, flat, almost always valid depth.
    private nonisolated static let palmJoints = [0, 1, 5, 9, 13, 17]
    private nonisolated static let palmWindow: Float = 0.08
    /// Used when the device has no depth (no LiDAR) or the palm has no valid depth sample.
    private nonisolated static let fallbackDepth: Float = 0.45

    private nonisolated static func track(_ input: Input, memory: DepthMemory) -> Result {
        let start = CACurrentMediaTime()
        let request = VNDetectHumanHandPoseRequest()
        request.maximumHandCount = 2
        let handler = VNImageRequestHandler(cvPixelBuffer: input.image, orientation: input.orientation)
        do {
            try handler.perform([request])
        } catch {
            print("[bridge] hand pose request failed: \(error.localizedDescription)")
        }
        let visionMs = (CACurrentMediaTime() - start) * 1000
        let depth = DepthSampler(depth: input.depth, confidence: input.confidence)
        let hands = (request.results ?? []).compactMap { hand(from: $0, input: input, depth: depth, memory: memory) }
        memory.forget(except: Set(hands.map(\.handedness)))
        return Result(t: input.t, hands: hands, visionMs: visionMs)
    }

    private nonisolated static func hand(from observation: VNHumanHandPoseObservation, input: Input,
                                         depth: DepthSampler?, memory: DepthMemory) -> Hand? {
        guard let points = try? observation.recognizedPoints(.all),
              let handedness = firstPersonHandedness(points) else { return nil }
        let visionChirality = switch observation.chirality {
        case .left: "left"
        case .right: "right"
        default: "unknown"
        }
        // Vision's oriented image (normalised, origin bottom-left) -> the pixel buffer (normalised,
        // origin top-left).
        let image = jointNames.map { name -> simd_float2 in
            guard let p = points[name] else { return simd_float2(0.5, 0.5) }
            return bufferPoint(p.location, orientation: input.orientation)
        }
        let confidence = jointNames.map { Double(points[$0]?.confidence ?? 0) }
        let sampled = image.enumerated().map { i, p in confidence[i] > 0 ? depth?.median3x3(at: p) : nil }
        let palmSamples = palmJoints.compactMap { sampled[$0] }.sorted()
        let palm = palmSamples.isEmpty ? fallbackDepth : palmSamples[palmSamples.count / 2]
        var offsets = memory.offsets(handedness)
        var depthValid = 0
        let depths = sampled.enumerated().map { i, d -> Float in
            if let d, abs(d - palm) <= palmWindow {
                depthValid |= 1 << i
                offsets[i] = d - palm
                return d
            }
            return palm + offsets[i]
        }
        memory.store(offsets, for: handedness)
        let K = input.intrinsics
        let fx = K.columns.0.x, fy = K.columns.1.y, cx = K.columns.2.x, cy = K.columns.2.y
        let w = Float(input.resolution.width), h = Float(input.resolution.height)
        var joints: [Double] = []
        joints.reserveCapacity(63)
        for (i, p) in image.enumerated() {
            let d = depths[i], u = p.x * w, v = p.y * h
            let world = input.cameraTransform * simd_float4((u - cx) / fx * d, -(v - cy) / fy * d, -d, 1)
            joints += [Double(world.x), Double(world.y), Double(world.z)]
        }
        guard joints.allSatisfy(\.isFinite) else { return nil }
        let joint = { (i: Int) in simd_double3(joints[i * 3], joints[i * 3 + 1], joints[i * 3 + 2]) }
        let pixel = { (i: Int) in simd_float2(image[i].x * w, image[i].y * h) }
        let scale3D = simd_distance(joint(0), joint(9)) / 0.095
        let span2D = simd_distance(pixel(0), pixel(9))
        return Hand(handedness: handedness, joints: joints, confidence: confidence, depthValid: depthValid,
                    visionChirality: visionChirality,
                    pinch3D: scale3D > 0 ? simd_distance(joint(4), joint(8)) / scale3D : .infinity,
                    pinch2D: span2D > 0 ? Double(simd_distance(pixel(4), pixel(8)) / span2D) : .infinity)
    }

    /// Handedness from the hand's geometry, not Vision's chirality: Vision labels both hands of a
    /// first-person rear-camera view "right" (scratchpad fixture first-person-two-hands.jpg).
    /// The rear camera sees the BACK of the user's hands (handheld AR, HoloKit). With
    /// a = indexMCP - wrist and b = littleMCP - wrist in Vision's coordinates (normalised, y up,
    /// in capturedImage, which is not mirrored), s = a.x*b.y - a.y*b.x is positive for the back of
    /// a left hand (index knuckle to the right of the little one when the fingers point up) and
    /// negative for the back of a right hand. The sign of a cross product survives rotation, so
    /// the sensor-vs-display orientation does not matter; only mirroring would flip it.
    /// A palm facing the camera reads as the other hand; that view is not first-person.
    private nonisolated static func firstPersonHandedness(_ points: [VNHumanHandPoseObservation.JointName: VNRecognizedPoint]) -> String? {
        guard let wrist = points[.wrist], let index = points[.indexMCP], let little = points[.littleMCP] else { return nil }
        let a = CGPoint(x: index.location.x - wrist.location.x, y: index.location.y - wrist.location.y)
        let b = CGPoint(x: little.location.x - wrist.location.x, y: little.location.y - wrist.location.y)
        let s = a.x * b.y - a.y * b.x
        return s > 0 ? "left" : "right"
    }
}

/// Last depth offset from the palm per joint and hand, for joints whose depth is missing or
/// implausible in the current frame. Used only on the tracker's serial queue.
private final class DepthMemory: @unchecked Sendable {
    private var byHand: [String: [Float]] = [:]

    func offsets(_ hand: String) -> [Float] { byHand[hand] ?? [Float](repeating: 0, count: 21) }
    func store(_ offsets: [Float], for hand: String) { byHand[hand] = offsets }
    func forget(except seen: Set<String>) { byHand = byHand.filter { seen.contains($0.key) } }
}

/// Reads from the depth map (Float32 metres) gated by its confidence map (UInt8
/// ARConfidenceLevel). Both have the same size, and the capturedImage's orientation and aspect at
/// lower resolution (256x192 for 1920x1440).
private struct DepthSampler {
    private let depth: CVPixelBuffer
    private let confidence: CVPixelBuffer?

    init?(depth: CVPixelBuffer?, confidence: CVPixelBuffer?) {
        guard let depth, CVPixelBufferGetPixelFormatType(depth) == kCVPixelFormatType_DepthFloat32 else { return nil }
        self.depth = depth
        self.confidence = confidence
    }

    /// Median of the 3x3 neighbourhood's medium/high-confidence depths at a normalised top-left
    /// point, or nil if none is valid. Vision places joints of a hand at the frame edge slightly
    /// outside [0, 1]; those have no depth (an empty neighbourhood range would trap).
    func median3x3(at p: simd_float2) -> Float? {
        let w = CVPixelBufferGetWidth(depth), h = CVPixelBufferGetHeight(depth)
        guard p.x.isFinite, p.y.isFinite, (0...1).contains(p.x), (0...1).contains(p.y) else { return nil }
        let cx = min(Int(p.x * Float(w)), w - 1), cy = min(Int(p.y * Float(h)), h - 1)
        CVPixelBufferLockBaseAddress(depth, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(depth, .readOnly) }
        if let confidence { CVPixelBufferLockBaseAddress(confidence, .readOnly) }
        defer { if let confidence { CVPixelBufferUnlockBaseAddress(confidence, .readOnly) } }
        guard let base = CVPixelBufferGetBaseAddress(depth) else { return nil }
        let row = CVPixelBufferGetBytesPerRow(depth)
        let confidenceBase = confidence.flatMap(CVPixelBufferGetBaseAddress)
        let confidenceRow = confidence.map(CVPixelBufferGetBytesPerRow) ?? 0
        let minimum = UInt8(ARConfidenceLevel.medium.rawValue)
        var values: [Float] = []
        for y in max(cy - 1, 0)...min(cy + 1, h - 1) {
            for x in max(cx - 1, 0)...min(cx + 1, w - 1) {
                if let confidenceBase, confidenceBase.load(fromByteOffset: y * confidenceRow + x, as: UInt8.self) < minimum {
                    continue
                }
                let d = base.load(fromByteOffset: y * row + x * 4, as: Float32.self)
                if d.isFinite, d > 0.05 { values.append(d) }
            }
        }
        guard !values.isEmpty else { return nil }
        values.sort()
        return values[values.count / 2]
    }
}

// MARK: - Bridge side

/// Rolling numbers for the "[bridge] hands sent" log line.
struct HandStats {
    var results = 0
    var visionMs = 0.0
    var lastLog = CACurrentMediaTime()
    /// onHands calls not returned yet (completions arrive ~17 ms late); at most `maxInFlight`,
    /// further results are dropped.
    var inFlight = 0
    static let maxInFlight = 2
    /// Smallest thumb-index distances in the window (see `Hand.pinch3D` / `pinch2D`).
    var minPinch3D = Double.infinity
    var minPinch2D = Double.infinity
    var handResults = 0
    var tipDepthResults = 0
    /// Longest wait between consecutive results that contain a hand (gaps over 1 s are the hand
    /// leaving the view, not a hitch), and results dropped because two calls were in flight.
    var maxHandGapMs = 0.0
    var droppedInFlight = 0
}

extension ARBridge {
    /// While streaming with "hand-tracking" requested: hands the frame to the tracker and sends
    /// each result as `onHands({ t, hands })`, `hands: []` when none is found.
    func pushHandsIfNeeded(_ frame: ARFrame) {
        guard handsRequested, !handTracker.busy else { return }
        let generation = pageGeneration
        let orientation = webView.window?.windowScene?.effectiveGeometry.interfaceOrientation ?? .portrait
        handTracker.submit(frame, interfaceOrientation: orientation) { [weak self] result in
            guard let self, self.streaming, self.handsRequested, self.pageGeneration == generation else { return }
            if !result.hands.isEmpty {
                if let last = self.lastHandResultMs, result.t - last < 1000 {
                    self.handStats.maxHandGapMs = max(self.handStats.maxHandGapMs, result.t - last)
                }
                self.lastHandResultMs = result.t
            }
            guard self.handStats.inFlight < HandStats.maxInFlight else {
                self.handStats.droppedInFlight += 1
                return
            }
            let hands: [[String: Any]] = result.hands.map {
                ["handedness": $0.handedness, "joints": $0.joints, "confidence": $0.confidence,
                 "depthValid": $0.depthValid, "visionChirality": $0.visionChirality]
            }
            self.handStats.inFlight += 1
            self.call("onHands(update)", ["update": ["t": result.t, "hands": hands] as [String: Any]]) { [weak self] in
                guard let self else { return }
                self.handStats.inFlight = max(0, self.handStats.inFlight - 1)
            }
            self.handStats.results += 1
            self.handStats.visionMs += result.visionMs
            for hand in result.hands {
                self.handStats.handResults += 1
                if hand.tipsHaveDepth { self.handStats.tipDepthResults += 1 }
                self.handStats.minPinch3D = min(self.handStats.minPinch3D, hand.pinch3D)
                self.handStats.minPinch2D = min(self.handStats.minPinch2D, hand.pinch2D)
            }
            let now = CACurrentMediaTime(), elapsed = now - self.handStats.lastLog
            guard elapsed >= 2 else { return }
            let stats = self.handStats
            let sides = result.hands.map { "\($0.handedness):\($0.depthValid.nonzeroBitCount)/21" }.joined(separator: ",")
            let pinch = stats.handResults == 0 ? "" : String(
                format: " handRate=%.1f maxGap=%.0fms dropped=%d pinchMin3D=%.3fm pinchMin2D=%.2f tipsDepth=%d/%d",
                Double(stats.handResults) / elapsed, stats.maxHandGapMs, stats.droppedInFlight,
                stats.minPinch3D, stats.minPinch2D, stats.tipDepthResults, stats.handResults)
            print(String(format: "[bridge] hands sent n=%d visionMs=%.1f rate=%.1f%@%@", result.hands.count,
                         stats.visionMs / Double(max(stats.results, 1)), Double(stats.results) / elapsed,
                         sides.isEmpty ? "" : " (\(sides) depth)", pinch))
            self.handStats = HandStats(lastLog: now, inFlight: stats.inFlight)
        }
    }
}
