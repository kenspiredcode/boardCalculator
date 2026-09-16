# OSB Sheet Calculator

A single-page web app for figuring out how many standard OSB sheets you need to
cover an area in a **running-bond (brick) layout** with staggered joints.

Draw a floorplan on a grid, or upload an image of one and set its scale, assign
real-world dimensions, then get an optimal sheet layout with a full count of
whole vs. cut boards and total waste.

## Features

- **Two input modes**
  - **Draw** — click corners on a grid; edges snap to be axis-aligned
    (rectilinear), and the shape closes when you click the first corner again.
  - **Upload image** — drop in a floorplan photo, calibrate the scale by drawing
    a line of known length, then trace the outline on top.
- **Imperial or metric** — 4×8 ft or 1220×2440 mm sheets by default, both the
  sheet size and units are editable.
- **Running-bond packing engine** — lays staggered rows of sheets (½, ⅓, or no
  offset), tries both sheet orientations, and keeps whichever uses fewer boards.
- **Offcut reuse** — after the baseline layout, leftovers from cut boards are
  decomposed into real rectangles and reused to supply later cut pieces before
  buying a fresh board. An offcut can serve any row it's tall enough for (trimmed
  down; no rotation), with a ±15% seam flex to make near-fits land and a 20%
  minimum-piece rule to avoid slivers. Reused pieces are shown in a distinct
  colour.
- **Seam-position search** — sweeps the grid origin (horizontal and vertical
  phase) across both orientations, scoring each candidate by fresh boards after
  reuse, then a joint-spacing penalty (keeping running-bond joints well apart),
  then waste. On irregular rooms this compounds with reuse — e.g. an L-shaped
  room drops from 5 boards to 4.
- **Rectilinear shapes** — any outline of horizontal/vertical edges works
  (rectangle, L, T, U, staircase). Drawing snaps edges to axis-aligned; diagonal
  and curved walls are not supported.
- **Honest counts** — boards to buy (after reuse), whole sheets, cut sheets,
  total area, and waste percentage.
- **Handles L-shapes and other concave rectilinear rooms** via polygon
  triangulation and per-sheet clipping, so the covered area is exact.

## Running locally

```bash
npm install
npm run dev
```

Then open the printed local URL.

## Building

```bash
npm run build
```

The static site is emitted to `dist/`. The Vite `base` is set to `./` (relative),
so the build works served from a subpath (a GitHub Pages project site) or the
domain root.

## Deploying to GitHub Pages

A workflow at `.github/workflows/deploy.yml` builds and deploys on every push to
`main`. To enable it once the repo is on GitHub:

1. Push the repo to GitHub.
2. In the repo, go to **Settings → Pages** and set **Source** to
   **GitHub Actions**.
3. Push to `main` (or run the workflow manually). The site publishes to
   `https://<user>.github.io/<repo>/`.

## How the packing works

The region is a rectilinear polygon in real-world units. The packer:

1. Triangulates the polygon (ear clipping) into convex pieces.
2. Lays rows of sheet-height across the bounding box, offsetting each row's
   start by the chosen stagger for the brick pattern.
3. Clips every candidate sheet against the region. Sheets fully outside are
   dropped; partial sheets are marked as cut.
4. Runs the offcut-reuse pass: each cut board's covered area and its leftover are
   decomposed into exact rectangles (`rectdecomp.ts`). A cut board is saved when
   every rectangle it needs can be supplied from the running inventory of
   leftovers (tall-enough offcut, ±15% seam flex, ≥20% min piece); otherwise one
   board is bought and its leftover rectangles are banked for later.
5. Reports boards-to-buy and waste, choosing the orientation that needs fewer
   fresh boards after reuse (ties broken by lower waste).
