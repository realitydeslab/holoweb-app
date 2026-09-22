/**
 * One Euro filter (Casiez, Roussel, Vogel, CHI 2012) for 3D points: a low-pass filter whose cutoff
 * rises with speed, so a still hand stops jittering and a moving one keeps little lag.
 *   alpha(fc, dt) = 1 / (1 + 1 / (2 pi fc dt))
 *   dx^  = lowpass(|x - x_prev| / dt, dCutoff)   (speed, m/s)
 *   fc   = minCutoff + beta * dx^
 *   x^   = lowpass(x, fc)
 * One cutoff for all three axes (from the speed magnitude), so the filter does not bend a straight motion.
 */
export interface OneEuroParams {
  /** Hz. Lower = smoother at rest. */
  minCutoff: number;
  /** Hz per m/s. Higher = less lag when moving. */
  beta: number;
  /** Hz, for the speed estimate. */
  dCutoff: number;
}

/** Hand joints (hand-tracking spec defaults, metres and seconds); tune on device. */
export const HAND_FILTER: OneEuroParams = { minCutoff: 1.5, beta: 2.0, dCutoff: 1.0 };
/** Joints whose depth was inferred (depthValid bit clear): smoother. */
export const HAND_FILTER_INFERRED: OneEuroParams = { minCutoff: 0.7, beta: 2.0, dCutoff: 1.0 };

const alpha = (cutoff: number, dt: number) => 1 / (1 + 1 / (2 * Math.PI * cutoff * dt));

export class OneEuro3 {
  private x: [number, number, number] | null = null;
  private speed = 0;

  /** Filter a sample taken `dt` seconds after the previous one; returns the filtered point. */
  filter(p: ArrayLike<number>, dt: number, params: OneEuroParams): [number, number, number] {
    const cur: [number, number, number] = [p[0], p[1], p[2]];
    if (this.x === null || !(dt > 0)) {
      this.x = cur;
      this.speed = 0;
      return cur;
    }
    const prev = this.x;
    const raw = Math.hypot(cur[0] - prev[0], cur[1] - prev[1], cur[2] - prev[2]) / dt;
    this.speed += alpha(params.dCutoff, dt) * (raw - this.speed);
    const a = alpha(params.minCutoff + params.beta * this.speed, dt);
    this.x = [prev[0] + a * (cur[0] - prev[0]), prev[1] + a * (cur[1] - prev[1]), prev[2] + a * (cur[2] - prev[2])];
    return this.x;
  }

  reset(): void {
    this.x = null;
    this.speed = 0;
  }
}
