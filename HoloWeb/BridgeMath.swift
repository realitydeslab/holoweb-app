// SPDX-FileCopyrightText: Copyright 2026 Reality Design Lab <dev@reality.design>
// SPDX-License-Identifier: MIT

import ARKit
import UIKit

extension simd_float4x4 {
    /// Column-major flattening, the layout WebXR and gl-matrix expect.
    var columnMajor: [Double] {
        [columns.0, columns.1, columns.2, columns.3].flatMap { [Double($0.x), Double($0.y), Double($0.z), Double($0.w)] }
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

    @MainActor static var current: DeviceInfo {
        var system = utsname()
        uname(&system)
        let model = withUnsafeBytes(of: &system.machine) { raw in
            String(decoding: raw.prefix { $0 != 0 }, as: UTF8.self)
        }
        let screen = UIScreen.main
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
