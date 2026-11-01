// SPDX-FileCopyrightText: Copyright 2026 Reality Design Lab <dev@reality.design>
// SPDX-License-Identifier: MIT

import ARKit
import UIKit

extension simd_float4x4 {
    /// Column-major flattening, the layout WebXR and gl-matrix expect.
    var columnMajor: [Double] {
        [columns.0, columns.1, columns.2, columns.3].flatMap { [Double($0.x), Double($0.y), Double($0.z), Double($0.w)] }
    }

    init(columnMajor m: [Double]) {
        let f = m.map(Float.init)
        self.init(columns: (simd_float4(f[0], f[1], f[2], f[3]), simd_float4(f[4], f[5], f[6], f[7]),
                            simd_float4(f[8], f[9], f[10], f[11]), simd_float4(f[12], f[13], f[14], f[15])))
    }

    init(translation t: simd_float3) {
        self = matrix_identity_float4x4
        columns.3 = simd_float4(t.x, t.y, t.z, 1)
    }

    init(yRotation angle: Float) {
        let c = cos(angle), s = sin(angle)
        self.init(columns: (simd_float4(c, 0, -s, 0), simd_float4(0, 1, 0, 0),
                            simd_float4(s, 0, c, 0), simd_float4(0, 0, 0, 1)))
    }
}

extension ARCamera.TrackingState {
    var bridgeName: String {
        switch self {
        case .normal: "normal"
        case .limited: "limited"
        case .notAvailable: "notAvailable"
        }
    }
}

extension UIInterfaceOrientation {
    /// ARKit's view rotation angle (iOS 27) for this interface orientation: the clockwise rotation, in
    /// degrees, that keeps the camera image level (0 landscapeRight, 90 portrait, 180 landscapeLeft,
    /// 270 portraitUpsideDown). Derived from the interface, not `ARSession.viewRotationAngle`, because
    /// rendering must match the web view's (possibly locked) orientation rather than the device's.
    var viewRotationAngle: CGFloat {
        switch self {
        case .landscapeRight: 0
        case .landscapeLeft: 180
        case .portraitUpsideDown: 270
        default: 90
        }
    }

    var bridgeName: String {
        switch self {
        case .portraitUpsideDown: "portraitUpsideDown"
        case .landscapeLeft: "landscapeLeft"
        case .landscapeRight: "landscapeRight"
        default: "portrait"
        }
    }
}

/// Screen facts the polyfill needs to place HoloKit viewports in physical units.
struct DeviceInfo {
    let model: String
    let screenWidthPx: Double
    let screenHeightPx: Double
    let scale: Double
    let dpi: Double

    /// Pixels per inch by model identifier. All current Pro iPhones are 460 ppi.
    private static let dpiTable: [String: Double] = [
        "iPhone16,1": 460, "iPhone16,2": 460, "iPhone17,1": 460, "iPhone17,2": 460,
        "iPhone18,1": 460, "iPhone18,2": 460,
    ]

    /// The phone model and the screen that shows `view` (the web view), falling back to the first
    /// connected window scene's screen before the view is in a window.
    @MainActor static func current(for view: UIView) -> DeviceInfo {
        var system = utsname()
        uname(&system)
        let model = withUnsafeBytes(of: &system.machine) { raw in
            String(decoding: raw.prefix { $0 != 0 }, as: UTF8.self)
        }
        let screen = view.window?.windowScene?.screen
            ?? UIApplication.shared.connectedScenes.compactMap { ($0 as? UIWindowScene)?.screen }.first
        guard let screen else {
            return DeviceInfo(model: model, screenWidthPx: 0, screenHeightPx: 0, scale: 1, dpi: dpiTable[model] ?? 460)
        }
        return DeviceInfo(model: model,
                          screenWidthPx: Double(screen.nativeBounds.width),
                          screenHeightPx: Double(screen.nativeBounds.height),
                          scale: Double(screen.nativeScale),
                          dpi: dpiTable[model] ?? 460)
    }

    var dictionary: [String: Any] {
        ["model": model, "screenWidthPx": screenWidthPx, "screenHeightPx": screenHeightPx,
         "scale": scale, "dpi": dpi]
    }
}
