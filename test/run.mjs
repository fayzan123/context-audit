#!/usr/bin/env node
// Regression harness: the malicious fixture must flag on every vector class,
// the benign-tricky fixture (built from real false positives) must never flag.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const cli = join(root, "dist", "index.js");
const fixtures = join(root, "test", "fixtures");

let failures = 0;
const check = (name, cond, detail = "") => {
  if (cond) console.log(`  ok: ${name}`);
  else {
    console.error(`  FAIL: ${name}${detail ? ` — ${detail}` : ""}`);
    failures++;
  }
};

function run(args) {
  try {
    return { out: execFileSync("node", [cli, ...args], { encoding: "utf8" }), code: 0 };
  } catch (e) {
    return { out: e.stdout ?? "", code: e.status ?? -1 };
  }
}

console.log("audit of fixtures directory (--json --no-history):");
const audit = run([fixtures, "--json", "--no-history"]);
check("exit code 1 (malicious fixture present)", audit.code === 1, `got ${audit.code}`);
const result = JSON.parse(audit.out);

const flags = result.security.filter((f) => f.level === "flag");
const malFlagChecks = new Set(flags.filter((f) => f.skill === "malicious-skill").map((f) => f.check));
for (const expected of ["injection-phrase", "hidden-unicode", "base64-payload", "pipe-to-shell", "html-comment"]) {
  check(`malicious-skill flagged: ${expected}`, malFlagChecks.has(expected));
}
check(
  "malicious-skill name masquerade caught",
  result.content.nameMismatches.some((m) => m.skill === "malicious-skill")
);

const benignFlags = flags.filter((f) => f.skill === "benign-tricky");
check(
  "benign-tricky produced ZERO flags",
  benignFlags.length === 0,
  benignFlags.map((f) => `${f.check}@${f.file}:${f.line} [${f.evidence}]`).join("; ")
);

console.log("scan subcommand:");
check("scan malicious-skill exits 1", run(["scan", join(fixtures, "malicious-skill")]).code === 1);
check("scan benign-tricky exits 0", run(["scan", join(fixtures, "benign-tricky")]).code === 0);

console.log("output modes:");
const agent = run([fixtures, "--agent", "--no-history"]);
const agentObj = JSON.parse(agent.out);
check("--agent output parses and carries flags", Array.isArray(agentObj.security?.flags) && agentObj.security.flags.length > 0);
check("--agent aggregates info findings to counts", typeof agentObj.security?.infoCounts === "object");

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed`);
  process.exit(1);
}
console.log("\nall assertions passed");
