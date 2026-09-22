// SPDX-FileCopyrightText: Copyright 2026 Reality Design Lab <dev@reality.design>
// SPDX-License-Identifier: MIT

import ARKit

/// LiDAR scene-reconstruction meshes for `bridge.onMeshes` (see plan/bridge_protocol.md).
///
/// Collects ARMeshAnchor adds/updates/removals, then at most twice a second sends the changed
/// ones: vertices as base64 Float32 xyz in anchor space, indices as base64 Uint32 triangles.
/// One update carries at most `byteBudget` of base64; the rest stays queued and goes out on the
/// following frames, so a large first scan never produces one huge call.
@MainActor
final class MeshStreamer {
    static let interval: TimeInterval = 0.5
    static let byteBudget = 2_000_000

    private var anchors: [UUID: ARMeshAnchor] = [:]
    /// Changed since last sent, oldest first (a mesh updated again keeps its place).
    private var dirty: [UUID] = []
    private var removed: [UUID] = []
    /// Updated since the last ARFrame; stamped with that frame's timestamp.
    private var pendingStamp: Set<UUID> = []
    private var lastChanged: [UUID: Double] = [:]
    private var lastSent: TimeInterval = 0
    /// A previous update hit the budget; send the remainder on the next frame.
    private var backlog = false

    func update(_ anchor: ARMeshAnchor) {
        let id = anchor.identifier
        anchors[id] = anchor
        pendingStamp.insert(id)
        if !dirty.contains(id) { dirty.append(id) }
    }

    func remove(_ anchor: ARMeshAnchor) {
        let id = anchor.identifier
        guard anchors.removeValue(forKey: id) != nil else { return }
        dirty.removeAll { $0 == id }
        pendingStamp.remove(id)
        lastChanged.removeValue(forKey: id)
        removed.append(id)
    }

    /// A new XR session: resend everything ARKit still holds.
    func markAllDirty() {
        dirty = Array(anchors.keys)
        removed.removeAll()
        backlog = false
        lastSent = 0
    }

    func stamp(_ frame: ARFrame) {
        for id in pendingStamp { lastChanged[id] = frame.timestamp * 1000 }
        pendingStamp.removeAll()
    }

    /// The next update to send, or nil if nothing is due.
    func nextUpdate(now: TimeInterval) -> (payload: [String: Any], changed: Int, vertices: Int, bytes: Int)? {
        guard !dirty.isEmpty || !removed.isEmpty, backlog || now - lastSent >= Self.interval else { return nil }
        lastSent = now
        var meshes: [[String: Any]] = []
        var bytes = 0, vertexCount = 0
        while let id = dirty.first {
            guard let anchor = anchors[id], let encoded = Self.encode(anchor) else {
                dirty.removeFirst()
                continue
            }
            // Always send at least one mesh, even if it alone exceeds the budget.
            if !meshes.isEmpty, bytes + encoded.bytes > Self.byteBudget { break }
            dirty.removeFirst()
            var mesh = encoded.mesh
            mesh["id"] = id.uuidString
            mesh["lastChanged"] = lastChanged[id] ?? now * 1000
            meshes.append(mesh)
            bytes += encoded.bytes
            vertexCount += encoded.vertices
        }
        backlog = !dirty.isEmpty
        let payload: [String: Any] = ["meshes": meshes, "removed": removed.map(\.uuidString)]
        removed.removeAll()
        return (payload, meshes.count, vertexCount, bytes)
    }

    private static func encode(_ anchor: ARMeshAnchor) -> (mesh: [String: Any], bytes: Int, vertices: Int)? {
        let geometry = anchor.geometry
        let source = geometry.vertices, faces = geometry.faces
        guard source.format == .float3, faces.indexCountPerPrimitive == 3 else { return nil }
        var vertices = Data(count: source.count * 12)
        vertices.withUnsafeMutableBytes { out in
            let base = source.buffer.contents() + source.offset
            if source.stride == 12 {
                out.copyMemory(from: UnsafeRawBufferPointer(start: base, count: source.count * 12))
            } else {
                for i in 0..<source.count {
                    (out.baseAddress! + i * 12).copyMemory(from: base + i * source.stride, byteCount: 12)
                }
            }
        }
        let indexCount = faces.count * 3
        var indices = Data(count: indexCount * 4)
        indices.withUnsafeMutableBytes { out in
            let base = faces.buffer.contents()
            if faces.bytesPerIndex == 4 {
                out.copyMemory(from: UnsafeRawBufferPointer(start: base, count: indexCount * 4))
            } else {
                let dst = out.bindMemory(to: UInt32.self)
                for i in 0..<indexCount { dst[i] = UInt32(base.load(fromByteOffset: i * 2, as: UInt16.self)) }
            }
        }
        let v64 = vertices.base64EncodedString(), i64 = indices.base64EncodedString()
        var mesh: [String: Any] = ["transform": anchor.transform.columnMajor, "vertices": v64, "indices": i64]
        if let label = semanticLabel(geometry) { mesh["semanticLabel"] = label }
        return (mesh, v64.utf8.count + i64.utf8.count, source.count)
    }

    /// Most common face classification (ignoring `.none`), as a WebXR semantic label.
    private static func semanticLabel(_ geometry: ARMeshGeometry) -> String? {
        guard let classification = geometry.classification, classification.format == .uchar else { return nil }
        var counts = [Int](repeating: 0, count: 256)
        let base = classification.buffer.contents() + classification.offset
        for i in 0..<classification.count {
            counts[Int(base.load(fromByteOffset: i * classification.stride, as: UInt8.self))] += 1
        }
        counts[Int(ARMeshClassification.none.rawValue)] = 0
        guard let best = counts.indices.max(by: { counts[$0] < counts[$1] }), counts[best] > 0,
              let kind = ARMeshClassification(rawValue: best) else { return nil }
        switch kind {
        case .wall: return "wall"
        case .floor: return "floor"
        case .ceiling: return "ceiling"
        case .table: return "table"
        case .seat: return "couch"
        case .window: return "window"
        case .door: return "door"
        default: return "other"
        }
    }
}

// MARK: - Bridge side

extension ARBridge {
    func pushMeshesIfNeeded(_ frame: ARFrame) {
        guard meshesRequested else { return }
        meshStreamer.stamp(frame)
        guard let update = meshStreamer.nextUpdate(now: frame.timestamp) else { return }
        call("onMeshes(update)", ["update": update.payload])
        print("[bridge] meshes sent n=\(update.changed) totalVerts=\(update.vertices) bytes=\(update.bytes)")
    }
}
