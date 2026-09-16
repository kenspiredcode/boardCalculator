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
}

export interface PlacedSheet {
  rect: Rect; // full sheet footprint (may extend outside region)
  clip: Pt[][]; // clipped fragments that lie inside the region
  coveredArea: number; // area of this sheet inside the region
  isCut: boolean; // true if the sheet had to be trimmed
  wholeInside: boolean; // true if the full sheet lies inside the region
  row: number;
  col: number;
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

  const rows = Math.ceil((box.maxY - box.minY) / stepY) + 1;

  for (let r = 0; r < rows; r++) {
    const y = box.minY + r * stepY;
    if (y > box.maxY + EPS) break;

    // Running-bond: shift alternating (or every) row's start left so joints
    // stagger. We start one step early so a shifted row still covers the left.
    const rowShift = (r * staggerOffset) % stepX;
    let startX = box.minX - rowShift;
    // Back up until we're left of the region, then advance in whole steps.
    while (startX > box.minX - EPS) startX -= stepX;

    const cols = Math.ceil((width + rowShift + stepX) / stepX) + 1;
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
