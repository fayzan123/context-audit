// Builds Cursor-shaped fixture stores: same tables, same key grammar, same
// record shapes as the real 55 MB state.vscdb — but with NON-EMPTY cursorRules,
// which no record on the reference machine has (there is no .cursor/rules
// there, so all 1,548 recorded arrays are empty and the element shape is
// literally unobservable). A generator rather than a checked-in binary: a
// fixture nobody can read is a fixture nobody can correct, and this one has to
// encode a schema that is undocumented and unversioned.
//
// node:sqlite is imported LAZILY, inside the builders that need it: the module
// is absent on Node < 22.13, and a static import here would take down the two
// builders (and the caller's whole suite) that need no database at all.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Cursor's macOS user dir under an injected home; probed first by cursorUserDir(). */
const userDir = (home) => join(home, "Library", "Application Support", "Cursor", "User");

const sqlite = async () => (await import("node:sqlite")).DatabaseSync;

async function openStore(home) {
  const DatabaseSync = await sqlite();
  const gs = join(userDir(home), "globalStorage");
  mkdirSync(gs, { recursive: true });
  const db = new DatabaseSync(join(gs, "state.vscdb"));
  db.exec("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB)");
  db.exec("CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value BLOB)");
  return db;
}

/** 2026-03-02 and 2026-06-18 — a real span, and C1 predates any transcript window. */
export const C1 = "aaaaaaaa-1111-4111-8111-111111111111";
export const C2 = "bbbbbbbb-2222-4222-8222-222222222222";
export const C1_AT = 1772409600000;
export const C2_AT = 1781740800000;

/**
 * The main fixture: 2 conversations, 7 message records, 3 workspaces.
 *
 * Rule references appear in THREE different element shapes plus one nobody can
 * read, because Cursor's own writer is the only thing that knows the real
 * shape and this parser has to survive being wrong about it.
 */
export async function build(home) {
  rmSync(home, { recursive: true, force: true });
  const db = await openStore(home);
  const put = db.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)");

  put.run(`composerData:${C1}`, JSON.stringify({ _v: 3, composerId: C1, createdAt: C1_AT, context: { cursorRules: [] } }));
  put.run(`composerData:${C2}`, JSON.stringify({ _v: 3, composerId: C2, createdAt: C2_AT, context: { cursorRules: [] } }));

  const rules = {
    b1: [{ name: "typescript", relativePath: ".cursor/rules/typescript.mdc" }], // object w/ name
    b2: [{ relativePath: ".cursor/rules/testing.mdc" }], // path only → basename
    b3: ["typescript"], // bare string
    b4: [{ ruleName: "typescript" }, { name: "testing" }], // two elements, mixed fields
    b5: [{ id: 42 }], // unrecognizable → counted unparsed, never guessed at
  };
  let n = 0;
  for (const [b, cursorRules] of Object.entries(rules)) {
    const composer = n < 3 ? C1 : C2;
    put.run(
      `bubbleId:${composer}:${b}`,
      JSON.stringify({ _v: 2, type: 1, bubbleId: b, cursorRules, tokenCount: { inputTokens: 0, outputTokens: 0 } })
    );
    n++;
  }
  // An empty-rules bubble (the overwhelmingly common real case) and a literal
  // `null` value row, which JSON.parse happily RETURNS as null — observed for
  // real on the reference machine, and the reason the guard is on the parsed
  // value rather than on the parse throwing.
  put.run(`bubbleId:${C2}:b6`, JSON.stringify({ _v: 2, type: 2, bubbleId: "b6", cursorRules: [] }));
  put.run(`bubbleId:${C2}:b7`, "null");
  // The second table records the SAME (conversation, message) pair — b6 again —
  // so the dedupe has something to collapse rather than double-count.
  put.run(`messageRequestContext:${C2}:b6`, JSON.stringify({ cursorRules: [{ name: "testing" }], terminalFiles: [] }));
  put.run("checkpointId:zzz", JSON.stringify({ irrelevant: true }));
  db.close();

  const DatabaseSync = await sqlite();
  const mkws = (hash, folder, composerIds) => {
    const dir = join(userDir(home), "workspaceStorage", hash);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "workspace.json"), JSON.stringify({ folder }));
    const w = new DatabaseSync(join(dir, "state.vscdb"));
    w.exec("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB)");
    if (composerIds) {
      w.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)").run(
        "composer.composerData",
        JSON.stringify({ allComposers: composerIds.map((composerId) => ({ composerId })) })
      );
    }
    w.close();
  };
  mkws("ws1hash", "file:///Users/dev/alpha", [C1]);
  mkws("ws2hash", "file:///Users/dev/beta", [C2]);
  // A workspace with a folder but NO composer list: a real state on the
  // reference machine (4 of 7 resolved), and the reason attribution reports a
  // ratio instead of rounding up to "all".
  mkws("ws3hash", "file:///Users/dev/orphan", null);
  return home;
}

/**
 * The degradations that must be COUNTED rather than dropped: a conversation
 * whose createdAt is a seconds value (so it dates to 1970 and is rejected),
 * and one that records rules only at conversation level.
 */
export async function buildEdge(home) {
  rmSync(home, { recursive: true, force: true });
  const db = await openStore(home);
  const put = db.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)");
  const E1 = "cccccccc-3333-4333-8333-333333333333";
  const E2 = "dddddddd-4444-4444-8444-444444444444";
  // Seconds where the schema means milliseconds — the epoch guard's job.
  put.run(`composerData:${E1}`, JSON.stringify({ _v: 3, composerId: E1, createdAt: 946684800 }));
  put.run(`bubbleId:${E1}:x1`, JSON.stringify({ _v: 2, cursorRules: [{ name: "alpha" }] }));
  put.run(
    `composerData:${E2}`,
    JSON.stringify({ _v: 3, composerId: E2, createdAt: C2_AT, context: { cursorRules: [{ name: "beta" }] } })
  );
  // A `name` holding rule TEXT rather than a rule reference. The ledger's
  // promise is that it stores names and never content, so this is dropped as
  // unrecognized rather than truncated into a plausible-looking name.
  put.run(
    `bubbleId:${E2}:x2`,
    JSON.stringify({ _v: 2, cursorRules: [{ name: `Always ${"prefer const over let ".repeat(6)}when writing code.` }] })
  );
  // `cursorRules` that is not an array at all — a schema change, not a rule.
  put.run(`bubbleId:${E2}:x3`, JSON.stringify({ _v: 2, cursorRules: { renamedInSomeUpdate: ["typescript"] } }));
  db.close();
  return home;
}

/** A store that is not a SQLite database at all — the "opened, then nothing" path. */
export function buildGarbage(home) {
  rmSync(home, { recursive: true, force: true });
  const gs = join(userDir(home), "globalStorage");
  mkdirSync(gs, { recursive: true });
  writeFileSync(join(gs, "state.vscdb"), "this is not a database\n");
  return home;
}

/** A real SQLite file whose schema is not Cursor's — a Cursor update, simulated. */
export async function buildWrongShape(home) {
  rmSync(home, { recursive: true, force: true });
  const gs = join(userDir(home), "globalStorage");
  mkdirSync(gs, { recursive: true });
  const db = new (await sqlite())(join(gs, "state.vscdb"));
  db.exec("CREATE TABLE somethingElse (key TEXT PRIMARY KEY, value BLOB)");
  db.close();
  return home;
}

/** The audited project's own rules: one the store attached, one it never did. */
export function buildProject(cwd) {
  const dir = join(cwd, ".cursor", "rules");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "typescript.mdc"),
    "---\ndescription: TypeScript house rules.\nalwaysApply: true\n---\n\nPrefer const.\n"
  );
  writeFileSync(
    join(dir, "unused.mdc"),
    "---\ndescription: Installed here, never attached in the fixture store.\n---\n\nUnused.\n"
  );
  return cwd;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log("built", await build(process.argv[2] ?? "./cursor-fixture-home"));
}
