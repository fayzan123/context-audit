#!/usr/bin/env node
// Builds the dashboard into a single self-contained HTML file. esbuild is a
// devDependency only — the published package keeps zero runtime dependencies,
// and what ships in dist/ stays hand-readable (bundled, not minified).
import { build } from "esbuild";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const frontend = join(root, "src", "ui", "frontend");

// The page bundle: everything the browser runs, as one IIFE.
const page = await build({
  entryPoints: [join(frontend, "main.ts")],
  bundle: true,
  write: false,
  format: "iife",
  target: "es2022",
  charset: "utf8",
});

// The renderer alone, as ESM — the frontend smoke test imports this into Node
// and renders fixture payloads without a browser rig. render.ts is DOM-free by
// contract; bundling it separately keeps that contract enforced (a DOM API
// sneaking in would crash the test, not just a code review).
const render = await build({
  entryPoints: [join(frontend, "render.ts")],
  bundle: true,
  write: false,
  format: "esm",
  target: "es2022",
  charset: "utf8",
});

const css = readFileSync(join(frontend, "style.css"), "utf8");
// "</script>" inside the bundle would terminate the inline tag mid-payload.
const js = page.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");

const html = readFileSync(join(frontend, "page.html"), "utf8")
  .replace("/*__CSS__*/", () => css)
  .replace("/*__JS__*/", () => js);

mkdirSync(join(root, "dist", "ui"), { recursive: true });
writeFileSync(join(root, "dist", "ui.html"), html);
writeFileSync(join(root, "dist", "ui", "render.js"), render.outputFiles[0].text);
console.log(`built dist/ui.html (${(Buffer.byteLength(html) / 1024).toFixed(1)} KB) and dist/ui/render.js`);
