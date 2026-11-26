/** Vectors, quaternions, view-projection. Results go into the first argument, which may also be an input.
 *  Ship and camera axes: forward -Z, up +Y, right +X. */

export interface Vec3 { x: number; y: number; z: number }
export interface Quat { x: number; y: number; z: number; w: number }

export function v3(x = 0, y = 0, z = 0): Vec3 { return { x, y, z }; }
function set(o: Vec3, x: number, y: number, z: number): Vec3 { o.x = x; o.y = y; o.z = z; return o; }
export function copy(o: Vec3, a: Vec3): Vec3 { return set(o, a.x, a.y, a.z); }
export function add(o: Vec3, a: Vec3, b: Vec3): Vec3 { return set(o, a.x + b.x, a.y + b.y, a.z + b.z); }
export function sub(o: Vec3, a: Vec3, b: Vec3): Vec3 { return set(o, a.x - b.x, a.y - b.y, a.z - b.z); }
export function scale(o: Vec3, a: Vec3, s: number): Vec3 { return set(o, a.x * s, a.y * s, a.z * s); }
export function addScaled(o: Vec3, a: Vec3, b: Vec3, s: number): Vec3 { return set(o, a.x + b.x * s, a.y + b.y * s, a.z + b.z * s); }
export function dot(a: Vec3, b: Vec3): number { return a.x * b.x + a.y * b.y + a.z * b.z; }
export function cross(o: Vec3, a: Vec3, b: Vec3): Vec3 {
  return set(o, a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
}
export function len(a: Vec3): number { return Math.hypot(a.x, a.y, a.z); }
/** Unit length; zero stays zero. */
export function norm(o: Vec3, a: Vec3): Vec3 { return scale(o, a, 1 / (len(a) || 1)); }

function qSet(o: Quat, x: number, y: number, z: number, w: number): Quat { o.x = x; o.y = y; o.z = z; o.w = w; return o; }
/** Makes a new identity quaternion, or resets the one given. */
export function qIdentity(o: Quat = { x: 0, y: 0, z: 0, w: 1 }): Quat { return qSet(o, 0, 0, 0, 1); }
/** Right-handed turn of `rad` about `axis`. */
export function qAxisAngle(o: Quat, axis: Vec3, rad: number): Quat {
  const s = Math.sin(rad / 2) / (len(axis) || 1);
  return qSet(o, axis.x * s, axis.y * s, axis.z * s, Math.cos(rad / 2));
}
/** a * b: the turn b followed by the turn a. */
export function qMul(o: Quat, a: Quat, b: Quat): Quat {
  return qSet(o,
    a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z);
}
/** Unit length; zero becomes identity. */
export function qNorm(o: Quat, a: Quat): Quat {
  const l = Math.hypot(a.x, a.y, a.z, a.w);
  return l > 0 ? qSet(o, a.x / l, a.y / l, a.z / l, a.w / l) : qIdentity(o);
}
export function qRotate(o: Vec3, q: Quat, v: Vec3): Vec3 {
  // v + w*t + q.xyz x t, where t = 2 * (q.xyz x v)
  const tx = 2 * (q.y * v.z - q.z * v.y), ty = 2 * (q.z * v.x - q.x * v.z), tz = 2 * (q.x * v.y - q.y * v.x);
  return set(o,
    v.x + q.w * tx + q.y * tz - q.z * ty,
    v.y + q.w * ty + q.z * tx - q.x * tz,
    v.z + q.w * tz + q.x * ty - q.y * tx);
}
/** Quaternion of the rotation whose matrix columns are the given unit axes. */
export function qFromBasis(r: Vec3, u: Vec3, b: Vec3): Quat {
  const tr = r.x + u.y + b.z;
  let x: number, y: number, z: number, w: number;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    w = s / 4; x = (u.z - b.y) / s; y = (b.x - r.z) / s; z = (r.y - u.x) / s;
  } else if (r.x > u.y && r.x > b.z) {
    const s = Math.sqrt(1 + r.x - u.y - b.z) * 2;
    w = (u.z - b.y) / s; x = s / 4; y = (u.x + r.y) / s; z = (b.x + r.z) / s;
  } else if (u.y > b.z) {
    const s = Math.sqrt(1 + u.y - r.x - b.z) * 2;
    w = (b.x - r.z) / s; x = (u.x + r.y) / s; y = s / 4; z = (b.y + u.z) / s;
  } else {
    const s = Math.sqrt(1 + b.z - r.x - u.y) * 2;
    w = (r.y - u.x) / s; x = (b.x + r.z) / s; y = (b.y + u.z) / s; z = s / 4;
  }
  return qNorm({ x, y, z, w }, { x, y, z, w });
}
/** Shortest-way interpolation between unit quaternions. */
export function qSlerp(o: Quat, a: Quat, b: Quat, t: number): Quat {
  let c = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;
  const sign = c < 0 ? -1 : 1;
  c *= sign;
  let ka = 1 - t, kb = t;
  if (c < 0.9995) { // nearly equal turns use the straight blend, which avoids dividing by ~0
    const th = Math.acos(c), s = Math.sin(th);
    ka = Math.sin(ka * th) / s; kb = Math.sin(kb * th) / s;
  }
  kb *= sign;
  return qNorm(o, qSet(o, a.x * ka + b.x * kb, a.y * ka + b.y * kb, a.z * ka + b.z * kb, a.w * ka + b.w * kb));
}

const NEAR = 0.5;
/** Column-major perspective x camera rotation, no translation: pass positions relative to the camera.
 *  fovY is vertical, in radians. The far plane is at infinity; shaders write logarithmic depth. */
export function viewProj(out: Float32Array, camQ: Quat, fovY: number, aspect: number): Float32Array {
  const { x, y, z, w } = camQ;
  const fy = 1 / Math.tan(fovY / 2), fx = fy / aspect;
  // rows of the world-to-view rotation: the camera's right, up and back axes
  const rx = 1 - 2 * (y * y + z * z), ry = 2 * (x * y + w * z), rz = 2 * (x * z - w * y);
  const ux = 2 * (x * y - w * z), uy = 1 - 2 * (x * x + z * z), uz = 2 * (y * z + w * x);
  const bx = 2 * (x * z + w * y), by = 2 * (y * z - w * x), bz = 1 - 2 * (x * x + y * y);
  out[0] = fx * rx; out[1] = fy * ux; out[2] = -bx; out[3] = -bx;
  out[4] = fx * ry; out[5] = fy * uy; out[6] = -by; out[7] = -by;
  out[8] = fx * rz; out[9] = fy * uz; out[10] = -bz; out[11] = -bz;
  out[12] = 0; out[13] = 0; out[14] = -2 * NEAR; out[15] = 0;
  return out;
}
