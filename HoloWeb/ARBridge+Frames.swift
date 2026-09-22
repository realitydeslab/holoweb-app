// SPDX-FileCopyrightText: Copyright 2026 Reality Design Lab <dev@reality.design>
// SPDX-License-Identifier: MIT

import ARKit
import UIKit

// MARK: - Camera/content sync

extension ARBridge {
    /// The frame whose camera image the renderer should draw: the one matching the page's last
    /// rendered pose when the page reports it, otherwise nil (renderer uses the newest frame).
    var displayFrame: ARFrame? {
        guard streaming, let t = renderedTimestamp else { return nil }
        return recentFrames.last { $0.timestamp * 1000 <= t + 0.5 } ?? recentFrames.first
    }
}

// MARK: - ARSessionDelegate (delegateQueue is nil, so callbacks arrive on the main queue)

extension ARBridge: ARSessionDelegate {
    nonisolated func session(_ session: ARSession, didUpdate frame: ARFrame) {
        nonisolated(unsafe) let frame = frame
        MainActor.assumeIsolated {
            self.stampPlaneUpdates(frame)
            self.push(frame)
        }
    }

    nonisolated func session(_ session: ARSession, didAdd anchors: [ARAnchor]) {
        nonisolated(unsafe) let anchors = anchors
        MainActor.assumeIsolated { self.markAnchorsChanged(anchors, removed: false) }
    }

    nonisolated func session(_ session: ARSession, didUpdate anchors: [ARAnchor]) {
        nonisolated(unsafe) let anchors = anchors
        MainActor.assumeIsolated { self.markAnchorsChanged(anchors, removed: false) }
    }

    nonisolated func session(_ session: ARSession, didRemove anchors: [ARAnchor]) {
        nonisolated(unsafe) let anchors = anchors
        MainActor.assumeIsolated { self.markAnchorsChanged(anchors, removed: true) }
    }

    nonisolated func session(_ session: ARSession, didFailWithError error: any Error) {
        let message = error.localizedDescription
        MainActor.assumeIsolated {
            print("[bridge] ARSession failed: \(message)")
            self.state?.markARStopped()
            self.endSessionFromNative(reason: "failed: \(message)")
            self.state?.xrSessionEnded()
        }
    }

    nonisolated func sessionWasInterrupted(_ session: ARSession) {
        // Tracking state already reports the interruption per frame; the session resumes by itself.
        MainActor.assumeIsolated {
            print("[bridge] ARSession interrupted")
            self.setVisibility("hidden")
        }
    }

    nonisolated func sessionInterruptionEnded(_ session: ARSession) {
        MainActor.assumeIsolated {
            print("[bridge] ARSession interruption ended")
            self.setVisibility("visible")
            self.planesDirty = true
            self.anchorsDirty = true
        }
    }

    private func markAnchorsChanged(_ anchors: [ARAnchor], removed: Bool) {
        for anchor in anchors {
            let id = anchor.identifier.uuidString
            if anchor is ARPlaneAnchor {
                planesDirty = true
                if removed {
                    pendingPlaneUpdates.remove(anchor.identifier)
                    planeLastChanged.removeValue(forKey: anchor.identifier)
                } else {
                    pendingPlaneUpdates.insert(anchor.identifier)
                }
            } else if let mesh = anchor as? ARMeshAnchor {
                if removed { meshStreamer.remove(mesh) } else { meshStreamer.update(mesh) }
            } else if let probe = anchor as? AREnvironmentProbeAnchor {
                if removed {
                    environmentProbes.removeValue(forKey: probe.identifier)
                } else {
                    environmentProbes[probe.identifier] = probe
                    environmentDirty = true
                }
            } else if pageAnchors[id] != nil {
                anchorsDirty = true
                if removed {
                    pageAnchors.removeValue(forKey: id)
                    removedAnchorIDs.insert(id)
                }
            }
        }
    }

    private func push(_ frame: ARFrame) {
        guard pageReady, streaming, let state else { return }
        logStats(frame)
        if framesInFlight >= Self.maxFramesInFlight {
            framesSkipped += 1
            return
        }
        let orientation = webView.window?.windowScene?.effectiveGeometry.interfaceOrientation ?? .portrait
        let size = webView.bounds.size
        guard size.width > 0, size.height > 0 else { return }
        let camera = frame.camera
        let view = camera.viewMatrix(for: orientation)
        let proj = camera.projectionMatrix(for: orientation, viewportSize: size, zNear: 0.01, zFar: 1000)
        var light: Any = NSNull()
        if let estimate = frame.lightEstimate {
            light = ["ambientIntensity": Double(estimate.ambientIntensity),
                     "ambientColorTemperature": Double(estimate.ambientColorTemperature)]
        }
        framesInFlight += 1
        recentFrames.append(frame)
        if recentFrames.count > Self.recentFrameLimit { recentFrames.removeFirst() }
        framesPushed += 1
        call("onFrame(t, mode, transform, view, proj, light, tracking, orientation, sentAt)", [
            "t": frame.timestamp * 1000,
            "mode": state.mode.rawValue,
            "transform": view.inverse.columnMajor,
            "view": view.columnMajor,
            "proj": proj.columnMajor,
            "light": light,
            "tracking": camera.trackingState.bridgeName,
            "orientation": orientation.bridgeName,
            "sentAt": Date().timeIntervalSince1970 * 1000,
        ]) { [weak self] in
            guard let self else { return }
            self.framesInFlight = max(0, self.framesInFlight - 1)
        }
        pushAnchorsIfNeeded(now: frame.timestamp)
        pushPlanesIfNeeded(frame, now: frame.timestamp)
        pushEnvironmentIfNeeded(frame)
        pushHandsIfNeeded(frame)
        pushMeshesIfNeeded(frame)
        pushImagesIfNeeded(frame)
    }

    private func logStats(_ frame: ARFrame) {
        statsFrames += 1
        if lastStatsTime == 0 { lastStatsTime = frame.timestamp }
        let elapsed = frame.timestamp - lastStatsTime
        guard elapsed >= 2 else { return }
        let fps = session.configuration?.videoFormat.framesPerSecond ?? 0
        print(String(format: "[bridge] ARKit %.1f fps (format %d), pushed %d, skipped %d",
                     Double(statsFrames) / elapsed, fps, framesPushed, framesSkipped))
        statsFrames = 0
        lastStatsTime = frame.timestamp
    }

    private func pushAnchorsIfNeeded(now: TimeInterval) {
        guard anchorsDirty, now - lastAnchorsSent >= 0.1 else { return }
        anchorsDirty = false
        lastAnchorsSent = now
        var anchors: [[String: Any]] = pageAnchors.map { id, anchor in
            // The stored object is the one we added; ARKit's updated copy carries the tracked pose.
            let tracked = session.currentFrame?.anchors.first { $0.identifier == anchor.identifier } ?? anchor
            return ["id": id, "transform": tracked.transform.columnMajor]
        }
        anchors += removedAnchorIDs.map { ["id": $0, "transform": NSNull()] }
        removedAnchorIDs.removeAll()
        call("onAnchors(anchors)", ["anchors": anchors])
    }

    /// Anchor callbacks for a frame arrive before `didUpdate frame`, so the frame's timestamp
    /// is the time of those updates.
    private func stampPlaneUpdates(_ frame: ARFrame) {
        guard !pendingPlaneUpdates.isEmpty else { return }
        for id in pendingPlaneUpdates { planeLastChanged[id] = frame.timestamp * 1000 }
        pendingPlaneUpdates.removeAll()
    }

    private func pushPlanesIfNeeded(_ frame: ARFrame, now: TimeInterval) {
        guard planesDirty, now - lastPlanesSent >= 0.1 else { return }
        planesDirty = false
        lastPlanesSent = now
        var vertexCount = 0
        let planes: [[String: Any]] = frame.anchors.compactMap { $0 as? ARPlaneAnchor }.map { plane in
            let extent = plane.planeExtent
            let local = simd_float4x4(translation: plane.center) * simd_float4x4(yRotation: extent.rotationOnYAxis)
            let (polygon, reversed) = Self.polygon(plane.geometry.boundaryVertices, relativeTo: local)
            if !loggedPlaneWinding, !polygon.isEmpty {
                loggedPlaneWinding = true
                print("[bridge] ARKit plane boundary winding seen from +Y: \(reversed ? "clockwise (reversed)" : "counter-clockwise")")
            }
            vertexCount += polygon.count / 3
            return ["id": plane.identifier.uuidString,
                    "transform": (plane.transform * local).columnMajor,
                    "extent": [Double(extent.width), Double(extent.height)],
                    "orientation": plane.alignment == .horizontal ? "horizontal" : "vertical",
                    "polygon": polygon,
                    "lastChanged": planeLastChanged[plane.identifier] ?? frame.timestamp * 1000]
        }
        if now - lastPlanesLog >= 2 {
            lastPlanesLog = now
            print("[bridge] planes sent n=\(planes.count) polygons=\(vertexCount)")
        }
        call("onPlanes(planes)", ["planes": planes])
    }

    /// Boundary vertices (anchor space) re-expressed in the sent plane frame `local`, flattened
    /// to x,y,z with y = 0 and wound counter-clockwise seen from +Y. The winding is measured
    /// rather than assumed, so it holds whatever order ARKit uses.
    static func polygon(_ boundary: [simd_float3], relativeTo local: simd_float4x4) -> (vertices: [Double], reversed: Bool) {
        let inverse = local.inverse
        var points = boundary.map { v -> simd_float2 in
            let p = inverse * simd_float4(v, 1)
            return simd_float2(p.x, p.z)
        }
        guard points.count >= 3 else { return ([], false) }
        // y component of sum(p_i x p_i+1) with p = (x, 0, z): positive means CCW about +Y.
        var twiceArea: Float = 0
        for i in points.indices {
            let a = points[i], b = points[(i + 1) % points.count]
            twiceArea += a.y * b.x - a.x * b.y
        }
        if twiceArea < 0 { points.reverse() }
        return (points.flatMap { [Double($0.x), 0, Double($0.y)] }, twiceArea < 0)
    }
}
