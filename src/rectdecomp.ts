// Rectilinear geometry helpers for the offcut engine: decompose an axis-aligned
// region (given as a set of covered fragments inside a bounding rectangle, or as
// its complement) into a set of maximal non-overlapping axis-aligned rectangles.
//
// Approach: rasterize onto the coordinate lattice formed by all fragment edge
// x/y values (a "generalized grid"), mark which lattice cells are inside the
// region, then greedily merge inside-cells into maximal rectangles. This is
// exact for rectilinear regions (all our sheets and clips are axis-aligned) and
// robust for concave/L/T/U shapes. Cell counts stay tiny (a sheet clips into a
// handful of edges), so the O(cells) cost is negligible.

import type { Pt } from "./geometry";

export interface DRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const EPS = 1e-6;

/** Unique sorted coordinate list with near-duplicates merged. */
function uniqSorted(vals: number[]): number[] {
  const s = [...vals].sort((a, b) => a - b);
  const out: number[] = [];
  for (const v of s) {
    if (out.length === 0 || Math.abs(v - out[out.length - 1]) > EPS) out.push(v);
  }
  return out;
}

/** Is point inside/on any of the given (convex) fragment polygons? */
function pointCovered(x: number, y: number, frags: Pt[][]): boolean {
  for (const f of frags) if (pointInPoly(x, y, f)) return true;
  return false;
}

// Standard ray-cast point-in-polygon, inclusive of the boundary.
function pointInPoly(x: number, y: number, poly: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x,
      yi = poly[i].y;
    const xj = poly[j].x,
      yj = poly[j].y;
    // Boundary check.
    if (
      Math.abs((yj - yi) * (x - xi) - (xj - xi) * (y - yi)) < EPS &&
      x >= Math.min(xi, xj) - EPS &&
      x <= Math.max(xi, xj) + EPS &&
      y >= Math.min(yi, yj) - EPS &&
      y <= Math.max(yi, yj) + EPS
    )
      return true;
    const intersects =
      yi > y !== yj > y &&
      x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

/**
 * Decompose the area covered by `frags` (all axis-aligned, lying within some
 * bounding rect) into maximal axis-aligned rectangles.
 */
export function coveredToRects(frags: Pt[][]): DRect[] {
  if (frags.length === 0) return [];
  const xsAll: number[] = [];
  const ysAll: number[] = [];
  for (const f of frags)
    for (const p of f) {
      xsAll.push(p.x);
      ysAll.push(p.y);
    }
  return latticeToRects(uniqSorted(xsAll), uniqSorted(ysAll), (cx, cy) =>
    pointCovered(cx, cy, frags)
  );
}

/**
 * Decompose the leftover of a full sheet rectangle (fullRect) after removing the
 * covered `frags` into maximal rectangles. This is what a cut board's offcut is.
 */
export function leftoverToRects(fullRect: DRect, frags: Pt[][]): DRect[] {
  const xs = uniqSorted([
    fullRect.x,
    fullRect.x + fullRect.w,
    ...frags.flatMap((f) => f.map((p) => p.x)),
  ]).filter((v) => v >= fullRect.x - EPS && v <= fullRect.x + fullRect.w + EPS);
  const ys = uniqSorted([
    fullRect.y,
    fullRect.y + fullRect.h,
    ...frags.flatMap((f) => f.map((p) => p.y)),
  ]).filter((v) => v >= fullRect.y - EPS && v <= fullRect.y + fullRect.h + EPS);
  // A cell is "leftover" if it is inside the full rect but NOT covered.
  return latticeToRects(xs, ys, (cx, cy) => !pointCovered(cx, cy, frags));
}

/**
 * Core: given lattice lines xs, ys and a predicate telling whether a cell's
 * centre is "in", greedily merge in-cells into maximal rectangles. Greedy
 * horizontal-run then vertical-extend merge; produces few rectangles for the
 * simple shapes here.
 */
function latticeToRects(
  xs: number[],
  ys: number[],
  isIn: (cx: number, cy: number) => boolean
): DRect[] {
  const nx = xs.length - 1;
  const ny = ys.length - 1;
  if (nx <= 0 || ny <= 0) return [];

  // cell[i][j] inside?  i over x (0..nx-1), j over y (0..ny-1)
  const cell: boolean[][] = [];
  for (let i = 0; i < nx; i++) {
    cell[i] = [];
    const cx = (xs[i] + xs[i + 1]) / 2;
    for (let j = 0; j < ny; j++) {
      const cy = (ys[j] + ys[j + 1]) / 2;
      cell[i][j] = isIn(cx, cy);
    }
  }

  const used: boolean[][] = cell.map((col) => col.map(() => false));
  const rects: DRect[] = [];

  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      if (!cell[i][j] || used[i][j]) continue;
      // Extend right as far as contiguous in-and-unused cells in row j.
      let iEnd = i;
      while (iEnd + 1 < nx && cell[iEnd + 1][j] && !used[iEnd + 1][j]) iEnd++;
      // Extend down as long as every cell in [i..iEnd] of the next row is in.
      let jEnd = j;
      grow: while (jEnd + 1 < ny) {
        for (let k = i; k <= iEnd; k++) {
          if (!cell[k][jEnd + 1] || used[k][jEnd + 1]) break grow;
        }
        jEnd++;
      }
      for (let a = i; a <= iEnd; a++)
        for (let b = j; b <= jEnd; b++) used[a][b] = true;
      rects.push({
        x: xs[i],
        y: ys[j],
        w: xs[iEnd + 1] - xs[i],
        h: ys[jEnd + 1] - ys[j],
      });
    }
  }
  return rects;
}
