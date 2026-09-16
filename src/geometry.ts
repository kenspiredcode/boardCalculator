// Geometry primitives and rectilinear-polygon clipping used by the packer.
// All coordinates are in real-world units (the unit is decided by the UI).

export interface Pt {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface BBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Bounding box of a polygon (list of vertices). */
export function bbox(poly: Pt[]): BBox {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of poly) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

/** Signed area of a polygon (shoelace). Positive => counter-clockwise. */
export function signedArea(poly: Pt[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

export function polygonArea(poly: Pt[]): number {
  return Math.abs(signedArea(poly));
}

/**
 * Clip a subject rectangle against a (possibly concave) polygon using the
 * Sutherland–Hodgman algorithm, extended to clip against every edge of the
 * clip polygon. This is exact for convex clip regions; for concave regions it
 * over-includes across reflex vertices, so we additionally intersect using a
 * per-edge approach only valid for convex. For our rectilinear floorplans we
 * decompose concave polygons into convex pieces (see decomposeToConvex) before
 * calling this, so the input `clip` here is always convex.
 */
export function clipRectToConvex(rect: Rect, clip: Pt[]): Pt[] {
  let output: Pt[] = [
    { x: rect.x, y: rect.y },
    { x: rect.x + rect.w, y: rect.y },
    { x: rect.x + rect.w, y: rect.y + rect.h },
    { x: rect.x, y: rect.y + rect.h },
  ];

  // Ensure clip polygon is counter-clockwise so "inside" is consistent.
  const ccw = signedArea(clip) > 0 ? clip : [...clip].reverse();

  for (let i = 0; i < ccw.length; i++) {
    if (output.length === 0) break;
    const a = ccw[i];
    const b = ccw[(i + 1) % ccw.length];
    // Edge normal points to the interior (left of a->b for CCW).
    const input = output;
    output = [];
    for (let j = 0; j < input.length; j++) {
      const cur = input[j];
      const prev = input[(j + input.length - 1) % input.length];
      const curIn = isInside(cur, a, b);
      const prevIn = isInside(prev, a, b);
      if (curIn) {
        if (!prevIn) output.push(intersect(prev, cur, a, b));
        output.push(cur);
      } else if (prevIn) {
        output.push(intersect(prev, cur, a, b));
      }
    }
  }
  return output;
}

// Is point p on the interior side of directed edge a->b (left side, for CCW)?
function isInside(p: Pt, a: Pt, b: Pt): boolean {
  return (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x) >= -1e-9;
}

function intersect(p1: Pt, p2: Pt, a: Pt, b: Pt): Pt {
  const a1 = b.y - a.y;
  const b1 = a.x - b.x;
  const c1 = a1 * a.x + b1 * a.y;
  const a2 = p2.y - p1.y;
  const b2 = p1.x - p2.x;
  const c2 = a2 * p1.x + b2 * p1.y;
  const det = a1 * b2 - a2 * b1;
  if (Math.abs(det) < 1e-12) return p1;
  return {
    x: (b2 * c1 - b1 * c2) / det,
    y: (a1 * c2 - a2 * c1) / det,
  };
}

/**
 * Decompose a rectilinear (or general simple) polygon into convex pieces via
 * ear-clipping triangulation. Triangles are convex, which is all the packer's
 * clipper needs. Returns a list of triangles (each a Pt[3]).
 */
export function triangulate(poly: Pt[]): Pt[][] {
  const pts = signedArea(poly) > 0 ? [...poly] : [...poly].reverse();
  const n = pts.length;
  if (n < 3) return [];
  const idx = pts.map((_, i) => i);
  const tris: Pt[][] = [];
  let guard = 0;
  while (idx.length > 3 && guard++ < 10000) {
    let clipped = false;
    for (let i = 0; i < idx.length; i++) {
      const i0 = idx[(i + idx.length - 1) % idx.length];
      const i1 = idx[i];
      const i2 = idx[(i + 1) % idx.length];
      const a = pts[i0];
      const b = pts[i1];
      const c = pts[i2];
      if (isEar(a, b, c, pts, idx)) {
        tris.push([a, b, c]);
        idx.splice(i, 1);
        clipped = true;
        break;
      }
    }
    if (!clipped) break; // degenerate; bail out with what we have
  }
  if (idx.length === 3) {
    tris.push([pts[idx[0]], pts[idx[1]], pts[idx[2]]]);
  }
  return tris;
}

function isEar(a: Pt, b: Pt, c: Pt, pts: Pt[], idx: number[]): boolean {
  // Convex vertex? (CCW winding => cross > 0)
  const cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  if (cross <= 0) return false;
  // No other vertex inside triangle abc.
  for (const k of idx) {
    const p = pts[k];
    if (p === a || p === b || p === c) continue;
    if (pointInTri(p, a, b, c)) return false;
  }
  return true;
}

function pointInTri(p: Pt, a: Pt, b: Pt, c: Pt): boolean {
  const d1 = sign(p, a, b);
  const d2 = sign(p, b, c);
  const d3 = sign(p, c, a);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

function sign(p: Pt, a: Pt, b: Pt): number {
  return (p.x - b.x) * (a.y - b.y) - (a.x - b.x) * (p.y - b.y);
}

/** Area of a clipped polygon fragment. */
export function fragmentArea(frag: Pt[]): number {
  return polygonArea(frag);
}
