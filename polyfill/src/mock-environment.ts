/**
 * Desktop mock data for plane detection and reflection maps (see mock-native.ts).
 * Planes: a floor that grows after the first update (lastChanged changes), a table-height octagon
 * and a wall facing the viewer, each with a plane-space polygon. Environment: 32x32 sky/ground
 * gradient cube faces in the native onEnvironment format.
 */
import { mat4 } from 'gl-matrix';
import type { NativePlaneData } from './hittest.js';
import type { NativeEnvironment } from './reflection.js';

const FLOOR_Y = -1.3;

function rect(w: number, d: number): number[] {
  return [-w / 2, 0, -d / 2, -w / 2, 0, d / 2, w / 2, 0, d / 2, w / 2, 0, -d / 2];
}

function octagon(r: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    out.push(Math.cos(a) * r, 0, -Math.sin(a) * r); // counter-clockwise seen from +Y
  }
  return out;
}

/** Mock plane set; `grown` enlarges the floor (a plane update with a new lastChanged). */
export function mockPlanes(grown: boolean, now: number): NativePlaneData[] {
  const floorSize = grown ? 10 : 8;
  const wall = mat4.fromTranslation(mat4.create(), [0, 0, -3]);
  mat4.rotateX(wall, wall, Math.PI / 2); // +Y (normal) towards the viewer
  return [
    {
      id: 'mock-floor',
      transform: Array.from(mat4.fromTranslation(mat4.create(), [0, FLOOR_Y, -1])),
      extent: [floorSize, floorSize],
      orientation: 'horizontal',
      polygon: rect(floorSize, floorSize),
      lastChanged: grown ? now : 0,
    },
    {
      id: 'mock-table',
      transform: Array.from(mat4.fromTranslation(mat4.create(), [0.6, -0.55, -1.4])),
      extent: [0.8, 0.8],
      orientation: 'horizontal',
      polygon: octagon(0.4),
      lastChanged: 0,
    },
    {
      id: 'mock-wall',
      transform: Array.from(wall),
      extent: [4, 2.5],
      orientation: 'vertical',
      polygon: rect(4, 2.5),
      lastChanged: 0,
    },
  ];
}

const SKY: [number, number, number] = [110, 170, 235];
const HORIZON: [number, number, number] = [225, 225, 215];
const GROUND: [number, number, number] = [95, 80, 60];

/** Colour for a direction's height (-1 ground .. +1 sky). */
function gradient(h: number, shift: number): [number, number, number] {
  const [a, b, t] = h >= 0 ? [HORIZON, SKY, h] : [HORIZON, GROUND, -h];
  return [0, 1, 2].map((c) => Math.round((a[c] + (b[c] - a[c]) * t) * shift)) as [number, number, number];
}

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

/** Cube faces +X -X +Y -Y +Z -Z (OpenGL orientation, row 0 = top); `shift` tints later maps. */
export function mockEnvironment(size = 32, shift = 1, timestamp = 0): NativeEnvironment {
  const faces: string[] = [];
  for (let face = 0; face < 6; face++) {
    const bytes = new Uint8Array(size * size * 4);
    for (let row = 0; row < size; row++) {
      // OpenGL cube faces: for the side faces t (row) runs from +Y (top) to -Y
      const t = ((row + 0.5) / size) * 2 - 1;
      for (let col = 0; col < size; col++) {
        const h = face === 2 ? 1 : face === 3 ? -1 : -t / Math.sqrt(1 + t * t);
        const [r, g, b] = gradient(h, shift);
        bytes.set([r, g, b, 255], (row * size + col) * 4);
      }
    }
    faces.push(toBase64(bytes));
  }
  return { size, format: 'rgba8', colorSpace: 'srgb', faces, timestamp };
}
