// SPDX-FileCopyrightText: Copyright 2026 Reality Design Lab <dev@reality.design>
// SPDX-License-Identifier: MIT

import ARKit
import Metal

/// Reads ARKit's environment probe cube texture back as a small RGBA8 sRGB cube for WebGL
/// (`bridge.onEnvironment`, see plan/bridge_protocol.md).
///
/// Orientation: Metal and OpenGL/WebGL use the same cube face order (+X, -X, +Y, -Y, +Z, -Z)
/// and the same face-coordinate formulas (e.g. +X: s = -z, t = -y), and both map t = 0 to the
/// first row in memory. So Metal slice i, read row 0 first, is exactly the data for WebGL's
/// `TEXTURE_CUBE_MAP_POSITIVE_X + i` uploaded with `UNPACK_FLIP_Y_WEBGL` false: faces and rows
/// are copied unchanged, and row 0 is the top (+Y edge) of each side face. The cube is in the
/// probe anchor's space; ARKit's automatic probes are axis-aligned with the world, so it is
/// world space too, as WebXR expects.
///
/// The GPU copy runs on a command buffer; conversion happens in its completion handler, off the
/// main thread, so the ARSession delegate never waits for the GPU.
@MainActor
final class EnvironmentProbeReader {
    nonisolated static let size = 32

    struct Output: Sendable {
        let faces: [String]
        let source: String
    }

    private(set) var busy = false
    private var queue: (any MTLCommandQueue)?

    /// Starts reading `texture`; `completion` runs on the main actor with nil on failure.
    /// Returns false (and never calls `completion`) if a read is in progress or the texture
    /// cannot be read.
    @discardableResult
    func read(_ texture: any MTLTexture, completion: @escaping @MainActor @Sendable (Output?) -> Void) -> Bool {
        guard !busy, texture.textureType == .typeCube, let format = SourceFormat(texture.pixelFormat) else {
            return false
        }
        // Smallest mip level still at least `size` wide; the CPU box-filters the rest.
        var level = 0
        while level + 1 < texture.mipmapLevelCount, texture.width >> (level + 1) >= Self.size { level += 1 }
        let side = max(1, texture.width >> level)
        let bytesPerRow = side * format.bytesPerPixel
        let bytesPerImage = bytesPerRow * side
        let device = texture.device
        if queue == nil || queue?.device !== device { queue = device.makeCommandQueue() }
        guard let queue, let commandBuffer = queue.makeCommandBuffer(),
              let buffer = device.makeBuffer(length: bytesPerImage * 6, options: .storageModeShared),
              let blit = commandBuffer.makeBlitCommandEncoder() else { return false }
        // A blit copy works for private-storage textures, which the CPU cannot read directly.
        for face in 0..<6 {
            blit.copy(from: texture, sourceSlice: face, sourceLevel: level,
                      sourceOrigin: MTLOrigin(), sourceSize: MTLSize(width: side, height: side, depth: 1),
                      to: buffer, destinationOffset: face * bytesPerImage,
                      destinationBytesPerRow: bytesPerRow, destinationBytesPerImage: bytesPerImage)
        }
        blit.endEncoding()
        busy = true
        let source = "\(format.name) \(texture.width)x\(texture.height) mips=\(texture.mipmapLevelCount)"
        nonisolated(unsafe) let readback = buffer
        commandBuffer.addCompletedHandler { finished in
            var output: Output?
            if finished.status == .completed {
                let faces = (0..<6).map { face in
                    Self.convert(readback.contents() + face * bytesPerImage, side: side, format: format)
                }
                output = Output(faces: faces, source: source)
            }
            let result = output
            Task { @MainActor in
                self.busy = false
                completion(result)
            }
        }
        commandBuffer.commit()
        return true
    }

    /// One face, `side` x `side` source pixels -> `size` x `size` RGBA8 sRGB, base64.
    /// Box filter when shrinking, nearest when growing. Float sources are linear and are
    /// averaged before encoding; 8-bit sources are treated as sRGB-encoded bytes.
    private nonisolated static func convert(_ src: UnsafeRawPointer, side: Int, format: SourceFormat) -> String {
        let n = size
        var out = [UInt8](repeating: 0, count: n * n * 4)
        for oy in 0..<n {
            let y0 = oy * side / n, y1 = max(y0 + 1, (oy + 1) * side / n)
            for ox in 0..<n {
                let x0 = ox * side / n, x1 = max(x0 + 1, (ox + 1) * side / n)
                var sum = SIMD4<Float>.zero
                for y in y0..<y1 {
                    for x in x0..<x1 { sum += format.load(src, offset: (y * side + x) * format.bytesPerPixel) }
                }
                let c = sum / Float((y1 - y0) * (x1 - x0))
                let o = (oy * n + ox) * 4
                if format.isLinear {
                    out[o] = encodeSRGB(c.x); out[o + 1] = encodeSRGB(c.y); out[o + 2] = encodeSRGB(c.z)
                    out[o + 3] = 255
                } else {
                    let b = (c.clamped(lowerBound: .zero, upperBound: .one) * 255).rounded(.toNearestOrAwayFromZero)
                    out[o] = UInt8(b.x); out[o + 1] = UInt8(b.y); out[o + 2] = UInt8(b.z); out[o + 3] = UInt8(b.w)
                }
            }
        }
        return Data(out).base64EncodedString()
    }

    /// Linear -> 8-bit sRGB. HDR values above 1 clip to white.
    private nonisolated static func encodeSRGB(_ linear: Float) -> UInt8 {
        let c = min(max(linear.isFinite ? linear : 0, 0), 1)
        let s = c <= 0.0031308 ? 12.92 * c : 1.055 * pow(c, 1 / 2.4) - 0.055
        return UInt8((s * 255).rounded())
    }
}

/// Pixel formats ARKit has been seen to use (or plausibly could) for environment textures.
private enum SourceFormat: Sendable {
    case rgba16Float, rgba32Float, rgba8, bgra8

    init?(_ format: MTLPixelFormat) {
        switch format {
        case .rgba16Float: self = .rgba16Float
        case .rgba32Float: self = .rgba32Float
        case .rgba8Unorm, .rgba8Unorm_srgb: self = .rgba8
        case .bgra8Unorm, .bgra8Unorm_srgb: self = .bgra8
        default:
            print("[bridge] environment texture pixel format \(format.rawValue) not supported")
            return nil
        }
    }

    var name: String {
        switch self {
        case .rgba16Float: "rgba16Float"
        case .rgba32Float: "rgba32Float"
        case .rgba8: "rgba8"
        case .bgra8: "bgra8"
        }
    }

    var bytesPerPixel: Int {
        switch self {
        case .rgba16Float: 8
        case .rgba32Float: 16
        case .rgba8, .bgra8: 4
        }
    }

    var isLinear: Bool { self == .rgba16Float || self == .rgba32Float }

    /// RGBA in 0...1 (8-bit) or linear (float).
    func load(_ src: UnsafeRawPointer, offset: Int) -> SIMD4<Float> {
        switch self {
        case .rgba16Float:
            let p = src + offset
            return SIMD4(Float(p.loadUnaligned(as: Float16.self)), Float(p.loadUnaligned(fromByteOffset: 2, as: Float16.self)),
                         Float(p.loadUnaligned(fromByteOffset: 4, as: Float16.self)), Float(p.loadUnaligned(fromByteOffset: 6, as: Float16.self)))
        case .rgba32Float:
            return (src + offset).loadUnaligned(as: SIMD4<Float>.self)
        case .rgba8, .bgra8:
            let p = src + offset
            let v = SIMD4<Float>(Float(p.load(as: UInt8.self)), Float(p.load(fromByteOffset: 1, as: UInt8.self)),
                                 Float(p.load(fromByteOffset: 2, as: UInt8.self)), Float(p.load(fromByteOffset: 3, as: UInt8.self))) / 255
            return self == .bgra8 ? SIMD4(v.z, v.y, v.x, v.w) : v
        }
    }
}

// MARK: - Bridge side: pick a probe, throttle, send

extension ARBridge {
    /// At most once per second while streaming, if the page requested light-estimation: reads the probe nearest the camera (distance to
    /// its box, so a probe containing the camera wins) and sends it to the page.
    func pushEnvironmentIfNeeded(_ frame: ARFrame) {
        guard environmentRequested, environmentDirty, !environmentReader.busy, frame.timestamp - lastEnvironmentSent >= 1 else { return }
        let camera = frame.camera.transform.columns.3
        let candidates = environmentProbes.values.filter { $0.environmentTexture != nil }
        guard let probe = candidates.min(by: { Self.rank(camera, $0) < Self.rank(camera, $1) }),
              let texture = probe.environmentTexture else { return }
        // Throttle attempts too, so an unreadable texture is retried once per second, not per frame.
        lastEnvironmentSent = frame.timestamp
        let timestamp = frame.timestamp * 1000
        let generation = pageGeneration
        let started = environmentReader.read(texture) { [weak self] output in
            guard let self, self.streaming, self.pageGeneration == generation else { return }
            guard let output else {
                self.environmentDirty = true
                return
            }
            self.call("onEnvironment(env)", ["env": [
                "size": EnvironmentProbeReader.size, "format": "rgba8", "colorSpace": "srgb",
                "faces": output.faces, "timestamp": timestamp,
            ] as [String: Any]])
            if !self.loggedEnvironment {
                self.loggedEnvironment = true
                print("[bridge] environment map sent size=\(EnvironmentProbeReader.size) source=\(output.source)")
            }
        }
        if started { environmentDirty = false }
    }

    /// (distance from the probe's box, distance from its centre): a probe containing the camera
    /// sorts first; ties (e.g. several unbounded probes) go to the nearer centre.
    private static func rank(_ point: simd_float4, _ probe: AREnvironmentProbeAnchor) -> (Float, Float) {
        let local = simd_make_float3(probe.transform.inverse * point)
        let outside = simd_max(simd_abs(local) - probe.extent / 2, .zero)
        let boxDistance = simd_length(outside)
        return (boxDistance.isFinite ? boxDistance : 0, simd_length(local))
    }
}
