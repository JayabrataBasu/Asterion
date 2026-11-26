/** What can be left out of a picture without looking. */
import { type Vec3, dot, len } from './math';

/** Whether a sphere at view-space `p` (camera looking along -Z) can reach the view. */
export function inView(p: Vec3, r: number, tanY: number, aspect: number, near: number): boolean {
  if (-p.z + r < near) return false;
  const tanX = tanY * aspect, kx = 1 / Math.hypot(1, tanX), ky = 1 / Math.hypot(1, tanY);
  if ((p.x + tanX * p.z) * kx > r || (-p.x + tanX * p.z) * kx > r) return false;
  return !((p.y + tanY * p.z) * ky > r || (-p.y + tanY * p.z) * ky > r);
}

/** Whether a sphere at `p` (relative to the camera) is wholly hidden behind a planet sphere of radius `R` centred at
 *  `planet` (also relative to the camera): beyond the horizon plane and inside the cone the sphere shades. */
export function beyondHorizon(p: Vec3, r: number, planet: Vec3, R: number): boolean {
  const D = len(planet), pl = len(p);
  if (D <= R || pl <= r) return false;
  const along = (D * D - dot(p, planet)) / D; // of p - planet, along the planet-to-camera direction
  if (along + r >= R * R / D) return false;
  const angle = Math.acos(Math.max(-1, Math.min(1, dot(p, planet) / (pl * D))));
  return angle + Math.asin(Math.min(1, r / pl)) < Math.asin(R / D);
}
