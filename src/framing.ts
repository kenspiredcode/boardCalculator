// Wall framing: given standalone wall lines and lumber rules, work out how many
// 2x4s each wall takes. All lengths here are in real-world units (the same
// canonical unit the rest of the app uses per system: feet or millimetres).
//
// Framing model (matches common stick-framing practice):
//   - Uprights (studs): one at each end of the wall, plus intermediate studs so
//     that spacing is at most `spacing` on-center. For a wall of length L the
//     number of studs is ceil(L / spacing) + 1 (the +1 is the closing end stud).
//     A zero-length wall still needs 1 stud; we clamp to a sensible minimum.
//   - Plates: a top plate and a bottom plate run the full length of the wall.
//     Each run is built from boards of `plateLength`, so a run needs
//     ceil(L / plateLength) boards. Two runs (top + bottom) per wall.
//   Every piece — studs and plates alike — is a 2x4, so the wall's board count
//   is studs + plateBoards.

import type { Pt } from "./geometry";

/** A standalone wall: a single line segment between two points (world px). */
export interface Wall {
  a: Pt;
  b: Pt;
}

export interface FramingRules {
  /** Max on-center spacing between studs, in real units. */
  spacing: number;
  /** Length of one plate board (top/bottom), in real units. */
  plateLength: number;
  /** Fractional waste buffer added to the total board count, e.g. 0.1 for 10%. */
  buffer?: number;
}

/** Per-wall framing breakdown. */
export interface WallFraming {
  length: number; // real-world length of the wall
  studs: number; // number of vertical uprights
  plateBoards: number; // 2x4s used for top + bottom plates combined
  boards: number; // total 2x4s for this wall (studs + plateBoards)
}

export interface FramingResult {
  perWall: WallFraming[];
  totalStuds: number;
  totalPlateBoards: number;
  /** Board count before any waste buffer (studs + plate boards). */
  totalBoards: number;
  /** Fractional buffer applied (0 if none). */
  buffer: number;
  /** totalBoards rounded up after applying the buffer; what to actually buy. */
  totalWithBuffer: number;
  totalWallLength: number;
}

/** Studs needed for one wall of the given real length. */
export function studCount(length: number, spacing: number): number {
  if (!(length > 0) || !(spacing > 0)) return 1;
  // Intermediate + end studs: divide the run into bays no wider than `spacing`,
  // then add the closing end stud. ceil(L/spacing) bays => that many + 1 studs.
  return Math.ceil(length / spacing) + 1;
}

/** Plate boards for one run (top or bottom) of the given real length. */
function plateBoardsForRun(length: number, plateLength: number): number {
  if (!(length > 0) || !(plateLength > 0)) return length > 0 ? 1 : 0;
  return Math.ceil(length / plateLength);
}

/** Framing breakdown for a single wall. */
export function frameWall(
  length: number,
  rules: FramingRules
): WallFraming {
  const studs = studCount(length, rules.spacing);
  // Top plate + bottom plate, each its own run of boards.
  const plateBoards = 2 * plateBoardsForRun(length, rules.plateLength);
  return { length, studs, plateBoards, boards: studs + plateBoards };
}

/**
 * Frame a set of walls. `scale` converts world pixels to real units
 * (pixels per unit), matching the app's currentScale().
 */
export function frameWalls(
  walls: Wall[],
  rules: FramingRules,
  scale: number
): FramingResult {
  const perWall: WallFraming[] = [];
  let totalStuds = 0;
  let totalPlateBoards = 0;
  let totalWallLength = 0;

  for (const wall of walls) {
    const px = Math.hypot(wall.b.x - wall.a.x, wall.b.y - wall.a.y);
    const length = px / scale;
    const wf = frameWall(length, rules);
    perWall.push(wf);
    totalStuds += wf.studs;
    totalPlateBoards += wf.plateBoards;
    totalWallLength += length;
  }

  const totalBoards = totalStuds + totalPlateBoards;
  const buffer = rules.buffer && rules.buffer > 0 ? rules.buffer : 0;
  const totalWithBuffer = Math.ceil(totalBoards * (1 + buffer));

  return {
    perWall,
    totalStuds,
    totalPlateBoards,
    totalBoards,
    buffer,
    totalWithBuffer,
    totalWallLength,
  };
}
