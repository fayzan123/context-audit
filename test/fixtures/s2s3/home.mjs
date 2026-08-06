// The S2/S3 fixture: one home, one project, one ledger, shaped so that every
// facet the inventory join computes has exactly one row that exercises it and
// a hand-checkable number behind it.
//
// Written as a GENERATOR rather than a checked-in tree because every figure the
// join reports is relative to the scan's own clock — windows, "N days ago",
// ISO-week bins, the plugin update boundary. A frozen tree would drift out of
// every window it is meant to sit inside within a week of being committed.
//
// Two rules keep it from rotting:
//   1. every timestamp derives from ONE injected `now`, so the whole fixture
//      moves together — and that `now` is the instant the fixture is written,
//      never a truncated one. The payload's own clock (Date.now(), a second or
//      two later) then reads "40 days ago" as exactly 40 whole days, because
//      the floor is taken over 40d + a couple of seconds. Rounding the anchor
//      down to midnight would look tidier and would produce a 41 for every run
//      that happened to straddle midnight UTC.
//   2. day offsets that feed ISO-week arithmetic are multiples of 7. A week
//      denominator (`spread.weeksSinceFirst`) computed from a 78-day-old first
//      fire lands on 12 or 13 depending on which weekday the suite runs, and a
//      suite that only fails on Mondays is worse than no suite.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const DAY = 86_400_000;
export const MS_PER_DAY = DAY;

/** The fixture's single clock. Tests may pass their own to freeze it entirely. */
export function anchorNow(nowMs = Date.now()) {
  return nowMs;
}

const write = (path, text) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};
const jsonl = (path, objects) => write(path, objects.map((o) => JSON.stringify(o)).join("\n") + "\n");

/**
 * node:sqlite announces itself with an ExperimentalWarning at import time. The
 * scanner mutes its own import (src/sources/cursordb.ts); this fixture imports
 * the module directly to WRITE a store, so it mutes the same one line the same
 * way rather than leaving a warning in every run's output.
 */
async function loadSqlite() {
  const original = process.emitWarning;
  process.emitWarning = (warning, ...rest) => {
    const first = rest[0];
    const type = typeof first === "string" ? first : first?.type;
    const message = warning instanceof Error ? warning.message : String(warning);
    if (type === "ExperimentalWarning" && /\bSQLite\b/.test(message)) return;
    original.call(process, warning, ...rest);
  };
  try {
    return await import("node:sqlite");
  } catch {
    // Node < 22.13: the module is simply absent, and every cursor-store fact
    // the caller wanted is skipped rather than faked.
    return undefined;
  } finally {
    process.emitWarning = original;
  }
}

/**
 * Cursor's global conversation store, written with the shape src/sources/
 * cursordb.ts reads: `composerData:<id>` rows carry the only timestamp that
 * exists (per conversation), `bubbleId:<composer>:<bubble>` rows carry the rule
 * attachments.
 *
 * `mode`:
 *   "ok"     — a readable store with two conversations, 300 days apart;
 *   "broken" — a file where the store should be, which is what a degraded read
 *              looks like on a real machine (a Cursor schema change, a store
 *              held open in WAL mode) and must leave rows UNTRACKED, not zeroed;
 *   "none"   — no store at all.
 * Returns whether a readable store was actually produced.
 */
export async function writeCursorStore(home, now, mode) {
  const store = join(home, "Library", "Application Support", "Cursor", "User", "globalStorage", "state.vscdb");
  if (mode === "none") return false;
  if (mode === "broken") {
    write(store, "this is not a database\n");
    return false;
  }
  const sqlite = await loadSqlite();
  if (!sqlite) return false;
  mkdirSync(dirname(store), { recursive: true });
  const db = new sqlite.DatabaseSync(store);
  try {
    db.exec("CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value BLOB)");
    const put = db.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)");
    // The old conversation is the whole point of the cursor window: it reaches
    // back ten months, far past any claude transcript, and folding it into the
    // merged window would turn "none in 20d" into a claim about last winter.
    put.run("composerData:c1", JSON.stringify({ createdAt: now - 300 * DAY, context: {} }));
    put.run("composerData:c2", JSON.stringify({ createdAt: now - 5 * DAY, context: {} }));
    put.run("bubbleId:c1:b1", JSON.stringify({ cursorRules: [{ name: "myrule" }] }));
    // A path-shaped reference reduces to the same dispatch token as the object
    // form, so both spellings land on one row.
    put.run("bubbleId:c2:b1", JSON.stringify({ cursorRules: ["rules/myrule.mdc"] }));
    put.run("bubbleId:c2:b2", JSON.stringify({ cursorRules: [{ name: "otherrule" }] }));
  } finally {
    db.close();
  }
  return true;
}

/**
 * Build the fixture. Returns the paths a scan needs plus the handful of ids and
 * timestamps the assertions have to name (a ledger id the test checks for
 * presence, the dates the payload should echo back).
 */
export async function build(root, now = anchorNow(), opts = {}) {
  rmSync(root, { recursive: true, force: true });
  const iso = (msAgo) => new Date(now - msAgo).toISOString();
  const home = join(root, "home");
  const proj = join(root, "proj");
  const ledgerHome = join(root, "ledger");
  const skills = join(home, ".claude", "skills");
  mkdirSync(skills, { recursive: true });
  mkdirSync(proj, { recursive: true });

  const skill = (dir, name, desc, body = "Do the thing.\n") =>
    write(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${desc}\n---\n\n${body}`);

  // --- claude skills, one per facet ----------------------------------------
  // staple: one fire a week for twelve weeks — the spread/rhythm row.
  skill(join(skills, "staple"), "staple", "Long-running helper used across many weeks.");
  // one-burst: every fire inside a day and a half, two months ago.
  skill(join(skills, "one-burst"), "one-burst", "Tried over a couple of days and dropped.");
  // quiet-one: two clusters months apart, so the silence has a prior gap to be
  // measured against.
  skill(join(skills, "quiet-one"), "quiet-one", "Fires in two clusters months apart.");
  // twins: byte-identical descriptions, and they co-fire in one session.
  const twinDesc = "Review the code and report findings with evidence.";
  skill(join(skills, "review-a"), "review-a", twinDesc);
  skill(join(skills, "review-b"), "review-b", twinDesc);
  // refs: one bundled file that exists and one that does not.
  skill(
    join(skills, "with-refs"),
    "with-refs",
    "Has a bundled reference and a missing one.",
    "See [present](reference/present.md) and [absent](reference/absent.md).\n"
  );
  write(join(skills, "with-refs", "reference", "present.md"), "here\n");
  // Never fired, and created by THIS run — too new to be called dead weight.
  skill(join(skills, "dead-weight"), "dead-weight", "Never fired, pays rent every session. ".repeat(8));
  // caller: a single TYPED fire (no auto dispatch ever), and its body names the
  // disabled skill — the was-disabling-safe evidence.
  skill(join(skills, "caller"), "caller", "Calls the retired skill.", "When you need it, use the /retired skill.\n");
  // shared: same dispatch name and same body under codex — cross-provider.
  skill(join(skills, "shared"), "shared", "Exists under two providers.", "identical body\n");
  // hooked-a / hooked-b: one typed fire each, in sessions a hook of the OTHER
  // provider (a) and of the SAME provider (b) also recorded. See the seeded
  // hook events below.
  skill(join(skills, "hooked-a"), "hooked-a", "Typed in a session a codex hook also saw.");
  skill(join(skills, "hooked-b"), "hooked-b", "Typed in a session a claude hook owns.");

  // Disabled, and referenced by `caller`.
  skill(join(home, ".claude", "skills-disabled", "retired"), "retired", "No longer enabled.");

  // --- agents: dispatch-tracked, one launched and one never ----------------
  write(join(home, ".claude", "agents", "prober.md"), "---\nname: prober\ndescription: Probes things.\n---\n\nProbe.\n");
  write(join(home, ".claude", "agents", "idle-agent.md"), "---\nname: idle-agent\ndescription: Never launched.\n---\n\nIdle.\n");

  // --- plugins --------------------------------------------------------------
  // pack: installed BEFORE the ledger horizon (so install→first-fire cannot be
  // stated), updated 20 days ago (so the update boundary has a symmetric prior
  // window), and holding a superseded 1.0.0 in the cache.
  const cache = join(home, ".claude", "plugins", "cache", "mp");
  for (const v of ["1.0.0", "2.0.0"]) {
    skill(join(cache, "pack", v, "skills", "packed"), "packed", `Packed skill at ${v}.`, `body ${v}\n`);
  }
  skill(join(cache, "pack", "2.0.0", "skills", "idle"), "idle", "Shipped by a plugin, never fired since it arrived.");
  // late: installed INSIDE the horizon, so install→first-fire is a real span,
  // and UPDATED since the last recorded scan — the one plugin `delta` may call
  // updated.
  skill(join(cache, "late", "1.0.0", "skills", "fresh"), "fresh", "Arrived after tracking began.");
  // newbie: first installed since the last scan. It is a NEW INSTALL, already
  // counted in the items diff — calling it an update would invent a version
  // change that never happened.
  skill(join(cache, "newbie", "1.0.0", "skills", "arrived"), "arrived", "Installed since the previous scan.");
  write(
    join(home, ".claude", "plugins", "installed_plugins.json"),
    JSON.stringify(
      {
        version: 2,
        plugins: {
          "pack@mp": [
            {
              scope: "user",
              installPath: join(cache, "pack", "2.0.0"),
              version: "2.0.0",
              installedAt: iso(130 * DAY),
              lastUpdated: iso(20 * DAY),
            },
          ],
          "late@mp": [
            {
              scope: "user",
              installPath: join(cache, "late", "1.0.0"),
              version: "1.0.0",
              installedAt: iso(60 * DAY),
              lastUpdated: iso(7 * DAY),
            },
          ],
          "newbie@mp": [
            {
              scope: "user",
              installPath: join(cache, "newbie", "1.0.0"),
              version: "1.0.0",
              installedAt: iso(5 * DAY),
              lastUpdated: iso(5 * DAY),
            },
          ],
        },
      },
      null,
      2
    )
  );

  // --- codex ----------------------------------------------------------------
  write(join(home, ".codex", "AGENTS.md"), "Global codex instructions.\n");
  write(join(home, ".codex", "prompts", "ship.md"), "Ship it.\n");
  // Same name, byte-identical body as the claude skill above.
  write(join(home, ".codex", "prompts", "shared.md"), "identical body\n");

  // --- cursor rule (project-scoped) ----------------------------------------
  write(join(proj, ".cursor", "rules", "myrule.mdc"), "---\ndescription: A project rule.\n---\n\nFollow it.\n");

  // --- claude transcripts ---------------------------------------------------
  // Two typed fires 20 and 18 days ago: they set the claude window, and their
  // sessions are the ones the seeded hooks below claim.
  const projects = join(home, ".claude", "projects", "-proj");
  const typedLine = (name, sessionId, daysAgo) => ({
    type: "user",
    message: { role: "user", content: `<command-name>/${name}</command-name>\n<command-args></command-args>` },
    uuid: `u-${name}`,
    timestamp: iso(daysAgo * DAY),
    sessionId,
    entrypoint: "cli",
    cwd: proj,
  });
  jsonl(join(projects, "sessHA.jsonl"), [typedLine("hooked-a", "sessHA", 20)]);
  jsonl(join(projects, "sessHB.jsonl"), [typedLine("hooked-b", "sessHB", 18)]);
  // The launched agent's own transcript — the only place a run's cost can be
  // read without a confound. Two lines share one message id (one response split
  // across blocks) and must be counted ONCE; the third is a second response.
  const usageLine = (id, ms, usage) => ({
    type: "assistant",
    isSidechain: true,
    message: { role: "assistant", id, model: "claude-opus-5", usage, content: [] },
    uuid: `a-${id}-${ms}`,
    timestamp: iso(19 * DAY),
    sessionId: "sessA0",
    cwd: proj,
  });
  jsonl(join(projects, "sessA0", "subagents", "agent-agentabc.jsonl"), [
    usageLine("m1", 1, { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 10, cache_read_input_tokens: 5 }),
    usageLine("m1", 2, { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 10, cache_read_input_tokens: 5 }),
    usageLine("m2", 3, { input_tokens: 20, output_tokens: 15 }),
  ]);

  // --- codex rollout --------------------------------------------------------
  // A typed /ship in session sessCX — the session a CLAUDE hook (seeded below)
  // also names. Cross-provider, so it must still be banked.
  const rolloutTs = iso(13 * DAY);
  jsonl(join(home, ".codex", "sessions", "2026", "01", "01", "rollout-sessCX.jsonl"), [
    { timestamp: rolloutTs, type: "session_meta", payload: { id: "sessCX", cwd: proj } },
    {
      timestamp: rolloutTs,
      type: "response_item",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text: "/ship please" }] },
    },
  ]);

  // --- the ledger -----------------------------------------------------------
  const events = [];
  let seq = 0;
  const fire = (name, kind, daysAgo, extra = {}) => {
    const e = {
      v: 1,
      id: `${extra.session}:tool${seq++}`,
      ts: iso(daysAgo * DAY),
      provider: extra.provider ?? "claude",
      kind,
      name,
      channel: extra.channel ?? "auto",
      sessionId: extra.session,
      project: extra.project ?? proj,
    };
    for (const k of ["model", "entrypoint", "agent", "outcome"]) if (extra[k]) e[k] = extra[k];
    events.push(e);
    return e;
  };

  // staple: 12 fires, one per week, offsets multiples of 7 so the ISO-week
  // denominator is the same on every weekday. Two models, both entrypoints, and
  // ONE fire from inside a sidechain.
  for (let k = 0; k < 12; k++) {
    fire("staple", "skill", 7 * k, {
      session: `sessS${k}`,
      model: k % 3 === 0 ? "claude-opus-5" : "claude-sonnet-5",
      entrypoint: k % 4 === 0 ? "sdk-cli" : "cli",
      ...(k === 5 ? { agent: { id: "sideagent", type: "prober" } } : {}),
    });
  }
  // one-burst: four fires inside a day and a half, sixty days ago.
  for (let k = 0; k < 4; k++) fire("one-burst", "skill", 60 + k * 0.5, { session: `sessB${k}` });
  // quiet-one: a pair 100/99 days ago and one 40 days ago — a 59-day prior gap.
  fire("quiet-one", "skill", 100, { session: "sessQ0" });
  fire("quiet-one", "skill", 99, { session: "sessQ0" });
  fire("quiet-one", "skill", 40, { session: "sessQ1" });
  // twins: one shared session, one session of review-a's own.
  fire("review-a", "skill", 10, { session: "sessR0" });
  fire("review-b", "skill", 10, { session: "sessR0" });
  fire("review-a", "skill", 9, { session: "sessR1" });
  // pack:packed — one fire since the 20-day-old update, two in the 20 days before it.
  fire("pack:packed", "skill", 5, { session: "sessP0" });
  fire("pack:packed", "skill", 30, { session: "sessP1" });
  fire("pack:packed", "skill", 25, { session: "sessP2" });
  // late:fresh — first fire 15 days after the plugin arrived.
  fire("late:fresh", "skill", 45, { session: "sessL0" });
  fire("late:fresh", "skill", 10, { session: "sessL1" });
  // Agent launches. The FIRST carries the spawned agent's id — on an agent row
  // that field names what the launch produced, not a sidechain it happened in.
  fire("prober", "agent", 6, { session: "sessA0", agent: { id: "agentabc", type: "prober" } });
  fire("prober", "agent", 3, { session: "sessA1" });
  // Typed-only: never model-dispatched.
  fire("caller", "skill", 8, { channel: "typed", session: "sessC0" });
  // Codex prompt fire, and a passive AGENTS.md load in a session of its OWN —
  // a load is not an invocation, so that session belongs in the denominator and
  // nowhere else.
  fire("ship", "prompt", 12, { provider: "codex", channel: "typed", session: "sessX0", project: "/w/beta" });
  events.push({
    v: 1,
    id: "sessX1:/w/beta",
    ts: iso(12 * DAY),
    provider: "codex",
    kind: "instructions",
    name: "/w/beta",
    channel: "load",
    sessionId: "sessX1",
    project: "/w/beta",
  });
  // A fat-fingered dispatch of a name nothing installs.
  fire("stapel", "skill", 15, { session: "sessN0" });

  // --- seeded hook events ---------------------------------------------------
  // The typed channel is single-writer PER SESSION — and a session is
  // (provider, id), because two harnesses hand out ids of the same shape.
  const hook = (e) => {
    events.push({ v: 1, project: proj, hook: true, channel: "typed", ...e });
    return e.id;
  };
  // A CODEX hook that saw session "sessHA". The claude transcript's typed fire
  // in ITS session sessHA must still be banked.
  hook({
    id: "hookcodex:sessHA:ghostprompt",
    ts: iso(19 * DAY),
    provider: "codex",
    kind: "prompt",
    name: "ghostprompt",
    sessionId: "sessHA",
    project: "/w/beta",
  });
  // A CLAUDE hook that owns session "sessHB": the transcript's copy of that
  // session's typed fire is the SAME fire and must not be banked twice.
  hook({
    id: "hookclaude:sessHB:hooked-b",
    ts: iso(18 * DAY),
    provider: "claude",
    kind: "command",
    name: "hooked-b",
    sessionId: "sessHB",
  });
  // A CLAUDE hook that saw session "sessCX". The codex rollout's typed /ship in
  // ITS session sessCX must still be banked.
  hook({
    id: "hookclaude:sessCX:ghostcmd",
    ts: iso(13 * DAY),
    provider: "claude",
    kind: "command",
    name: "ghostcmd",
    sessionId: "sessCX",
  });

  const usage = join(ledgerHome, "usage");
  mkdirSync(usage, { recursive: true });
  const byMonth = new Map();
  for (const e of events) {
    const f = `events-${e.ts.slice(0, 7)}.jsonl`;
    byMonth.set(f, (byMonth.get(f) ?? "") + JSON.stringify(e) + "\n");
  }
  for (const [f, data] of byMonth) writeFileSync(join(usage, f), data);
  // The horizon sits between the two plugin installs on purpose: `pack` arrived
  // before it (so install→first-fire is unknowable) and `late` after it.
  writeFileSync(join(usage, "meta.json"), JSON.stringify({ schemaVersion: 1, trackedSince: iso(110 * DAY) }) + "\n");
  // Two prior scans, so `delta` has a baseline and `growth` has more than one
  // owned observation. The listing crosses its budget between them — that
  // crossing is the date a quiet skill's trend gets read against.
  const snapshots = [
    { daysAgo: 30, items: 10, enabled: 9, injectedChars: 3000, listingChars: 7000 },
    { daysAgo: 14, items: 12, enabled: 11, injectedChars: 4200, listingChars: 9000 },
  ];
  writeFileSync(
    join(usage, "snapshots.jsonl"),
    snapshots
      .map((s) =>
        JSON.stringify({
          ts: iso(s.daysAgo * DAY),
          items: s.items,
          enabled: s.enabled,
          injectedChars: s.injectedChars,
          byProvider: { claude: s.items },
          listingChars: s.listingChars,
        })
      )
      .join("\n") + "\n"
  );

  const cursorReadable = await writeCursorStore(home, now, opts.cursor ?? "ok");

  return {
    home,
    cwd: proj,
    ledgerHome,
    now,
    iso,
    cursorReadable,
    /** Ids the assertions name directly. */
    ids: {
      // Transcript-derived typed events. A is banked (a codex hook claimed a
      // codex session of the same name); B is not (a claude hook owns it).
      typedFromTranscriptA: `sessHA:${iso(20 * DAY)}:hooked-a`,
      typedFromTranscriptB: `sessHB:${iso(18 * DAY)}:hooked-b`,
      typedFromRollout: `sessCX:${rolloutTs}:ship`,
      claudeHookOwningSessHB: "hookclaude:sessHB:hooked-b",
    },
    /** Dates the payload should echo back verbatim. */
    dates: {
      claudeWindowStart: iso(20 * DAY),
      claudeWindowEnd: iso(18 * DAY),
      codexWindow: rolloutTs,
      cursorWindowStart: new Date(now - 300 * DAY).toISOString(),
      trackedSince: iso(110 * DAY),
      packUpdatedAt: iso(20 * DAY),
      lateUpdatedAt: iso(7 * DAY),
      budgetCrossedAt: iso(14 * DAY),
      lastSnapshot: iso(14 * DAY),
    },
  };
}
