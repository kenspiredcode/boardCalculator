import "./style.css";
import type { Pt } from "./geometry";
import type { Stagger } from "./packer";
import { optimalWithReuse } from "./offcut";
import type { ReuseResult } from "./offcut";
import { PRESETS, formatArea, formatLength } from "./units";
import type { System } from "./units";
import { frameWalls } from "./framing";
import type { Wall, FramingResult } from "./framing";
import {
  resolvePolygon,
  edgeRealLength,
  edgeMidpoint,
  edgesOf,
  dragVertex,
} from "./dimensions";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

type Mode = "draw" | "image";
type Layer = "floorplan" | "walls";
type CalibState = "idle" | "picking";

interface State {
  layer: Layer;
  mode: Mode;
  system: System;
  points: Pt[]; // polygon vertices in *canvas* pixels
  closed: boolean;
  // pixels-per-unit: how many canvas px equal one real-world unit
  pxPerUnit: number;
  image: HTMLImageElement | null;
  calib: CalibState;
  calibPts: Pt[];
  hoverPt: Pt | null;
  result: ReuseResult | null;
  // User-fixed real-world lengths per edge (edge i = points[i]->points[i+1]).
  // Absent entries float and scale proportionally when other edges are fixed.
  fixedLen: Map<number, number>;
  // View transform: screen = world * zoom + pan. Points and all geometry are
  // stored in "world" space (unchanged by zoom); this only affects display and
  // input mapping, so real-world units stay correct.
  zoom: number;
  panX: number;
  panY: number;
  panning: boolean;
  panStart: { x: number; y: number; panX: number; panY: number } | null;
  draggingVertex: number; // index of vertex being dragged, or -1
  // Standalone wall lines (walls layer). Each is a finished segment.
  walls: Wall[];
  // First endpoint of the wall currently being drawn, or null between walls.
  wallStart: Pt | null;
  framing: FramingResult | null;
}

const state: State = {
  layer: "floorplan",
  mode: "draw",
  system: "imperial",
  points: [],
  closed: false,
  pxPerUnit: 40, // default: draw grid, 40px per unit
  image: null,
  calib: "idle",
  calibPts: [],
  hoverPt: null,
  result: null,
  fixedLen: new Map(),
  zoom: 1,
  panX: 0,
  panY: 0,
  panning: false,
  panStart: null,
  draggingVertex: -1,
  walls: [],
  wallStart: null,
  framing: null,
};

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------

const $ = <T extends HTMLElement = HTMLElement>(sel: string) =>
  document.querySelector(sel) as T;

const canvas = $("#canvas") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;
const stageHint = $("#stage-hint");

const sheetW = $("#sheet-w") as HTMLInputElement;
const sheetH = $("#sheet-h") as HTMLInputElement;
const scaleInput = $("#scale-input") as HTMLInputElement;
const gapInput = $("#gap") as HTMLInputElement;
const staggerSel = $("#stagger") as HTMLSelectElement;
const studSpacingInput = $("#stud-spacing") as HTMLInputElement;
const plateLengthInput = $("#plate-length") as HTMLInputElement;
const bufferToggle = $("#buffer-toggle") as HTMLInputElement;

const BUFFER_PCT = 0.1; // 10% recommended waste buffer

const SNAP_CLOSE_PX = 12;
// Hit tolerances are screen-pixel intents; convert to world units at the
// current zoom so they feel constant on screen.
function snapClose(): number {
  return SNAP_CLOSE_PX / state.zoom;
}
function edgeHit(): number {
  return EDGE_HIT_PX / state.zoom;
}

// ---------------------------------------------------------------------------
// Setup: sizing, presets, listeners
// ---------------------------------------------------------------------------

function applySystem(sys: System) {
  state.system = sys;
  const preset = PRESETS[sys];
  sheetW.value = String(preset.defaultSheet.w);
  sheetH.value = String(preset.defaultSheet.h);
  $("#scale-unit").textContent = preset.label;
  document.querySelectorAll(".gap-unit").forEach((e) => (e.textContent = preset.label));
  scaleInput.value = sys === "imperial" ? "1" : "500";
  // Framing defaults per system: 16" O.C. / 8 ft plate, or 400 mm / 2440 mm.
  if (sys === "imperial") {
    studSpacingInput.value = "1.333"; // 16 inches, in feet
    plateLengthInput.value = "8";
  } else {
    studSpacingInput.value = "400";
    plateLengthInput.value = "2440";
  }
  document.querySelectorAll(".framing-unit").forEach((e) => (e.textContent = preset.label));
  document.querySelectorAll("#unit-seg button").forEach((b) => {
    b.classList.toggle("active", (b as HTMLElement).dataset.system === sys);
  });
  draw();
}

function resizeCanvas() {
  const stage = canvas.parentElement!;
  const rect = stage.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(300, rect.width) * dpr;
  canvas.height = Math.max(300, rect.height) * dpr;
  canvas.style.width = `${rect.width}px`;
  canvas.style.height = `${rect.height}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  draw();
}

window.addEventListener("resize", resizeCanvas);

// Mode toggle
document.querySelectorAll("#mode-seg button").forEach((btn) => {
  btn.addEventListener("click", () => {
    const mode = (btn as HTMLElement).dataset.mode as Mode;
    state.mode = mode;
    document.querySelectorAll("#mode-seg button").forEach((b) =>
      b.classList.toggle("active", b === btn)
    );
    $("#image-field").hidden = mode !== "image";
    $("#calibrate-box").hidden = mode !== "image";
    $("#mode-hint").textContent =
      mode === "draw"
        ? "Click on the grid to place corners. Click the first point again to close the shape."
        : "Upload a floorplan, set the scale with a known line, then trace the outline by clicking corners.";
    draw();
  });
});

// Layer toggle (floorplan vs. standalone walls)
document.querySelectorAll("#layer-seg button").forEach((btn) => {
  btn.addEventListener("click", () => {
    const layer = (btn as HTMLElement).dataset.layer as Layer;
    state.layer = layer;
    document.querySelectorAll("#layer-seg button").forEach((b) =>
      b.classList.toggle("active", b === btn)
    );
    applyLayer(layer);
    draw();
  });
});

// Show/hide the controls that belong to each layer. Units & scale stays visible
// for both, since walls need a scale too.
function applyLayer(layer: Layer) {
  const walls = layer === "walls";
  $("#floorplan-controls").hidden = walls;
  $("#osb-controls").hidden = walls;
  $("#floorplan-actions").hidden = walls;
  $("#results").hidden = walls || !state.result;
  $("#framing-controls").hidden = !walls;
  $("#walls-actions").hidden = !walls;
  $("#framing-results").hidden = !walls || !state.framing;
  $("#layer-hint").textContent = walls
    ? "Click to drop a wall's start, click again for its end. Each pair is one standalone wall."
    : "Floorplan: draw or trace the area to sheathe. Walls: draw standalone wall lines to frame with 2×4s.";
  // Abandon any half-drawn wall when leaving the walls layer.
  if (!walls) state.wallStart = null;
}

// Unit toggle
document.querySelectorAll("#unit-seg button").forEach((btn) => {
  btn.addEventListener("click", () =>
    applySystem((btn as HTMLElement).dataset.system as System)
  );
});

// Image upload
$("#image-input").addEventListener("change", (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  const img = new Image();
  img.onload = () => {
    state.image = img;
    draw();
  };
  img.src = URL.createObjectURL(file);
});

// Calibration
$("#calibrate-btn").addEventListener("click", () => {
  state.calib = "picking";
  state.calibPts = [];
  $("#calibrate-hint").textContent = "Click the two ends of a line you know the length of.";
});

// Buttons
$("#clear-btn").addEventListener("click", () => {
  state.points = [];
  state.closed = false;
  state.result = null;
  state.fixedLen.clear();
  resetView();
  $("#results").hidden = true;
  draw();
});
$("#calc-btn").addEventListener("click", calculate);
$("#frame-btn").addEventListener("click", calculateFraming);
bufferToggle.addEventListener("change", () => {
  // Re-run only if framing has already been calculated, so the toggle updates
  // the shown total immediately.
  if (state.framing) calculateFraming();
});
$("#clear-walls-btn").addEventListener("click", () => {
  state.walls = [];
  state.wallStart = null;
  state.framing = null;
  $("#framing-results").hidden = true;
  draw();
});

function resetView() {
  state.zoom = 1;
  state.panX = 0;
  state.panY = 0;
}

$("#resetview-btn").addEventListener("click", () => {
  resetView();
  draw();
});
$("#fit-btn").addEventListener("click", () => {
  fitView();
  draw();
});

// Zoom/pan so the drawn shape fits the viewport with a margin.
function fitView() {
  if (state.points.length < 2) {
    resetView();
    return;
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of state.points) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  const bw = Math.max(1, maxX - minX);
  const bh = Math.max(1, maxY - minY);
  const vw = canvas.clientWidth;
  const vh = canvas.clientHeight;
  const margin = 0.12; // 12% padding
  const zoom = Math.min(
    (vw * (1 - margin)) / bw,
    (vh * (1 - margin)) / bh
  );
  state.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom));
  // Center the shape.
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  state.panX = vw / 2 - cx * state.zoom;
  state.panY = vh / 2 - cy * state.zoom;
}

// Scroll to zoom, centered on the cursor so the point under the pointer stays
// put. Zoom is clamped to a sane range.
const MIN_ZOOM = 0.15;
const MAX_ZOOM = 8;
canvas.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    const s = screenPt(e);
    const factor = Math.exp(-e.deltaY * 0.0015); // smooth, direction-correct
    const next = clamp(state.zoom * factor, MIN_ZOOM, MAX_ZOOM);
    const k = next / state.zoom;
    // Keep the world point under the cursor fixed: pan' = s - k*(s - pan).
    state.panX = s.x - k * (s.x - state.panX);
    state.panY = s.y - k * (s.y - state.panY);
    state.zoom = next;
    draw();
  },
  { passive: false }
);

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

// Pan by dragging: middle-button anywhere, or left-button while holding the
// space bar (so left-click stays free for drawing/editing). A drag suppresses
// the click that would otherwise fire on mouseup.
let spaceHeld = false;
let dragMoved = false;
window.addEventListener("keydown", (e) => {
  if (e.code === "Space") spaceHeld = true;
});
window.addEventListener("keyup", (e) => {
  if (e.code === "Space") spaceHeld = false;
});

canvas.addEventListener("mousedown", (e) => {
  const wantPan = e.button === 1 || (e.button === 0 && spaceHeld);
  if (wantPan) {
    const s = screenPt(e);
    state.panning = true;
    dragMoved = false;
    state.panStart = { x: s.x, y: s.y, panX: state.panX, panY: state.panY };
    canvas.style.cursor = "grabbing";
    e.preventDefault();
    return;
  }
  // Left-button on a corner of a finished shape starts a vertex drag
  // (floorplan layer only; in walls layer the floorplan is a static backdrop).
  if (e.button === 0 && state.closed && state.layer === "floorplan") {
    const p = evtPt(e);
    const vi = vertexNear(p);
    if (vi !== -1) {
      state.draggingVertex = vi;
      dragMoved = false;
      canvas.style.cursor = "grabbing";
      e.preventDefault();
    }
  }
});
window.addEventListener("mousemove", (e) => {
  if (state.panning && state.panStart) {
    const s = screenPt(e);
    if (Math.hypot(s.x - state.panStart.x, s.y - state.panStart.y) > 3)
      dragMoved = true;
    state.panX = state.panStart.panX + (s.x - state.panStart.x);
    state.panY = state.panStart.panY + (s.y - state.panStart.y);
    draw();
    return;
  }
  if (state.draggingVertex !== -1) {
    dragMoved = true;
    let target = evtPt(e);
    if (e.shiftKey) target = snapToGrid(target); // optional grid snap
    state.points = dragVertex(
      state.points,
      state.draggingVertex,
      target.x,
      target.y,
      state.fixedLen,
      currentScale()
    );
    state.result = null; // geometry changed
    $("#results").hidden = true;
    draw();
  }
});
window.addEventListener("mouseup", () => {
  if (state.panning) {
    state.panning = false;
    state.panStart = null;
    canvas.style.cursor = spaceHeld ? "grab" : "crosshair";
    draw();
  }
  if (state.draggingVertex !== -1) {
    state.draggingVertex = -1;
    canvas.style.cursor = "crosshair";
    draw();
  }
});

// Canvas interaction
canvas.addEventListener("mousemove", (e) => {
  if (state.panning || state.draggingVertex !== -1) return; // handled on window
  state.hoverPt = evtPt(e);
  // Cursor: grab over a corner (draggable), pointer over a side (editable).
  if (state.layer === "walls") {
    const overBadge = wallBadgeAt(worldToScreen(state.hoverPt)) !== -1;
    canvas.style.cursor = overBadge ? "pointer" : "crosshair";
  } else if (state.closed && vertexNear(state.hoverPt) !== -1) {
    canvas.style.cursor = "grab";
  } else if (state.closed && edgeNear(state.hoverPt) !== -1) {
    canvas.style.cursor = "pointer";
  } else {
    canvas.style.cursor = "crosshair";
  }
  draw();
});
canvas.addEventListener("mouseleave", () => {
  state.hoverPt = null;
  draw();
});
canvas.addEventListener("click", (e) => {
  // A drag-pan ends with a click event; ignore it so panning never draws a
  // point or triggers the new-shape prompt.
  if (dragMoved) {
    dragMoved = false;
    return;
  }
  const p = evtPt(e);
  // Walls layer: build standalone segments, two clicks each.
  if (state.layer === "walls") {
    // A click on a wall's delete badge removes that wall (only when not
    // mid-draw, so the badge can't hijack placing a second endpoint).
    if (state.wallStart === null) {
      const del = wallBadgeAt(worldToScreen(p));
      if (del !== -1) {
        state.walls.splice(del, 1);
        // Recompute framing if a result was already showing, so the count
        // stays in sync; otherwise just drop the stale result.
        if (state.framing) {
          if (state.walls.length > 0) calculateFraming();
          else {
            state.framing = null;
            $("#framing-results").hidden = true;
          }
        }
        draw();
        return;
      }
    }
    const snapped = wallSnap(p);
    if (state.wallStart === null) {
      state.wallStart = snapped;
    } else {
      // Ignore a zero-length wall (double-click on the same spot).
      if (dist(state.wallStart, snapped) > 1e-3) {
        state.walls.push({ a: state.wallStart, b: snapped });
        state.framing = null; // walls changed; previous count is stale
        $("#framing-results").hidden = true;
      }
      state.wallStart = null;
    }
    draw();
    return;
  }
  if (state.calib === "picking") {
    state.calibPts.push(p);
    if (state.calibPts.length === 2) finishCalibration();
    draw();
    return;
  }
  // When the shape is closed: clicking ON a side edits that side's real length.
  // Clicking clearly in open space offers to start a fresh shape (confirmed, so
  // a near-miss on a side never silently discards the drawing).
  if (state.closed) {
    // A press on a corner (that didn't turn into a drag) is a no-op, not an
    // edge edit or a new-shape trigger.
    if (vertexNear(p) !== -1) return;
    const edgeIdx = edgeNear(p);
    if (edgeIdx !== -1) {
      editEdgeLength(edgeIdx);
      return;
    }
    if (!confirm("Start a new shape? This clears the current one.")) return;
    state.points = [];
    state.closed = false;
    state.result = null;
    state.fixedLen.clear();
    $("#results").hidden = true;
    state.points.push(p);
    draw();
    return;
  }
  // Close if clicking near the first point.
  if (state.points.length >= 3) {
    const first = state.points[0];
    if (dist(first, p) < snapClose()) {
      state.closed = true;
      draw();
      return;
    }
  }
  state.points.push(snapAxis(p));
  draw();
});

function finishCalibration() {
  const [a, b] = state.calibPts;
  const px = dist(a, b);
  const known = parseFloat(
    prompt(
      `How long is that line, in ${PRESETS[state.system].label}?`,
      "10"
    ) || "0"
  );
  if (known > 0 && px > 0) {
    state.pxPerUnit = px / known;
    $("#calibrate-hint").textContent = `Scale set: ${(state.pxPerUnit).toFixed(
      1
    )} px per ${PRESETS[state.system].label}.`;
  }
  state.calib = "idle";
  state.calibPts = [];
  draw();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Screen (CSS-pixel) position of an event.
function screenPt(e: MouseEvent): Pt {
  const rect = canvas.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

// World-space position of an event (inverse of the view transform). All stored
// geometry lives in world space, so every handler uses this.
function evtPt(e: MouseEvent): Pt {
  const s = screenPt(e);
  return {
    x: (s.x - state.panX) / state.zoom,
    y: (s.y - state.panY) / state.zoom,
  };
}

function dist(a: Pt, b: Pt): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// Snap the direction from `anchor` to `p` onto the nearest 45° multiple
// (horizontal, vertical, or diagonal), keeping the same reach along that ray.
function angleSnap(anchor: Pt, p: Pt): Pt {
  const dx = p.x - anchor.x;
  const dy = p.y - anchor.y;
  const r = Math.hypot(dx, dy);
  if (r < 1e-6) return { x: p.x, y: p.y };
  const step = Math.PI / 4; // 45°
  const ang = Math.round(Math.atan2(dy, dx) / step) * step;
  return { x: anchor.x + r * Math.cos(ang), y: anchor.y + r * Math.sin(ang) };
}

// Alignment snap: if p's x (or y) is within a small screen margin of an existing
// point's x (or y), pin it to that coordinate so new points line up with drawn
// ones. Considers floorplan vertices and wall endpoints; `skip` is excluded
// (e.g. the anchor the segment is drawn from). Independent per axis.
const ALIGN_PX = 8;
function alignSnap(p: Pt, skip?: Pt, axes: "both" | "x" | "y" = "both"): Pt {
  const tol = ALIGN_PX / state.zoom;
  const refs: Pt[] = [...state.points];
  for (const w of state.walls) refs.push(w.a, w.b);
  let x = p.x;
  let y = p.y;
  let bestDX = tol;
  let bestDY = tol;
  for (const r of refs) {
    if (r === skip) continue;
    if (axes !== "y") {
      const ax = Math.abs(r.x - p.x);
      if (ax < bestDX) {
        bestDX = ax;
        x = r.x;
      }
    }
    if (axes !== "x") {
      const ay = Math.abs(r.y - p.y);
      if (ay < bestDY) {
        bestDY = ay;
        y = r.y;
      }
    }
  }
  return { x, y };
}

// Snap a new floorplan vertex. The floorplan stays strictly rectilinear (every
// edge horizontal or vertical) because per-side length editing and the OSB
// packer both depend on that; 45° is a walls-only affordance. We still nudge
// onto alignment with existing points.
function snapAxis(p: Pt): Pt {
  if (state.points.length === 0) return alignSnap(p);
  const prev = state.points[state.points.length - 1];
  // Axis-align to the previous corner (horizontal or vertical only), then align
  // only along the free axis so the edge stays axis-aligned.
  const dx = Math.abs(p.x - prev.x);
  const dy = Math.abs(p.y - prev.y);
  const vertical = dx < dy;
  const axial = vertical ? { x: prev.x, y: p.y } : { x: p.x, y: prev.y };
  return alignSnap(axial, prev, vertical ? "y" : "x");
}

// Snap a wall endpoint: first to a nearby floorplan corner or wall endpoint (for
// tracing), then angle-snap to the wall's start point, then align to any point.
function wallSnap(p: Pt): Pt {
  // Snap to an existing corner/endpoint within the corner hit tolerance.
  const tol = VERTEX_HIT_PX / state.zoom;
  let best: Pt | null = null;
  let bestD = tol;
  const snapTargets: Pt[] = [...state.points];
  for (const w of state.walls) snapTargets.push(w.a, w.b);
  for (const v of snapTargets) {
    const d = dist(v, p);
    if (d < bestD) {
      bestD = d;
      best = v;
    }
  }
  if (best) return { x: best.x, y: best.y };
  if (state.wallStart) {
    return alignSnap(angleSnap(state.wallStart, p), state.wallStart);
  }
  // First endpoint: no anchor to angle-snap against, but still align to points.
  return alignSnap(p);
}

// Screen-space center of a wall's delete badge (the hover "×"). Sits just off
// the wall midpoint, on the +normal side, so it doesn't cover the length label.
const WALL_BADGE_R_PX = 9; // badge radius, screen px
function wallBadgeCenter(wall: Wall): Pt {
  const mid = worldToScreen({
    x: (wall.a.x + wall.b.x) / 2,
    y: (wall.a.y + wall.b.y) / 2,
  });
  const dx = wall.b.x - wall.a.x;
  const dy = wall.b.y - wall.a.y;
  const len = Math.hypot(dx, dy) || 1;
  // Unit normal (screen space is a uniform scale of world, so direction holds).
  const nx = -dy / len;
  const ny = dx / len;
  const off = 18; // push the badge off the line
  return { x: mid.x + nx * off, y: mid.y + ny * off };
}

// Index of the wall whose delete badge is under screen point sp, or -1.
function wallBadgeAt(sp: Pt): number {
  for (let i = 0; i < state.walls.length; i++) {
    const c = wallBadgeCenter(state.walls[i]);
    if (Math.hypot(sp.x - c.x, sp.y - c.y) <= WALL_BADGE_R_PX + 2) return i;
  }
  return -1;
}

// Convert canvas-pixel polygon to real-world units for the packer.
function polyInUnits(): Pt[] {
  const scale = state.mode === "draw" ? gridPxPerUnit() : state.pxPerUnit;
  return state.points.map((p) => ({ x: p.x / scale, y: p.y / scale }));
}

// In draw mode, the grid cell size (scaleInput) sets units. One grid cell is
// rendered as GRID_PX pixels; the cell equals `scaleInput` units.
const GRID_PX = 40;
function gridPxPerUnit(): number {
  const cell = parseFloat(scaleInput.value) || 1;
  return GRID_PX / cell;
}

// Pixels-per-unit currently in effect (draw grid vs. image calibration).
function currentScale(): number {
  return state.mode === "draw" ? gridPxPerUnit() : state.pxPerUnit;
}

// Snap a world point to the nearest grid intersection (draw mode).
function snapToGrid(p: Pt): Pt {
  return {
    x: Math.round(p.x / GRID_PX) * GRID_PX,
    y: Math.round(p.y / GRID_PX) * GRID_PX,
  };
}

const VERTEX_HIT_PX = 11;
// Index of the vertex within VERTEX_HIT_PX (screen px) of world point p, or -1.
function vertexNear(p: Pt): number {
  const tol = VERTEX_HIT_PX / state.zoom;
  let best = -1;
  let bestD = tol;
  for (let i = 0; i < state.points.length; i++) {
    const d = dist(state.points[i], p);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Edge dimension editing
// ---------------------------------------------------------------------------

const EDGE_HIT_PX = 14;

// Index of the polygon edge within EDGE_HIT_PX of point p, or -1.
function edgeNear(p: Pt): number {
  const pts = state.points;
  let bestI = -1;
  let bestD = edgeHit();
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const d = distToSegment(p, a, b);
    if (d < bestD) {
      bestD = d;
      bestI = i;
    }
  }
  return bestI;
}

function distToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-9) return dist(p, a);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

// Prompt for an edge's real length, pin it, re-solve, and redraw.
function editEdgeLength(i: number): void {
  const scale = currentScale();
  const unit = PRESETS[state.system].label;
  const current = edgeRealLength(state.points, i, scale);
  const ans = prompt(
    `Length of this side (${unit}). Other unlabeled sides will scale to keep the shape closed.`,
    current.toFixed(2)
  );
  if (ans === null) return;
  const val = parseFloat(ans);
  if (!(val > 0)) return;

  const fixed = new Map(state.fixedLen);
  fixed.set(i, val);
  const solved = resolvePolygon(state.points, fixed, scale);
  if (!solved) {
    stageHint.textContent =
      "Those lengths can't close the shape — unpin a side or adjust the value.";
    return;
  }
  state.points = solved;
  state.fixedLen = fixed;
  state.result = null; // geometry changed; previous layout is stale
  $("#results").hidden = true;
  fitView(); // keep the (possibly resized) shape in view
  draw();
}

// ---------------------------------------------------------------------------
// Calculate
// ---------------------------------------------------------------------------

function calculate() {
  if (!state.closed || state.points.length < 3) {
    stageHint.textContent = "Close a shape first (click the first corner to finish).";
    return;
  }
  const region = polyInUnits();
  const sheet = {
    w: parseFloat(sheetW.value) || PRESETS[state.system].defaultSheet.w,
    h: parseFloat(sheetH.value) || PRESETS[state.system].defaultSheet.h,
  };
  const stagger = staggerSel.value as Stagger;
  const gap = parseFloat(gapInput.value) || 0;
  const result = optimalWithReuse(region, sheet, stagger, gap);
  state.result = result;
  showResult(result);
  draw();
}

function calculateFraming() {
  if (state.walls.length === 0) {
    stageHint.textContent = "Draw at least one wall first (click a start, then an end).";
    return;
  }
  const spacing = parseFloat(studSpacingInput.value);
  const plateLength = parseFloat(plateLengthInput.value);
  if (!(spacing > 0) || !(plateLength > 0)) {
    stageHint.textContent = "Enter a positive stud spacing and plate length.";
    return;
  }
  const result = frameWalls(
    state.walls,
    { spacing, plateLength, buffer: bufferToggle.checked ? BUFFER_PCT : 0 },
    currentScale()
  );
  state.framing = result;
  showFraming(result);
  draw();
}

function showFraming(r: FramingResult) {
  $("#framing-results").hidden = false;
  $("#total-boards").textContent = String(r.totalWithBuffer);
  $("#total-studs").textContent = String(r.totalStuds);
  $("#total-plates").textContent = String(r.totalPlateBoards);
  $("#wall-count").textContent = String(r.perWall.length);
  $("#wall-length").textContent = formatLength(r.totalWallLength, state.system);
  const spacing = parseFloat(studSpacingInput.value);
  const plate = parseFloat(plateLengthInput.value);
  const bufferNote =
    r.buffer > 0
      ? ` Includes a ${Math.round(r.buffer * 100)}% buffer on ${r.totalBoards} ` +
        `bare board${r.totalBoards === 1 ? "" : "s"}.`
      : "";
  $("#framing-note").textContent =
    `Studs at ${formatLength(spacing, state.system)} on-center; ` +
    `top and bottom plates from ${formatLength(plate, state.system)} boards. ` +
    `All pieces are 2×4.${bufferNote}`;
}

function showResult(r: ReuseResult) {
  $("#results").hidden = false;
  $("#boards-used").textContent = String(r.freshBoards);
  $("#whole-boards").textContent = String(r.wholeBoards);
  $("#cut-boards").textContent = String(r.cutBoards);
  $("#area-covered").textContent = formatArea(r.baseline.regionArea, state.system);
  $("#waste-pct").textContent = `${(r.wastePct * 100).toFixed(1)}%`;

  const saved = r.boardsSaved;
  const orient = r.baseline.options.rotateSheet
    ? "sheets rotated (long edge vertical)"
    : "sheets in default orientation (long edge horizontal)";
  const savedNote =
    saved > 0
      ? ` Offcut reuse saved ${saved} board${saved > 1 ? "s" : ""} (${
          r.reusedPieces
        } piece${r.reusedPieces > 1 ? "s" : ""} cut from leftovers).`
      : " No offcuts were large enough to reuse here.";
  $("#orient-note").textContent = `Best layout: ${orient}.${savedNote}`;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function draw() {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  ctx.clearRect(0, 0, w, h);

  // Apply the view transform (zoom + pan) on top of the DPR transform, so all
  // world-space drawing below is zoomed/panned. Restore afterwards.
  ctx.save();
  ctx.translate(state.panX, state.panY);
  ctx.scale(state.zoom, state.zoom);

  if (state.mode === "image" && state.image) {
    drawImageFit(state.image, w, h);
  } else {
    drawGrid(w, h);
  }

  // Draw packed sheets under the outline (floorplan layer only).
  if (state.result && state.layer === "floorplan") drawSheets(state.result);

  drawPolygon();
  drawCalibration();
  if (state.layer === "walls") drawWalls();

  ctx.restore();

  // Dimension labels are drawn in screen space (after restore) so their text
  // stays a constant size regardless of zoom.
  if (state.closed && state.layer === "floorplan") drawDimensions();
  if (!state.closed && state.layer === "floorplan") drawDrawingLabel();
  if (state.layer === "walls") {
    drawWallLabels();
    drawWallBadges();
  }
  if (state.result && state.layer === "floorplan") drawSheetTooltip(state.result);
  updateStageHint();
}

// On hover over a tiled sheet, show its cut-piece dimensions in a tooltip.
function drawSheetTooltip(r: ReuseResult) {
  const i = hoveredSheet(r);
  if (i === -1 || !state.hoverPt) return;
  const s = r.baseline.placed[i];
  const unit = PRESETS[state.system].label;

  // Piece size: the covered part's bounding box. usedBox is already in region
  // (real-world) units, so no scale division. For a whole sheet this equals the
  // full sheet; for a cut sheet it's the trimmed size.
  const ub = s.usedBox!;
  const pw = ub.maxX - ub.minX;
  const ph = ub.maxY - ub.minY;

  const reused = r.assignments.some(
    (a) => a.sheetIndex === i && a.servedByOffcut
  );
  const kind = s.wholeInside ? "Whole sheet" : reused ? "From offcut" : "Cut sheet";
  const fmt = (v: number) => (v < 10 ? v.toFixed(1) : v.toFixed(0));
  const lines = [kind, `${fmt(pw)} × ${fmt(ph)} ${unit}`];
  if (!s.wholeInside) {
    const full = r.baseline.options;
    const fw = full.rotateSheet ? full.sheet.h : full.sheet.w;
    const fh = full.rotateSheet ? full.sheet.w : full.sheet.h;
    lines.push(`from ${fmt(fw)} × ${fmt(fh)} board`);
  }

  // Position near the cursor (screen space).
  const sp = worldToScreen(state.hoverPt);
  ctx.font = "12px system-ui, sans-serif";
  const tw = Math.max(...lines.map((l) => ctx.measureText(l).width));
  const pad = 8;
  const lh = 16;
  const boxW = tw + pad * 2;
  const boxH = lines.length * lh + pad * 2 - 4;
  let bx = sp.x + 14;
  let by = sp.y + 14;
  // Keep the tooltip on-screen.
  if (bx + boxW > canvas.clientWidth) bx = sp.x - 14 - boxW;
  if (by + boxH > canvas.clientHeight) by = sp.y - 14 - boxH;

  ctx.fillStyle = getVar("--tip-bg");
  roundRect(bx, by, boxW, boxH, 6);
  ctx.fill();
  ctx.strokeStyle = getVar("--tip-border");
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  lines.forEach((l, k) => {
    ctx.fillStyle = k === 0 ? getVar("--tip-head") : getVar("--tip-text");
    ctx.font = k === 0 ? "600 12px system-ui, sans-serif" : "12px system-ui, sans-serif";
    ctx.fillText(l, bx + pad, by + pad + k * lh);
  });
}

// World point -> screen (CSS) point, for screen-space overlays.
function worldToScreen(p: Pt): Pt {
  return { x: p.x * state.zoom + state.panX, y: p.y * state.zoom + state.panY };
}

// Screen-constant size in world units: divide a desired pixel size by zoom so
// strokes, dots, and text stay the same on-screen size at any zoom level.
function zi(px: number): number {
  return px / state.zoom;
}

// Visible world-space rectangle, for drawing the grid across the whole viewport.
function worldViewBox(): { x0: number; y0: number; x1: number; y1: number } {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  return {
    x0: -state.panX / state.zoom,
    y0: -state.panY / state.zoom,
    x1: (w - state.panX) / state.zoom,
    y1: (h - state.panY) / state.zoom,
  };
}

function drawGrid(_w: number, _h: number) {
  const vb = worldViewBox();
  // Fill the whole visible world with the grid background.
  ctx.fillStyle = getVar("--grid-bg");
  ctx.fillRect(vb.x0, vb.y0, vb.x1 - vb.x0, vb.y1 - vb.y0);

  ctx.strokeStyle = getVar("--grid-line");
  ctx.lineWidth = 1 / state.zoom; // ~1px on screen at any zoom
  const startX = Math.floor(vb.x0 / GRID_PX) * GRID_PX;
  const startY = Math.floor(vb.y0 / GRID_PX) * GRID_PX;
  for (let x = startX; x <= vb.x1; x += GRID_PX) {
    ctx.beginPath();
    ctx.moveTo(x, vb.y0);
    ctx.lineTo(x, vb.y1);
    ctx.stroke();
  }
  for (let y = startY; y <= vb.y1; y += GRID_PX) {
    ctx.beginPath();
    ctx.moveTo(vb.x0, y);
    ctx.lineTo(vb.x1, y);
    ctx.stroke();
  }
}

function drawImageFit(img: HTMLImageElement, w: number, h: number) {
  const scale = Math.min(w / img.width, h / img.height);
  const dw = img.width * scale;
  const dh = img.height * scale;
  const ox = (w - dw) / 2;
  const oy = (h - dh) / 2;
  ctx.drawImage(img, ox, oy, dw, dh);
}

function drawPolygon() {
  if (state.points.length === 0) return;
  const pts = state.points;
  // Dim the floorplan when it's just a tracing backdrop for the walls layer.
  ctx.save();
  if (state.layer === "walls") ctx.globalAlpha = 0.4;
  ctx.lineWidth = zi(2);
  ctx.strokeStyle = getVar("--accent");
  ctx.fillStyle = getVar("--accent-fill");

  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);

  // Rubber-band to hover point while drawing.
  if (!state.closed && state.hoverPt && state.calib === "idle") {
    const snapped = snapAxis(state.hoverPt);
    ctx.lineTo(snapped.x, snapped.y);
  }
  if (state.closed) {
    ctx.closePath();
    ctx.fill();
  }
  ctx.stroke();

  // Vertices
  for (const p of pts) {
    ctx.fillStyle = getVar("--accent");
    ctx.beginPath();
    ctx.arc(p.x, p.y, zi(4), 0, Math.PI * 2);
    ctx.fill();
  }
  // Highlight the closable first point.
  if (!state.closed && pts.length >= 3 && state.hoverPt) {
    if (dist(pts[0], state.hoverPt) < snapClose()) {
      ctx.strokeStyle = getVar("--accent");
      ctx.lineWidth = zi(2);
      ctx.beginPath();
      ctx.arc(pts[0].x, pts[0].y, zi(8), 0, Math.PI * 2);
      ctx.stroke();
    }
  }
  ctx.restore();
}

// Draw finished walls, plus the rubber-band segment for the one in progress.
function drawWalls() {
  ctx.strokeStyle = getVar("--wall");
  ctx.lineCap = "round";
  ctx.lineWidth = zi(4);
  for (const wall of state.walls) {
    ctx.beginPath();
    ctx.moveTo(wall.a.x, wall.a.y);
    ctx.lineTo(wall.b.x, wall.b.y);
    ctx.stroke();
  }
  // Endpoints of finished walls.
  ctx.fillStyle = getVar("--wall");
  for (const wall of state.walls) {
    for (const p of [wall.a, wall.b]) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, zi(4), 0, Math.PI * 2);
      ctx.fill();
    }
  }
  // In-progress wall: rubber-band from the placed start to the (snapped) hover.
  if (state.wallStart) {
    ctx.fillStyle = getVar("--wall");
    ctx.beginPath();
    ctx.arc(state.wallStart.x, state.wallStart.y, zi(4), 0, Math.PI * 2);
    ctx.fill();
    if (state.hoverPt) {
      const end = wallSnap(state.hoverPt);
      ctx.strokeStyle = getVar("--wall");
      ctx.setLineDash([zi(6), zi(5)]);
      ctx.lineWidth = zi(3);
      ctx.beginPath();
      ctx.moveTo(state.wallStart.x, state.wallStart.y);
      ctx.lineTo(end.x, end.y);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }
}

// Length label at the midpoint of each wall (screen space, constant size).
// Draw a length label at the midpoint of segment a->b, in screen space so the
// text stays a constant size at any zoom. Shared by walls and the in-progress
// floorplan edge.
function drawSegmentLabel(a: Pt, b: Pt) {
  const scale = currentScale();
  const unit = PRESETS[state.system].label;
  const len = dist(a, b) / scale;
  const text = `${len.toFixed(len < 10 ? 1 : 0)} ${unit}`;
  const mid = worldToScreen({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  ctx.font = "600 12px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const w = ctx.measureText(text).width;
  ctx.fillStyle = getVar("--dim-bg");
  roundRect(mid.x - w / 2 - 6, mid.y - 9, w + 12, 18, 5);
  ctx.fill();
  ctx.fillStyle = getVar("--dim-text");
  ctx.fillText(text, mid.x, mid.y);
}

// Wall under (or nearest to) the current hover point, for showing its delete
// badge. Considers both the wall line and its badge, so the × stays reachable.
// Returns -1 while mid-draw (the in-progress wall owns the cursor).
function hoveredWall(): number {
  if (!state.hoverPt || state.wallStart !== null) return -1;
  const sp = worldToScreen(state.hoverPt);
  const badge = wallBadgeAt(sp);
  if (badge !== -1) return badge;
  const tol = EDGE_HIT_PX / state.zoom;
  let best = -1;
  let bestD = tol;
  for (let i = 0; i < state.walls.length; i++) {
    const d = distToSegment(state.hoverPt, state.walls[i].a, state.walls[i].b);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

// Draw the delete "×" badge on the hovered wall (screen space, constant size).
function drawWallBadges() {
  const i = hoveredWall();
  if (i === -1) return;
  const c = wallBadgeCenter(state.walls[i]);
  const r = WALL_BADGE_R_PX;
  ctx.beginPath();
  ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
  ctx.fillStyle = getVar("--wall");
  ctx.fill();
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = 1.5;
  ctx.lineCap = "round";
  const k = r * 0.42;
  ctx.beginPath();
  ctx.moveTo(c.x - k, c.y - k);
  ctx.lineTo(c.x + k, c.y + k);
  ctx.moveTo(c.x + k, c.y - k);
  ctx.lineTo(c.x - k, c.y + k);
  ctx.stroke();
}

function drawWallLabels() {
  for (const wall of state.walls) drawSegmentLabel(wall.a, wall.b);
  if (state.wallStart && state.hoverPt) {
    const end = wallSnap(state.hoverPt);
    if (dist(state.wallStart, end) > 1e-3) drawSegmentLabel(state.wallStart, end);
  }
}

// While drawing a floorplan, show the live length of the rubber-band edge from
// the last placed corner to the (axis-snapped) hover point.
function drawDrawingLabel() {
  if (state.calib !== "idle") return; // don't label during scale calibration
  if (state.points.length === 0 || !state.hoverPt) return;
  const last = state.points[state.points.length - 1];
  const end = snapAxis(state.hoverPt);
  if (dist(last, end) > 1e-3) drawSegmentLabel(last, end);
}

// Draw each edge's real length as a label; pinned edges are highlighted. The
// hovered edge is underlined to signal it's clickable.
function drawDimensions() {
  const pts = state.points;
  const scale = currentScale();
  const unit = PRESETS[state.system].label;
  const hovered = state.hoverPt ? edgeNear(state.hoverPt) : -1;

  ctx.font = "600 12px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  const edges = edgesOf(pts);
  for (let i = 0; i < pts.length; i++) {
    const mid = worldToScreen(edgeMidpoint(pts, i));
    const len = edgeRealLength(pts, i, scale);
    const pinned = state.fixedLen.has(i);
    const label = `${len.toFixed(len < 10 ? 1 : 0)} ${unit}`;

    // Offset the label just outside the edge so it doesn't sit on the line.
    const e = edges[i];
    const off = 14;
    const lx = mid.x + (e.axis === "v" ? off : 0);
    const ly = mid.y + (e.axis === "h" ? -off : 0);

    const w = ctx.measureText(label).width;
    ctx.fillStyle = pinned ? getVar("--pin-bg") : getVar("--dim-bg");
    roundRect(lx - w / 2 - 6, ly - 9, w + 12, 18, 5);
    ctx.fill();

    ctx.fillStyle = pinned ? getVar("--pin-text") : getVar("--dim-text");
    ctx.fillText(label, lx, ly);

    if (i === hovered) {
      ctx.strokeStyle = getVar("--accent");
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(lx - w / 2 - 6, ly + 10);
      ctx.lineTo(lx + w / 2 + 6, ly + 10);
      ctx.stroke();
    }
  }
}

function roundRect(x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawCalibration() {
  if (state.calibPts.length === 0) return;
  ctx.strokeStyle = getVar("--warn");
  ctx.fillStyle = getVar("--warn");
  ctx.lineWidth = zi(2);
  const [a, b] = state.calibPts;
  for (const p of state.calibPts) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
    ctx.fill();
  }
  if (b) {
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }
}

function drawSheets(r: ReuseResult) {
  const scale = state.mode === "draw" ? gridPxPerUnit() : state.pxPerUnit;

  // Which sheets were supplied entirely from reused offcuts (no fresh board)?
  const reusedSheets = new Set<number>();
  for (const a of r.assignments) {
    if (a.servedByOffcut) reusedSheets.add(a.sheetIndex);
  }

  // Pass 1: fill the clipped fragments (the area actually covered), clipped to
  // the region so nothing spills outside the outline. No per-fragment stroke,
  // so triangulation diagonals stay invisible. Three fills: whole board, cut
  // board (fresh), and pieces cut from a reused offcut.
  r.baseline.placed.forEach((s, i) => {
    ctx.fillStyle = reusedSheets.has(i)
      ? getVar("--reuse-fill")
      : s.isCut
      ? getVar("--cut-fill")
      : getVar("--whole-fill");
    for (const frag of s.clip) {
      ctx.beginPath();
      ctx.moveTo(frag[0].x * scale, frag[0].y * scale);
      for (let k = 1; k < frag.length; k++)
        ctx.lineTo(frag[k].x * scale, frag[k].y * scale);
      ctx.closePath();
      ctx.fill();
    }
  });

  // Pass 2: stroke each sheet's rectangle outline, clipped to the region path
  // so the brick/running-bond seams are visible but nothing draws outside.
  ctx.save();
  clipToRegionPath();
  ctx.strokeStyle = getVar("--sheet-line");
  ctx.lineWidth = zi(1.25);
  for (const s of r.baseline.placed) {
    const { x, y, w, h } = s.rect;
    ctx.strokeRect(x * scale, y * scale, w * scale, h * scale);
  }

  // Pass 3: highlight the sheet under the cursor.
  const hi = hoveredSheet(r);
  if (hi !== -1) {
    const s = r.baseline.placed[hi];
    ctx.fillStyle = getVar("--hover-fill");
    for (const frag of s.clip) {
      ctx.beginPath();
      ctx.moveTo(frag[0].x * scale, frag[0].y * scale);
      for (let k = 1; k < frag.length; k++)
        ctx.lineTo(frag[k].x * scale, frag[k].y * scale);
      ctx.closePath();
      ctx.fill();
    }
    ctx.strokeStyle = getVar("--accent");
    ctx.lineWidth = zi(2);
    for (const frag of s.clip) {
      ctx.beginPath();
      ctx.moveTo(frag[0].x * scale, frag[0].y * scale);
      for (let k = 1; k < frag.length; k++)
        ctx.lineTo(frag[k].x * scale, frag[k].y * scale);
      ctx.closePath();
      ctx.stroke();
    }
  }
  ctx.restore();
}

// Index of the placed sheet whose covered area is under the current hover point
// (world px), or -1. Skips while drawing/dragging so it doesn't fight input.
function hoveredSheet(r: ReuseResult): number {
  if (!state.hoverPt || state.draggingVertex !== -1) return -1;
  const scale = currentScale();
  const hp = state.hoverPt;
  for (let i = 0; i < r.baseline.placed.length; i++) {
    for (const frag of r.baseline.placed[i].clip) {
      // frag coords are in region units; scale to world px to match hoverPt.
      const poly = frag.map((p) => ({ x: p.x * scale, y: p.y * scale }));
      if (pointInPolyWorld(hp, poly)) return i;
    }
  }
  return -1;
}

function pointInPolyWorld(p: Pt, poly: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x,
      yi = poly[i].y,
      xj = poly[j].x,
      yj = poly[j].y;
    if (
      yi > p.y !== yj > p.y &&
      p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi
    )
      inside = !inside;
  }
  return inside;
}

// Set the canvas clip to the current (closed) region polygon, in canvas pixels.
function clipToRegionPath() {
  if (state.points.length < 3) return;
  ctx.beginPath();
  ctx.moveTo(state.points[0].x, state.points[0].y);
  for (let i = 1; i < state.points.length; i++)
    ctx.lineTo(state.points[i].x, state.points[i].y);
  ctx.closePath();
  ctx.clip();
}

function updateStageHint() {
  if (state.layer === "walls") {
    if (state.walls.length === 0 && !state.wallStart) {
      stageHint.textContent = "Click to place a wall's start point.";
    } else if (state.wallStart) {
      stageHint.textContent = "Click to set the wall's end point.";
    } else if (!state.framing) {
      stageHint.textContent =
        "Add more walls, or press “Calculate framing”.";
    } else {
      stageHint.textContent = "";
    }
    return;
  }
  if (state.mode === "image" && !state.image) {
    stageHint.textContent = "Upload a floorplan image to begin.";
  } else if (!state.closed && state.points.length === 0) {
    stageHint.textContent =
      state.mode === "draw"
        ? "Click to place the first corner."
        : "Set the scale, then click to trace corners.";
  } else if (!state.closed) {
    stageHint.textContent = "Keep clicking corners; click the first point to close.";
  } else if (!state.result) {
    stageHint.textContent =
      "Click a side to set its real length, then press “Calculate layout”.";
  } else {
    stageHint.textContent = "";
  }
}

function getVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

applySystem("imperial");
resizeCanvas();
