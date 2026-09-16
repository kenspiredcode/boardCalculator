// Offcut-reuse pass on exact rectilinear geometry.
//
// Each cut board's covered area is decomposed into real rectangles (the pieces
// that must be supplied), and its leftover into real rectangles (reusable
// offcuts). Reuse then becomes: for each needed rectangle, find an offcut
// rectangle that can contain it and consume it with a guillotine cut, banking
// the up-to-two remainder rectangles back into inventory.
//
// Rules (agreed with the user):
//  - Any-row reuse, no rotation: an offcut serves a needed rect if it is at
//    least as wide (length, X) — within the +/-15% seam flex — and at least as
//    tall (Y). A taller/wider offcut is trimmed; the trim returns to inventory
//    as remainder rectangles (guillotine), so nothing is silently lost.
//  - Seam flex +/-15%: an offcut up to 15% short on length can still serve a
//    needed rect (the seam pulls in). Hard cap: never exceed a full board.
//  - Avoid slivers: don't bank remainder rectangles whose smaller side is under
//    MIN_FRAC (20%) of the full sheet's short side; such scraps aren't tracked
//    as reusable. Reuse is preferred first; among fits, least leftover waste.

import type { PackResult, PlacedSheet, Sheet, Stagger } from "./packer";
import { pack } from "./packer";
import type { Pt } from "./geometry";
import { coveredToRects, leftoverToRects, type DRect } from "./rectdecomp";

export const FLEX = 0.15;
export const MIN_FRAC = 0.2;

const EPS = 1e-6;

export interface Offcut extends DRect {
  fromSheetIndex: number; // board this leftover came from
}

export interface NeededPiece {
  rect: DRect;
  sheetIndex: number;
}

export interface ReuseAssignment {
  piece: DRect;
  sheetIndex: number;
  servedByOffcut: boolean;
  offcutFrom: number | null;
  flexApplied: number; // fraction of full length the seam moved (0 if none)
}

export interface ReuseResult {
  baseline: PackResult;
  assignments: ReuseAssignment[];
  freshBoards: number; // boards actually bought after reuse
  reusedPieces: number; // needed rects served from leftovers
  wholeBoards: number; // fresh boards used whole
  cutBoards: number; // fresh boards that were cut
  leftoverOffcuts: Offcut[]; // usable leftovers remaining at the end
  boardsSaved: number;
  wastePct: number; // against fresh boards
  reusedArea: number; // needed area supplied from offcuts
}

/**
 * Full pipeline the UI calls: try both sheet orientations, run the reuse pass on
 * each, and return whichever needs the fewest *fresh* boards after reuse (ties
 * broken by lower waste). This is the honest optimum the user sees.
 */
export function optimalWithReuse(
  region: Pt[],
  sheet: Sheet,
  stagger: Stagger,
  gap: number
): ReuseResult {
  const results: ReuseResult[] = [];
  for (const rotateSheet of [false, true]) {
    results.push(reuseOffcuts(pack(region, { sheet, rotateSheet, stagger, gap })));
  }
  results.sort((a, b) => {
    if (a.freshBoards !== b.freshBoards) return a.freshBoards - b.freshBoards;
    return a.wastePct - b.wastePct;
  });
  return results[0];
}

function usedRectsOf(s: PlacedSheet): DRect[] {
  return coveredToRects(s.clip as Pt[][]);
}

function cloneInventory(inv: Offcut[]): Offcut[] {
  return inv.map((o) => ({ ...o }));
}

/**
 * Run the reuse pass. Boards are processed in placement order (row-major); a
 * whole board is bought as-is, a cut board first tries to supply each of its
 * needed rectangles from the current offcut inventory before buying fresh.
 */
export function reuseOffcuts(baseline: PackResult): ReuseResult {
  const { rotateSheet, sheet } = baseline.options;
  const fullLen = rotateSheet ? sheet.h : sheet.w; // X extent of a full board
  const fullH = rotateSheet ? sheet.w : sheet.h; // Y extent of a full board
  const minSide = Math.min(fullLen, fullH) * MIN_FRAC;

  const inventory: Offcut[] = [];
  const assignments: ReuseAssignment[] = [];

  let freshBoards = 0;
  let wholeBoards = 0;
  let cutBoards = 0;
  let reusedPieces = 0;
  let reusedArea = 0;

  baseline.placed.forEach((s, i) => {
    if (s.wholeInside) {
      assignments.push({
        piece: { x: s.rect.x, y: s.rect.y, w: fullLen, h: fullH },
        sheetIndex: i,
        servedByOffcut: false,
        offcutFrom: null,
        flexApplied: 0,
      });
      freshBoards++;
      wholeBoards++;
      return;
    }

    // A cut board is bought once and supplies ALL its covered fragments. So the
    // question per sheet is binary: can every needed rectangle be served from
    // existing offcuts (saving the board), or must we buy one? Try to serve them
    // all against a scratch copy of inventory; commit only if all succeed.
    const needed = usedRectsOf(s).sort((a, b) => b.w * b.h - a.w * a.h);
    const trial = cloneInventory(inventory);
    const plan: { match: Match; need: DRect }[] = [];
    let allServed = true;
    for (const need of needed) {
      const match = findOffcut(trial, need, fullLen, minSide);
      if (!match) {
        allServed = false;
        break;
      }
      consumeOffcut(trial, match.index, need, minSide);
      plan.push({ match, need });
    }

    if (allServed && needed.length > 0) {
      // Commit: this sheet costs no board; apply the consumption for real.
      inventory.length = 0;
      inventory.push(...trial);
      for (const { match, need } of plan) {
        assignments.push({
          piece: need,
          sheetIndex: i,
          servedByOffcut: true,
          offcutFrom: match.fromSheetIndex,
          flexApplied: match.flex,
        });
        reusedPieces++;
        reusedArea += need.w * need.h;
      }
      return;
    }

    // Buy one board; it covers all this sheet's needs. Bank its leftovers.
    freshBoards++;
    cutBoards++;
    for (const need of needed) {
      assignments.push({
        piece: need,
        sheetIndex: i,
        servedByOffcut: false,
        offcutFrom: null,
        flexApplied: 0,
      });
    }
    const full: DRect = { x: s.rect.x, y: s.rect.y, w: fullLen, h: fullH };
    for (const lo of leftoverToRects(full, s.clip as Pt[][])) {
      if (Math.min(lo.w, lo.h) >= minSide - EPS) {
        inventory.push({ ...lo, fromSheetIndex: i });
      }
    }
  });

  const sheetArea = baseline.sheetArea;
  const consumedArea = freshBoards * sheetArea;
  const wastePct =
    consumedArea > 0 ? (consumedArea - baseline.regionArea) / consumedArea : 0;

  return {
    baseline,
    assignments,
    freshBoards,
    reusedPieces,
    wholeBoards,
    cutBoards,
    leftoverOffcuts: inventory,
    boardsSaved: baseline.boardsUsed - freshBoards,
    wastePct,
    reusedArea,
  };
}

interface Match {
  index: number;
  flex: number;
  fromSheetIndex: number;
  waste: number;
}

/**
 * Best offcut that can contain `need`: wide enough on X (within +/-15% flex),
 * tall enough on Y. Prefer the least wasteful fit (smallest area slack) so large
 * offcuts stay available and remainders don't fragment.
 */
function findOffcut(
  inventory: Offcut[],
  need: DRect,
  fullLen: number,
  minSide: number
): Match | null {
  const minCoverW = need.w * (1 - FLEX); // shortest offcut that flexes to fit
  let best: Match | null = null;
  for (let i = 0; i < inventory.length; i++) {
    const oc = inventory[i];
    if (oc.h < need.h - EPS) continue; // tall enough?
    if (oc.w > fullLen + EPS) continue; // never exceed a board
    if (oc.w < minCoverW - EPS) continue; // too short even with flex

    const effW = Math.min(need.w, oc.w); // width actually supplied (after flex)
    // Don't flex a legitimate piece down into a sliver.
    if (effW < minSide - EPS && need.w >= minSide) continue;

    const flex = oc.w >= need.w ? 0 : (need.w - oc.w) / fullLen;
    const waste = oc.w * oc.h - effW * need.h; // area not going into the piece
    if (!best || waste < best.waste - EPS) {
      best = { index: i, flex, fromSheetIndex: oc.fromSheetIndex, waste };
    }
  }
  return best;
}

/**
 * Remove offcut `index`, cut `need` from its corner, and bank the up-to-two
 * remainder rectangles (guillotine: a right strip and a top strip) that meet the
 * sliver threshold.
 */
function consumeOffcut(
  inventory: Offcut[],
  index: number,
  need: DRect,
  minSide: number
): void {
  const oc = inventory[index];
  inventory.splice(index, 1);
  const takeW = Math.min(need.w, oc.w); // flex means we may take slightly less
  // Right strip: full height of the offcut, remaining width.
  const rightW = oc.w - takeW;
  if (rightW >= minSide - EPS && oc.h >= minSide - EPS) {
    inventory.push({
      x: oc.x + takeW,
      y: oc.y,
      w: rightW,
      h: oc.h,
      fromSheetIndex: oc.fromSheetIndex,
    });
  }
  // Top strip: over the taken width only, height above the piece.
  const topH = oc.h - need.h;
  if (topH >= minSide - EPS && takeW >= minSide - EPS) {
    inventory.push({
      x: oc.x,
      y: oc.y + need.h,
      w: takeW,
      h: topH,
      fromSheetIndex: oc.fromSheetIndex,
    });
  }
}
