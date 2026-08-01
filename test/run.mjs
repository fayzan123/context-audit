#!/usr/bin/env node
// Regression corpus. Two halves, both required:
//   - every attack fixture (built from documented campaign shapes) MUST flag
//   - every benign fixture (legit DevOps/hook skills) MUST stay clean
// The benign half is the bias/variance guard: it pins the false-positive floor
// so the detectors generalize past the author's own directory.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const cli = join(root, "dist", "index.js");
const fixtures = join(root, "test", "fixtures");

let failures = 0;
const ok = (n) => console.log(`  ok: ${n}`);
const check = (name, cond, detail = "") => {
  if (cond) ok(name);
  else {
    console.error(`  FAIL: ${name}${detail ? ` — ${detail}` : ""}`);
    failures++;
  }
};

function scan(path) {
  try {
    const out = execFileSync("node", [cli, "scan", path, "--json"], { encoding: "utf8" });
    return { flags: JSON.parse(out).security.filter((f) => f.level === "flag"), code: 0 };
  } catch (e) {
    const out = e.stdout ?? "";
    let flags = [];
    try {
      flags = JSON.parse(out).security.filter((f) => f.level === "flag");
    } catch {}
    return { flags, code: e.status ?? -1 };
  }
}

// --- Attack fixtures: each must flag, and specifically on the named check ---
console.log("ATTACK fixtures (must flag):");
const attacks = [
  ["clawhavoc-shape", ["download-execute", "password-protected-archive"]],
  ["dynamic-exec", ["dynamic-context-exec"]],
  ["dynamic-exec", ["broad-tool-grant"]],
  ["prose-exfil", ["injection-phrase"]],
  ["plugin-promo", ["plugin-manifest"]],
  ["plugin-promo", ["plugin-hooks"]],
  ["plugin-promo", ["background-monitor"]],
  ["unicode-smuggle", ["hidden-unicode"]],
  ["split-evasion", ["download-execute"]],
];
for (const [fixture, wantChecks] of attacks) {
  const { flags, code } = scan(join(fixtures, fixture));
  const got = new Set(flags.map((f) => f.check));
  const hit = wantChecks.some((c) => got.has(c));
  check(`${fixture} flags [${wantChecks.join("|")}]`, hit, `got: ${[...got].join(", ") || "none"}`);
  if (fixture === "split-evasion") {
    check("split-evasion caught despite zero-width keyword splitting", code === 1);
  }
}

// --- Benign fixtures: must produce ZERO flags (info is fine) ---
console.log("BENIGN fixtures (must stay clean):");
for (const fixture of ["benign-devops", "benign-hook"]) {
  const { flags, code } = scan(join(fixtures, fixture));
  check(
    `${fixture} produced ZERO flags`,
    flags.length === 0,
    flags.map((f) => `${f.check}@${f.file}:${f.line}`).join("; ")
  );
  check(`${fixture} exits 0`, code === 0);
}

// --- tag-character payload is decoded in the evidence ---
const smuggle = scan(join(fixtures, "unicode-smuggle"));
const decoded = smuggle.flags.find((f) => f.check === "hidden-unicode" && /decodes to/.test(f.evidence));
check("unicode-smuggle decodes the hidden payload into evidence", !!decoded);

// --- severity/confidence present on every finding ---
const all = scan(join(fixtures, "clawhavoc-shape"));
check(
  "findings carry severity and confidence",
  all.flags.every((f) => f.severity && f.confidence)
);

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed`);
  process.exit(1);
}
console.log("\nall assertions passed");
