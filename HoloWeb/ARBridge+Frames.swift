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
        MainActor.assumeIsolated { self.push(frame) }
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
        }
    }

    nonisolated func sessionWasInterrupted(_ session: ARSession) {
        // Tracking state already reports the interruption per frame; the session resumes by itself.
        MainActor.assumeIsolated { print("[bridge] ARSession interrupted") }
    }

    nonisolated func sessionInterruptionEnded(_ session: ARSession) {
        MainActor.assumeIsolated {
            print("[bridge] ARSession interruption ended")
            self.planesDirty = true
            self.anchorsDirty = true
        }
    }

    private func markAnchorsChanged(_ anchors: [ARAnchor], removed: Bool) {
        for anchor in anchors {
            let id = anchor.identifier.uuidString
            if anchor is ARPlaneAnchor {
                planesDirty = true
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

    private func pushPlanesIfNeeded(_ frame: ARFrame, now: TimeInterval) {
        guard planesDirty, now - lastPlanesSent >= 0.1 else { return }
        planesDirty = false
        lastPlanesSent = now
        let planes: [[String: Any]] = frame.anchors.compactMap { $0 as? ARPlaneAnchor }.map { plane in
            let extent = plane.planeExtent
            let local = simd_float4x4(translation: plane.center) * simd_float4x4(yRotation: extent.rotationOnYAxis)
            return ["id": plane.identifier.uuidString,
                    "transform": (plane.transform * local).columnMajor,
                    "extent": [Double(extent.width), Double(extent.height)],
                    "orientation": plane.alignment == .horizontal ? "horizontal" : "vertical"]
        }
        call("onPlanes(planes)", ["planes": planes])
    }
}
