/**
 * iOS phone table for HoloKit stereo rendering.
 *
 * Ported from holokit-unity-sdk Assets/ScriptableObjects/iOSPhoneModelList.asset
 * (PhoneModelSpecs in Runtime/DeviceProfile.cs). Units: metres, dpi.
 *
 * `screenResolution` is the asset's ScreenResolution: [0, 0] means "use the
 * runtime screen size", exactly as the Unity SDK does. `nativeResolution` is not
 * in the asset; it is Apple's published native pixel resolution (landscape,
 * long side first) and is used only for the nearest-screen fallback lookup.
 */

export type Vec3 = readonly [number, number, number];

export interface PhoneModel {
  readonly identifier: string;
  readonly description: string;
  /** Asset ScreenResolution in pixels, [0, 0] = use runtime screen size. */
  readonly screenResolution: readonly [number, number];
  readonly screenDpi: number;
  readonly viewportBottomOffset: number;
  /** Unity camera-local (x right, y up, z forward) offset from phone camera to screen bottom centre. */
  readonly cameraOffset: Vec3;
  readonly screenBottomBorder: number;
  /** Apple native resolution [long, short] in pixels (not from the asset). */
  readonly nativeResolution: readonly [number, number];
  /** True when the entry is not in the HoloKit asset and was estimated. */
  readonly estimated?: boolean;
}

type Row = [string, string, number, number, number, number, Vec3, number, number, number, number];

// identifier, description, resX, resY, dpi, viewportBottomOffset, cameraOffset, screenBottomBorder, nativeW, nativeH, estimated(0/1)
const ROWS: Row[] = [
  ['iPhone11,2', 'iPhone XS', 0, 0, 458, 0, [0.05986, -0.055215, -0.0091], 0.00391, 2436, 1125, 0],
  ['iPhone11,4', 'iPhone XS Max', 0, 0, 458, 0, [0.06694, -0.09405, -0.00591], 0.00391, 2688, 1242, 0],
  ['iPhone11,6', 'iPhone XS Max', 0, 0, 458, 0, [0.06694, -0.09405, -0.00591], 0.00391, 2688, 1242, 0],
  ['iPhone12,1', 'iPhone 11', 0, 0, 326, 0, [0.059955, -0.05932, -0.00591], 0.00452, 1792, 828, 0],
  ['iPhone12,3', 'iPhone 11 Pro', 0, 0, 458, 0, [0.059955, -0.05932, -0.00591], 0.00452, 2436, 1125, 0],
  ['iPhone12,5', 'iPhone 11 Pro Max', 0, 0, 458, 0, [0.066935, -0.0658, -0.00591], 0.00452, 2688, 1242, 0],
  ['iPhone13,2', 'iPhone 12', 0, 0, 460, 0, [0.060625, -0.05879, -0.00633], 0.00347, 2532, 1170, 0],
  ['iPhone13,3', 'iPhone 12 Pro', 0, 0, 460, 0, [0.061195, -0.05936, -0.00551], 0.00347, 2532, 1170, 0],
  ['iPhone13,4', 'iPhone 12 Pro Max', 0, 0, 458, 0, [0.04952, -0.06464, -0.00591], 0.00347, 2778, 1284, 0],
  ['iPhone14,5', 'iPhone 13', 0, 0, 460, 0, [0.06147, -0.05964, -0.00781], 0.00347, 2532, 1170, 0],
  ['iPhone14,2', 'iPhone 13 Pro', 0, 0, 460, 0, [0.042005, -0.05809, -0.00727], 0.00347, 2532, 1170, 0],
  ['iPhone14,3', 'iPhone 13 Pro Max', 0, 0, 458, 0, [0.04907, -0.06464, -0.00727], 0.00347, 2778, 1284, 0],
  ['iPhone14,7', 'iPhone 14', 0, 0, 460, 0, [0.061475, -0.05964, -0.00848], 0.00347, 2532, 1170, 0],
  ['iPhone14,8', 'iPhone 14 Plus', 0, 0, 458, 0, [0.06787, -0.06552, -0.00851], 0.00347, 2778, 1284, 0],
  ['iPhone15,2', 'iPhone 14 Pro', 0, 0, 460, 0, [0.04021, -0.05717, -0.00784], 0.003185, 2556, 1179, 0],
  ['iPhone15,3', 'iPhone 14 Pro Max', 0, 0, 460, 0, [0.046835, -0.0633, -0.0078], 0.003185, 2796, 1290, 0],
  ['iPhone15,4', 'iPhone 15', 2556, 1179, 460, 0, [0.04818, -0.042715, -0.0069], 0.003275, 2556, 1179, 0],
  ['iPhone15,5', 'iPhone 15 Plus', 2796, 1290, 460, 0, [0.054805, -0.048845, -0.0069], 0.003275, 2796, 1290, 0],
  ['iPhone16,1', 'iPhone 15 Pro', 2556, 1179, 460, 0, [0.039895, -0.03254, -0.00759], 0.00276, 2556, 1179, 0],
  ['iPhone16,2', 'iPhone 15 Pro Max', 2796, 1290, 460, 0, [0.04652, -0.0598, -0.00773], 0.00276, 2796, 1290, 0],
  ['iPhone17,3', 'iPhone 16', 2556, 1179, 460, 0, [0.04818, -0.042715, -0.0069], 0.003275, 2556, 1179, 0],
  ['iPhone17,4', 'iPhone 16 Plus', 2796, 1290, 460, 0, [0.054805, -0.048845, -0.0069], 0.003275, 2796, 1290, 0],
  ['iPhone17,1', 'iPhone 16 Pro', 2622, 1206, 460, 0, [0.039895, -0.03254, -0.00759], 0.00276, 2622, 1206, 0],
  ['iPhone17,2', 'iPhone 16 Pro Max', 2868, 1320, 460, 0, [0.04652, -0.0598, -0.00773], 0.00276, 2868, 1320, 0],
];

export const PHONES: readonly PhoneModel[] = ROWS.map(
  ([identifier, description, resX, resY, dpi, vbo, cameraOffset, sbb, nw, nh, est]) => ({
    identifier,
    description,
    screenResolution: [resX, resY] as const,
    screenDpi: dpi,
    viewportBottomOffset: vbo,
    cameraOffset,
    screenBottomBorder: sbb,
    nativeResolution: [nw, nh] as const,
    ...(est ? { estimated: true } : {}),
  }),
);

/** Unity SDK default (DeviceProfile.GetDefaultPhoneModel): iPhone 13 Pro. */
export const DEFAULT_PHONE_ID = 'iPhone14,2';

export interface PhoneLookup {
  readonly phone: PhoneModel;
  /** 'exact' identifier match, 'nearest' screen-size match, or 'default'. */
  readonly match: 'exact' | 'nearest' | 'default';
}

/**
 * Find the phone entry for an identifier such as 'iPhone16,1'. Unknown models
 * fall back to the entry with the closest native resolution, then to the SDK default.
 */
export function lookupPhone(identifier: string | undefined, screenPx?: { w: number; h: number }): PhoneLookup {
  const exact = PHONES.find((p) => p.identifier === identifier);
  if (exact) return { phone: exact, match: 'exact' };
  if (screenPx && screenPx.w > 0 && screenPx.h > 0) {
    const long = Math.max(screenPx.w, screenPx.h);
    const short = Math.min(screenPx.w, screenPx.h);
    let best: PhoneModel | undefined;
    let bestErr = Infinity;
    for (const p of PHONES) {
      const err = Math.abs(p.nativeResolution[0] - long) + Math.abs(p.nativeResolution[1] - short);
      // later (newer) entries win ties, which matches newer optics tables
      if (err <= bestErr) {
        best = p;
        bestErr = err;
      }
    }
    if (best) return { phone: best, match: 'nearest' };
  }
  const fallback = PHONES.find((p) => p.identifier === DEFAULT_PHONE_ID) as PhoneModel;
  return { phone: fallback, match: 'default' };
}
