import { defineConfig } from "vite";

// For GitHub Pages project sites the app is served from
// https://<user>.github.io/<repo>/, so assets must be referenced relative to
// that subpath. Using a relative base ("./") makes the build work whether it's
// served from a subpath (project page) or the domain root (user page / local).
export default defineConfig({
  base: "./",
  build: {
    outDir: "dist",
  },
});
