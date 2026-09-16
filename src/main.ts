import "./style.css";
import type { Pt } from "./geometry";
import type { Stagger } from "./packer";
import { optimalWithReuse } from "./offcut";
import type { ReuseResult } from "./offcut";
import { PRESETS, formatArea } from "./units";
import type { System } from "./units";

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
  $("#results").hidden = true;
  draw();
});
$("#calc-btn").addEventListener("click", calculate);

// Canvas interaction
canvas.addEventListener("mousemove", (e) => {
  state.hoverPt = evtPt(e);
  draw();
});
canvas.addEventListener("mouseleave", () => {
  state.hoverPt = null;
  draw();
});
canvas.addEventListener("click", (e) => {
  const p = evtPt(e);
  if (state.calib === "picking") {
    state.calibPts.push(p);
    if (state.calibPts.length === 2) finishCalibration();
    draw();
    return;
  }
  // Clicking on the canvas after a shape is finished starts a fresh one, so you
  // don't have to hunt for "Clear shape" to redraw.
  if (state.closed) {
    state.points = [];
    state.closed = false;
    state.result = null;
    $("#results").hidden = true;
    state.points.push(p);
    draw();
    return;
  }
  // Close if clicking near the first point.
  if (state.points.length >= 3) {
    const first = state.points[0];
    if (dist(first, p) < SNAP_CLOSE_PX) {
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

function evtPt(e: MouseEvent): Pt {
  const rect = canvas.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
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

  if (state.mode === "image" && state.image) {
    drawImageFit(state.image, w, h);
  } else {
    drawGrid(w, h);
  }

  // Draw packed sheets under the outline.
  if (state.result) drawSheets(state.result);

  drawPolygon();
  drawCalibration();
  updateStageHint();
}

function drawGrid(w: number, h: number) {
  ctx.fillStyle = getVar("--grid-bg");
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = getVar("--grid-line");
  ctx.lineWidth = 1;
  for (let x = 0; x <= w; x += GRID_PX) {
    ctx.beginPath();
    ctx.moveTo(x + 0.5, 0);
    ctx.lineTo(x + 0.5, h);
    ctx.stroke();
  }
  for (let y = 0; y <= h; y += GRID_PX) {
    ctx.beginPath();
    ctx.moveTo(0, y + 0.5);
    ctx.lineTo(w, y + 0.5);
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
  ctx.lineWidth = 2;
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
    ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
    ctx.fill();
  }
  // Highlight the closable first point.
  if (!state.closed && pts.length >= 3 && state.hoverPt) {
    if (dist(pts[0], state.hoverPt) < SNAP_CLOSE_PX) {
      ctx.strokeStyle = getVar("--accent");
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(pts[0].x, pts[0].y, 8, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
}

function drawCalibration() {
  if (state.calibPts.length === 0) return;
  ctx.strokeStyle = getVar("--warn");
  ctx.fillStyle = getVar("--warn");
  ctx.lineWidth = 2;
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
  ctx.lineWidth = 1.25;
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
    stageHint.textContent = "Shape closed. Press “Calculate layout”.";
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
