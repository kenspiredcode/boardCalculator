// Per-edge dimension editing for a closed rectilinear polygon.
//
// The polygon is a loop of axis-aligned edges (every edge is horizontal or
// vertical). Each edge has a signed length along its axis. For the loop to
// close, the signed horizontal lengths must sum to 0, and likewise vertical.
//
// The user can pin some edges to an exact real-world length. When they do, we
// re-solve: pinned edges keep their length (and original direction), and the
// unpinned edges on that axis absorb the remainder, scaled proportionally to
// their current lengths so the sketch's shape is preserved as much as possible.
// Then we rebuild vertex positions by walking the edges.

import type { Pt } from "./geometry";

export interface Edge {
  index: number; // edge i connects points[i] -> points[(i+1)%n]
  axis: "h" | "v"; // horizontal or vertical
  dir: 1 | -1; // sign of travel along the axis
  lengthPx: number; // current pixel length (>= 0)
}

const EPS = 1e-6;

/** Describe each edge of a closed polygon (in pixels). */
export function edgesOf(points: Pt[]): Edge[] {
  const n = points.length;
  const edges: Edge[] = [];
  for (let i = 0; i < n; i++) {
    const a = points[i];
    const b = points[(i + 1) % n];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    if (Math.abs(dx) >= Math.abs(dy)) {
      edges.push({
        index: i,
        axis: "h",
        dir: dx >= 0 ? 1 : -1,
        lengthPx: Math.abs(dx),
      });
    } else {
      edges.push({
        index: i,
        axis: "v",
        dir: dy >= 0 ? 1 : -1,
        lengthPx: Math.abs(dy),
      });
    }
  }
  return edges;
}

/**
 * Re-solve edge pixel lengths after some edges are pinned to real lengths.
 *
 * @param points   current polygon vertices (pixels)
 * @param fixedLen map of edge index -> pinned real-world length
 * @param pxPerUnit pixels per real unit
 * @returns new vertex positions (pixels), keeping the first vertex fixed, or
 *          null if the constraints can't be satisfied (e.g. all edges on an
 *          axis pinned but they don't cancel).
 */
export function resolvePolygon(
  points: Pt[],
  fixedLen: Map<number, number>,
  pxPerUnit: number
): Pt[] | null {
  const edges = edgesOf(points);
  const lengths = edges.map((e) => e.lengthPx);

  for (const axis of ["h", "v"] as const) {
    const axisEdges = edges.filter((e) => e.axis === axis);
    if (axisEdges.length === 0) continue;

    // Signed target: pinned edges contribute their exact signed pixel length.
    // The unpinned edges must together contribute the negative of the pinned
    // sum, split proportionally to their current lengths while keeping sign.
    let pinnedSigned = 0;
    const unpinned: Edge[] = [];
    for (const e of axisEdges) {
      if (fixedLen.has(e.index)) {
        const px = fixedLen.get(e.index)! * pxPerUnit;
        pinnedSigned += e.dir * px;
        lengths[e.index] = px; // write the pinned edge's length
      } else {
        unpinned.push(e);
      }
    }

    if (unpinned.length === 0) {
      // All pinned: they must already cancel to close the loop.
      if (Math.abs(pinnedSigned) > 1e-3) return null;
      for (const e of axisEdges) {
        lengths[e.index] = fixedLen.get(e.index)! * pxPerUnit;
      }
      continue;
    }

    // Unpinned edges must sum (signed) to -pinnedSigned.
    const targetUnpinnedSigned = -pinnedSigned;
    // Current signed sum of unpinned edges, and their positive-length total,
    // grouped by direction so we can scale while preserving each edge's sign.
    let posLen = 0; // total px of unpinned edges going in +dir
    let negLen = 0; // total px of unpinned edges going in -dir
    for (const e of unpinned) {
      if (e.dir === 1) posLen += e.lengthPx;
      else negLen += e.lengthPx;
    }

    // We need pos' - neg' = targetUnpinnedSigned, keeping pos'/neg' >= 0 and, as
    // much as possible, proportional to the sketch. Preserve the total span
    // (pos+neg) and shift the balance to hit the target. If the target exceeds
    // the available span, grow the span minimally.
    const span = posLen + negLen;
    let newPos: number;
    let newNeg: number;
    if (span < EPS) {
      // Degenerate (no unpinned span): put the whole target on one side.
      newPos = Math.max(0, targetUnpinnedSigned);
      newNeg = Math.max(0, -targetUnpinnedSigned);
    } else {
      // Solve pos'-neg' = target, pos'+neg' = max(span, |target|).
      const total = Math.max(span, Math.abs(targetUnpinnedSigned));
      newPos = (total + targetUnpinnedSigned) / 2;
      newNeg = (total - targetUnpinnedSigned) / 2;
    }

    // Distribute newPos across +dir unpinned edges proportionally (and newNeg
    // across -dir). If a direction had no length, split evenly.
    distribute(unpinned, 1, newPos, lengths);
    distribute(unpinned, -1, newNeg, lengths);
  }

  // Rebuild vertices by walking edges from the original first vertex.
  const out: Pt[] = [{ x: points[0].x, y: points[0].y }];
  for (let i = 0; i < edges.length - 1; i++) {
    const e = edges[i];
    const prev = out[i];
    const len = lengths[e.index];
    if (e.axis === "h") out.push({ x: prev.x + e.dir * len, y: prev.y });
    else out.push({ x: prev.x, y: prev.y + e.dir * len });
  }
  return out;
}

function distribute(
  edges: Edge[],
  dir: 1 | -1,
  total: number,
  lengths: number[]
): void {
  const group = edges.filter((e) => e.dir === dir);
  if (group.length === 0) return;
  const curTotal = group.reduce((s, e) => s + e.lengthPx, 0);
  for (const e of group) {
    const share =
      curTotal > EPS ? e.lengthPx / curTotal : 1 / group.length;
    lengths[e.index] = total * share;
  }
}

/** Real-world length of an edge given the current scale. */
export function edgeRealLength(
  points: Pt[],
  i: number,
  pxPerUnit: number
): number {
  const a = points[i];
  const b = points[(i + 1) % points.length];
  return Math.hypot(b.x - a.x, b.y - a.y) / pxPerUnit;
}

/** Midpoint of edge i (pixels), for placing its dimension label. */
export function edgeMidpoint(points: Pt[], i: number): Pt {
  const a = points[i];
  const b = points[(i + 1) % points.length];
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}
