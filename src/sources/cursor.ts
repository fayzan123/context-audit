import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { LEDGER_SCHEMA_VERSION } from "../ledger.js";
import { parseFrontmatter } from "../skills.js";
import type { HistoryFacts, Injection, LedgerEvent, Skill, SkillUsage } from "../types.js";
import { cursorStorePath, lastCursorStoreRead, readCursorStore } from "./cursordb.js";
import type { SourceAdapter, SourceContext } from "./types.js";

/** Every rule file under .cursor/rules, recursively — nested rule dirs are a thing in monorepos. */
function ruleFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  const walk = (d: string): void => {
    // statSync below follows symlinks, so a directory linking to an ancestor
    // would recurse forever without this.
    try {
      const real = realpathSync(d);
      if (seen.has(real)) return;
      seen.add(real);
    } catch {
      return;
    }
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const p = join(d, entry.name);
      let stat;
      try {
        stat = statSync(p);
      } catch {
        continue;
      }
      if (stat.isDirectory()) walk(p);
      else if (stat.isFile() && /\.(mdc|md)$/.test(entry.name)) out.push(p);
    }
  };
  walk(dir);
  return out;
}

function ruleAsset(path: string): Skill {
  const content = readFileSync(path, "utf8");
  const { fm, body } = parseFrontmatter(content);
  // Cursor's cost model: alwaysApply rules ride whole in every prompt;
  // agent-requested rules pay their description so the model can pick them;
  // glob/manual rules cost nothing until they trigger.
  const injection: Injection =
    /^true$/i.test(fm["alwaysApply"] ?? "") ? "body" : fm["description"]?.trim() ? "description" : "on-demand";
  return {
    dirName: basename(path).replace(/\.(mdc|md)$/, ""),
    dir: path,
    fmName: fm["name"],
    description: fm["description"],
    body,
    files: [{ relPath: basename(path), absPath: path, content, bytes: Buffer.byteLength(content) }],
    hasSkillMd: true,
    source: "cursor",
    kind: "rule",
    injection,
  };
}

export const cursorAdapter: SourceAdapter = {
  id: "cursor",

  detect(ctx) {
    return existsSync(join(ctx.cwd, ".cursor", "rules")) || existsSync(join(ctx.cwd, ".cursorrules"));
  },

  discover(ctx) {
    const assets: Skill[] = [];
    for (const f of ruleFiles(join(ctx.cwd, ".cursor", "rules"))) assets.push(ruleAsset(f));

    const legacy = join(ctx.cwd, ".cursorrules");
    if (existsSync(legacy) && statSync(legacy).isFile()) {
      const content = readFileSync(legacy, "utf8");
      assets.push({
        dirName: ".cursorrules",
        dir: legacy,
        body: content,
        files: [{ relPath: ".cursorrules", absPath: legacy, content, bytes: Buffer.byteLength(content) }],
        hasSkillMd: true,
        source: "cursor",
        kind: "rule",
        // The legacy file has no frontmatter and no scoping: always applied.
        injection: "body",
      });
    }
    return assets;
  },

  /**
   * Rule attachments out of Cursor's global conversation store. Every fire is
   * `channel: "load"` and never "auto": Cursor attaches a rule to a message as
   * context the model receives, it does not DISPATCH it the way a Skill tool_use
   * dispatches a skill — recording that as an auto-dispatch would claim the
   * model chose the rule, which no record in this store says.
   *
   * `ctx.cwd` is not consulted: the store is global, one file for every
   * workspace, and project attribution comes from workspaceStorage rather than
   * from where the scan happens to run.
   */
  async usage(ctx, assets): Promise<HistoryFacts> {
    const facts = await readCursorStore(ctx.home);
    if (!facts.readable) {
      // Nothing was read, so nothing is claimed: no usage rows AND no
      // neverFired rows, because "0 fires" is a measurement and this run made
      // none. caveats() below states which failure produced this.
      return { transcriptFiles: 0, usage: [], neverFired: [], external: [] };
    }

    const events: LedgerEvent[] = facts.attachments.map((a) => ({
      v: LEDGER_SCHEMA_VERSION,
      // Content-free and stable across runs: the two ids Cursor assigned plus
      // the rule's own name. Re-scanning the same store re-derives the same
      // id, so a conversation banked last month never counts twice.
      id: `${a.composerId}:${a.bubbleId}:${a.name}`,
      ts: a.ts,
      provider: "cursor",
      kind: "rule",
      name: a.name,
      channel: "load",
      sessionId: a.composerId,
      project: a.project,
      // No `src`: the store is a database, not a line-addressable transcript,
      // so the drill-down has nothing to open and is told so rather than
      // handed a pointer that resolves nowhere.
    }));

    interface Hit {
      invocations: number;
      sessions: Set<string>;
      first: string;
      last: string;
    }
    const hits = new Map<string, Hit>();
    for (const a of facts.attachments) {
      const h = hits.get(a.name) ?? { invocations: 0, sessions: new Set<string>(), first: a.ts, last: a.ts };
      h.invocations++;
      h.sessions.add(a.composerId);
      if (a.ts < h.first) h.first = a.ts;
      if (a.ts > h.last) h.last = a.ts;
      hits.set(a.name, h);
    }

    const toUsage = ([skill, h]: [string, Hit]): SkillUsage => ({
      skill,
      invocations: h.invocations,
      sessions: h.sessions.size,
      firstFired: h.first,
      lastFired: h.last,
      // Cursor records no interruption of a rule load — zero here is the
      // schema's silence, not an observation, and the caveats say so.
      interruptedAfter: 0,
      kind: "rule",
    });
    const byCount = (a: SkillUsage, b: SkillUsage): number =>
      b.invocations - a.invocations || a.skill.localeCompare(b.skill);

    // The store is global, so most attachments belong to OTHER projects' rules.
    // Those are external fires, exactly like a plugin skill fired outside the
    // audited directory — folding them into this project's rows would credit
    // one repo's rule with another's use.
    const owned = new Set(assets.filter((a) => (a.kind ?? "rule") === "rule").map((a) => a.dirName));
    const rows = [...hits.entries()].map(toUsage);

    return {
      // One store, one file. Counting conversations here would inflate a
      // figure the header renders as "transcripts scanned".
      transcriptFiles: 1,
      windowStart: facts.windowStart,
      windowEnd: facts.windowEnd,
      usage: rows.filter((u) => owned.has(u.skill)).sort(byCount),
      neverFired: [...owned].filter((n) => !hits.has(n)).sort(),
      external: rows.filter((u) => !owned.has(u.skill)).sort(byCount),
      events,
    };
  },

  /**
   * Cursor's numbers carry more qualifiers than any other source's, and every
   * one of them is load-bearing: the schema is undocumented, the timestamps are
   * per-conversation, and an empty result means "no records", never "no use".
   * Reads the memoized outcome of `usage()` when this process already ran one —
   * this hook is synchronous by contract, and the store read is not.
   */
  caveats(ctx) {
    const store = cursorStorePath(ctx.home);
    if (!store) {
      return [
        "no Cursor conversation store was found under this home — cursor rule rows show no readable history, " +
          "which is not a claim that the rules never applied",
      ];
    }
    const out = [
      `cursor rule usage is read from ${store} — an undocumented, unversioned SQLite store, opened read-only; ` +
        `a Cursor update can change its shape at any time`,
    ];
    const read = lastCursorStoreRead(ctx.home);
    if (read && !read.readable) {
      out.push(
        `cursor history unavailable: ${read.unreadable} — rule rows show no usage, which is not zero usage`
      );
      return out;
    }
    out.push(
      "cursor fires are dated by their conversation's createdAt — the store records no per-message timestamp, " +
        "so every rule attachment in one conversation carries the same date"
    );
    if (!read) return out;
    if (read.attachments.length === 0) {
      out.push(
        `no rule attachments are recorded in ${read.composers} cursor conversation(s) — an absence of records, ` +
          `not evidence that no rule ever applied`
      );
    }
    if (read.unparsed > 0) {
      out.push(
        `${read.unparsed} recorded cursor rule reference(s) carried no name this tool recognizes and are not ` +
          `counted — the element shape of Cursor's rule records is undocumented`
      );
    }
    if (read.malformed > 0) {
      out.push(`${read.malformed} cursor record(s) held no readable JSON object and were skipped`);
    }
    if (read.undated > 0) {
      out.push(
        `${read.undated} cursor rule attachment(s) belong to conversations with no usable createdAt and are ` +
          `not counted — an undated fire cannot be windowed`
      );
    }
    if (read.conversationOnly > 0) {
      out.push(
        `${read.conversationOnly} cursor conversation(s) record rules only at conversation level; those are not ` +
          `counted as per-message attachments`
      );
    }
    if (read.workspacesResolved < read.workspaces) {
      out.push(
        `project attribution resolved ${read.workspacesResolved} of ${read.workspaces} cursor workspace(s); ` +
          `fires from the rest are recorded without a project`
      );
    }
    return out;
  },
};
