// OSB sheet packer targeting a running-bond (brick) layout over an arbitrary
// rectilinear region. Lays rows of sheet-height, staggers each row's starting
// offset, then clips every sheet against the region (triangulated to convex
// pieces) to decide whether each sheet is fully used, cut, or discarded.

import type { Pt, Rect } from "./geometry";
import {
  bbox,
  clipRectToConvex,
  triangulate,
  polygonArea,
  fragmentArea,
} from "./geometry";

export interface Sheet {
  w: number;
  h: number;
}

export type Stagger = "half" | "third" | "none";

export interface PackOptions {
  sheet: Sheet;
  /** true => rows run horizontally with sheet width along X (landscape). */
  rotateSheet: boolean;
  stagger: Stagger;
  /** Gap between sheets (expansion gap), in the same units. */
  gap: number;
  /**
   * Fraction of one sheet-length to shift the whole grid's origin along X, and
   * of one sheet-height along Y. Both in [0,1); the seam-position search sweeps
   * these to find cut positions that waste fewer boards. Default 0 = grid starts
   * flush at the region's bounding-box corner (the original behavior).
   */
  offsetX?: number;
  offsetY?: number;
}

export interface PlacedSheet {
  rect: Rect; // full sheet footprint (may extend outside region)
  clip: Pt[][]; // clipped fragments that lie inside the region
  coveredArea: number; // area of this sheet inside the region
  isCut: boolean; // true if the sheet had to be trimmed
  wholeInside: boolean; // true if the full sheet lies inside the region
  row: number;
  col: number;
  // Axis-aligned extent of the covered fragments, in region units. Used by the
  // offcut-reuse pass to know how much of the sheet's length/height is actually
  // consumed and how big a leftover the cut produced.
  usedBox: { minX: number; minY: number; maxX: number; maxY: number } | null;
}

export interface PackResult {
  placed: PlacedSheet[];
  regionArea: number;
  coveredArea: number;
  boardsUsed: number; // total sheets that contribute any coverage
  wholeBoards: number; // sheets used fully (no cut)
  cutBoards: number; // sheets that were trimmed
  sheetArea: number;
  wastePct: number; // (boardsUsed*sheetArea - regionArea) / (boardsUsed*sheetArea)
  options: PackOptions;
}

const EPS = 1e-6;

/** Run the packer for one set of options. */
export function pack(region: Pt[], opts: PackOptions): PackResult {
  const sw = opts.rotateSheet ? opts.sheet.h : opts.sheet.w;
  const sh = opts.rotateSheet ? opts.sheet.w : opts.sheet.h;
  const gap = opts.gap;
  const stepX = sw + gap;
  const stepY = sh + gap;

  const tris = triangulate(region);
  const regionArea = polygonArea(region);
  const box = bbox(region);
  const width = box.maxX - box.minX;

  const staggerOffset =
    opts.stagger === "half" ? sw / 2 : opts.stagger === "third" ? sw / 3 : 0;

  const placed: PlacedSheet[] = [];
  let coveredArea = 0;
  let wholeBoards = 0;
  let cutBoards = 0;

  // Grid-origin offsets from the seam-position search. offsetY shifts the first
  // row up so its top seam lands elsewhere; offsetX shifts each row's columns.
  const offX = (opts.offsetX ?? 0) * stepX;
  const offY = (opts.offsetY ?? 0) * stepY;
  const originY = box.minY - offY;

  const rows = Math.ceil((box.maxY - originY) / stepY) + 2;

  for (let r = 0; r < rows; r++) {
    const y = originY + r * stepY;
    if (y > box.maxY + EPS) break;
    if (y + sh < box.minY - EPS) continue; // row entirely above the region

    // Running-bond: shift alternating (or every) row's start left so joints
    // stagger. We start one step early so a shifted row still covers the left.
    const rowShift = (r * staggerOffset) % stepX;
    let startX = box.minX - offX - rowShift;
    // Back up until we're left of the region, then advance in whole steps.
    while (startX > box.minX - EPS) startX -= stepX;

    const cols = Math.ceil((width + offX + rowShift + stepX) / stepX) + 2;
    for (let c = 0; c < cols; c++) {
      const x = startX + c * stepX;
      if (x > box.maxX + EPS) break;

      const rect: Rect = { x, y, w: sw, h: sh };
      const { fragments, area } = clipRectToRegion(rect, tris);
      if (area <= EPS) continue; // sheet lies entirely outside the region

      const fullArea = sw * sh;
      const wholeInside = area >= fullArea - EPS * fullArea;
      placed.push({
        rect,
        clip: fragments,
        coveredArea: area,
        isCut: !wholeInside,
        wholeInside,
        row: r,
        col: c,
        usedBox: fragmentsBox(fragments),
      });
      coveredArea += area;
      if (wholeInside) wholeBoards++;
      else cutBoards++;
    }
  }

  const boardsUsed = placed.length;
  const sheetArea = opts.sheet.w * opts.sheet.h;
  const consumedArea = boardsUsed * sheetArea;
  const wastePct =
    consumedArea > 0 ? (consumedArea - regionArea) / consumedArea : 0;

  return {
    placed,
    regionArea,
    coveredArea,
    boardsUsed,
    wholeBoards,
    cutBoards,
    sheetArea,
    wastePct,
    options: opts,
  };
}

/** Axis-aligned bounding box of a set of clipped fragments, or null if empty. */
function fragmentsBox(
  frags: Pt[][]
): { minX: number; minY: number; maxX: number; maxY: number } | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const frag of frags) {
    for (const p of frag) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
  }
  if (minX === Infinity) return null;
  return { minX, minY, maxX, maxY };
}

/** Clip a rect against every triangle of the region; union areas of fragments. */
function clipRectToRegion(
  rect: Rect,
  tris: Pt[][]
): { fragments: Pt[][]; area: number } {
  const fragments: Pt[][] = [];
  let area = 0;
  for (const tri of tris) {
    const frag = clipRectToConvex(rect, tri);
    if (frag.length >= 3) {
      const a = fragmentArea(frag);
      if (a > EPS) {
        fragments.push(frag);
        area += a;
      }
    }
  }
  return { fragments, area };
}

/**
 * Try all four combinations of orientation x direction and return the layout
 * that uses the fewest boards (ties broken by lower waste). This is what the UI
 * calls to get the "optimal" answer.
 */
export function packOptimal(
  region: Pt[],
  sheet: Sheet,
  stagger: Stagger,
  gap: number
): PackResult {
  const candidates: PackResult[] = [];
  for (const rotateSheet of [false, true]) {
    candidates.push(pack(region, { sheet, rotateSheet, stagger, gap }));
  }
  candidates.sort((a, b) => {
    if (a.boardsUsed !== b.boardsUsed) return a.boardsUsed - b.boardsUsed;
    return a.wastePct - b.wastePct;
  });
  return candidates[0];
}
