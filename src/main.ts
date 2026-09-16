import "./style.css";
import type { Pt } from "./geometry";
import type { Stagger } from "./packer";
import { optimalWithReuse } from "./offcut";
import type { ReuseResult } from "./offcut";
import { PRESETS, formatArea } from "./units";
import type { System } from "./units";
import {
  resolvePolygon,
  edgeRealLength,
  edgeMidpoint,
  edgesOf,
} from "./dimensions";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

type Mode = "draw" | "image";
type CalibState = "idle" | "picking";

interface State {
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
}

const state: State = {
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
  if (!wantPan) return;
  const s = screenPt(e);
  state.panning = true;
  dragMoved = false;
  state.panStart = { x: s.x, y: s.y, panX: state.panX, panY: state.panY };
  canvas.style.cursor = "grabbing";
  e.preventDefault();
});
window.addEventListener("mousemove", (e) => {
  if (!state.panning || !state.panStart) return;
  const s = screenPt(e);
  if (Math.hypot(s.x - state.panStart.x, s.y - state.panStart.y) > 3)
    dragMoved = true;
  state.panX = state.panStart.panX + (s.x - state.panStart.x);
  state.panY = state.panStart.panY + (s.y - state.panStart.y);
  draw();
});
window.addEventListener("mouseup", () => {
  if (state.panning) {
    state.panning = false;
    state.panStart = null;
    canvas.style.cursor = spaceHeld ? "grab" : "crosshair";
    draw();
  }
});

// Canvas interaction
canvas.addEventListener("mousemove", (e) => {
  if (state.panning) return; // panning handled on window
  state.hoverPt = evtPt(e);
  // Pointer cursor when hovering a side of a finished shape (it's editable).
  canvas.style.cursor =
    state.closed && edgeNear(state.hoverPt) !== -1 ? "pointer" : "crosshair";
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

// Snap a new vertex to be axis-aligned with the previous one (rectilinear).
function snapAxis(p: Pt): Pt {
  if (state.points.length === 0) return p;
  const prev = state.points[state.points.length - 1];
  const dx = Math.abs(p.x - prev.x);
  const dy = Math.abs(p.y - prev.y);
  return dx < dy ? { x: prev.x, y: p.y } : { x: p.x, y: prev.y };
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

  // Draw packed sheets under the outline.
  if (state.result) drawSheets(state.result);

  drawPolygon();
  drawCalibration();

  ctx.restore();

  // Dimension labels are drawn in screen space (after restore) so their text
  // stays a constant size regardless of zoom.
  if (state.closed) drawDimensions();
  updateStageHint();
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
  ctx.restore();
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
