/**
 * A small YAML-subset parser for skill frontmatter.
 *
 * Why this exists: the checks in frontmatter.ts used to read frontmatter with
 * line regexes anchored at column 0 and matching only bareword keys. The harness
 * reads the same text with a real YAML parser. Every gap between those two
 * readings is a free bypass, and they are two characters wide:
 *
 *     "allowed-tools": Bash(*)      # quoted key — regex misses, YAML does not
 *     - "command": curl …           # quoted nested key — same
 *     hooks: {PreToolUse: [{…}]}    # flow mapping — line regexes never see it
 *      name: demo                   # indented root map — column-0 anchor misses
 *
 * Each one silently disabled nearly every frontmatter check while leaving the
 * skill fully loadable. Matching the harness's own reading is the only way to
 * close the class; enumerating the spellings just moves the gap.
 *
 * Supported: block mappings and sequences, quoted/bareword keys, flow mappings
 * and sequences, block scalars (| and >), comments, and root indentation.
 * Not supported (and not needed here): anchors/aliases, multi-document streams,
 * complex keys, tags. Anything unparsed degrades to a scalar string rather than
 * throwing — a scanner must never crash on hostile input.
 */

export type YValue = string | YValue[] | YMap;
export interface YMap {
  [key: string]: YValue;
}

/** Every scalar leaf found anywhere in the tree, with the line it came from. */
export interface YEntry {
  key: string;
  value: string;
  line: number;
}

export interface ParsedYaml {
  root: YMap;
  /** Top-level keys in document order. */
  rootKeys: string[];
  /** Scalar leaves at any depth, for "find every `command:` value" queries. */
  entries: YEntry[];
}

interface Line {
  indent: number;
  text: string;
  /** 1-based line number within the frontmatter block. */
  line: number;
}

/** Strip an unquoted trailing `# comment`. */
function stripComment(s: string): string {
  let quote: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === "#" && (i === 0 || /\s/.test(s[i - 1]))) {
      return s.slice(0, i);
    }
  }
  return s;
}

function unquote(s: string): string {
  const v = s.trim();
  if (v.length >= 2 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'")))) {
    return v.slice(1, -1);
  }
  return v;
}

/**
 * Split a key from its value at the first structural `:`. Returns undefined when
 * the line is not a mapping entry. Handles quoted keys, which is the whole point.
 */
function splitKey(text: string): { key: string; rest: string } | undefined {
  if (text[0] === '"' || text[0] === "'") {
    const q = text[0];
    const end = text.indexOf(q, 1);
    if (end === -1) return undefined;
    const after = text.slice(end + 1).trimStart();
    if (!after.startsWith(":")) return undefined;
    return { key: text.slice(1, end), rest: after.slice(1).trim() };
  }
  const m = /^([^:\s][^:]*?)\s*:(\s|$)/.exec(text);
  if (!m) return undefined;
  return { key: m[1].trim(), rest: text.slice(m[0].length - (m[2] === "" ? 0 : m[2].length)).trim() };
}

/** Recursive-descent parser for flow collections: `{a: b, c: [d, e]}`. */
function parseFlow(src: string, pos: { i: number }): YValue {
  const skipWs = (): void => {
    while (pos.i < src.length && /\s/.test(src[pos.i])) pos.i++;
  };
  skipWs();
  const open = src[pos.i];
  if (open === "[" || open === "{") {
    const close = open === "[" ? "]" : "}";
    pos.i++;
    const arr: YValue[] = [];
    const map: YMap = {};
    let sawKey = false;
    while (pos.i < src.length) {
      skipWs();
      if (src[pos.i] === close) {
        pos.i++;
        break;
      }
      const item = parseFlow(src, pos);
      skipWs();
      if (src[pos.i] === ":") {
        pos.i++;
        const v = parseFlow(src, pos);
        if (typeof item === "string") map[unquote(item)] = v;
        sawKey = true;
      } else {
        arr.push(item);
      }
      skipWs();
      if (src[pos.i] === ",") pos.i++;
    }
    return sawKey ? map : arr;
  }
  // Bare or quoted scalar, ending at a structural character.
  if (open === '"' || open === "'") {
    const end = src.indexOf(open, pos.i + 1);
    const v = end === -1 ? src.slice(pos.i + 1) : src.slice(pos.i + 1, end);
    pos.i = end === -1 ? src.length : end + 1;
    return v;
  }
  const start = pos.i;
  while (pos.i < src.length && !/[,:[\]{}]/.test(src[pos.i])) pos.i++;
  return src.slice(start, pos.i).trim();
}

function parseValue(raw: string): YValue {
  const v = raw.trim();
  if (v.startsWith("[") || v.startsWith("{")) return parseFlow(v, { i: 0 });
  return unquote(v);
}

/** Indent of the block starting at `i`, or -1 if there is no deeper block there. */
function childIndent(lines: Line[], i: number, parentIndent: number): number {
  if (i >= lines.length) return -1;
  return lines[i].indent > parentIndent ? lines[i].indent : -1;
}

/** Parse a run of lines at `indent` or deeper into a map or a sequence. */
function parseNode(lines: Line[], start: number, indent: number, entries: YEntry[]): [YValue, number] {
  let i = start;
  const map: YMap = {};
  const seq: YValue[] = [];
  let isSeq = false;

  while (i < lines.length) {
    const ln = lines[i];
    if (ln.indent < indent) break;
    // A deeper-indented line with no owner is continuation noise; skip it.
    if (ln.indent > indent) {
      i++;
      continue;
    }

    if (/^-(\s|$)/.test(ln.text)) {
      isSeq = true;
      const inner = ln.text.slice(1).trim();
      if (inner === "") {
        const child = childIndent(lines, i + 1, indent);
        if (child === -1) {
          seq.push("");
          i++;
          continue;
        }
        const [v, next] = parseNode(lines, i + 1, child, entries);
        seq.push(v);
        i = next;
        continue;
      }
      const kv = splitKey(inner);
      if (kv) {
        // `- command: x` starts a mapping on the sequence-item line itself. Its
        // sibling keys are indented to where `command` begins, not to the dash.
        const itemIndent = ln.indent + (ln.text.length - ln.text.slice(1).trimStart().length);
        const synthetic: Line[] = [{ indent: itemIndent, text: inner, line: ln.line }];
        let j = i + 1;
        while (j < lines.length && lines[j].indent >= itemIndent) synthetic.push(lines[j++]);
        const [v] = parseNode(synthetic, 0, itemIndent, entries);
        seq.push(v);
        i = j;
        continue;
      }
      seq.push(parseValue(inner));
      i++;
      continue;
    }

    const kv = splitKey(ln.text);
    if (!kv) {
      i++;
      continue;
    }
    const { key, rest } = kv;

    if (/^[|>][+-]?$/.test(rest)) {
      const parts: string[] = [];
      let j = i + 1;
      while (j < lines.length && (lines[j].indent > indent || lines[j].text === "")) {
        parts.push(lines[j].text);
        j++;
      }
      const value = parts.join(rest.startsWith(">") ? " " : "\n").trim();
      map[key] = value;
      entries.push({ key, value, line: ln.line });
      i = j;
      continue;
    }

    if (rest === "") {
      // The child block's indent is whatever the next line actually uses — YAML
      // does not mandate a step of one, and assuming it skipped every nested
      // block indented by two, which is how essentially all frontmatter is written.
      const child = childIndent(lines, i + 1, indent);
      if (child === -1) {
        map[key] = "";
        entries.push({ key, value: "", line: ln.line });
        i++;
        continue;
      }
      const [v, next] = parseNode(lines, i + 1, child, entries);
      map[key] = v;
      collectEntries(key, v, ln.line, entries);
      i = next;
      continue;
    }

    const v = parseValue(rest);
    map[key] = v;
    collectEntries(key, v, ln.line, entries);
    i++;
  }

  if (isSeq) return [seq, i];
  return [map, i];
}

/**
 * Record scalar leaves so a caller can ask "every `command:` anywhere". A flow
 * mapping collapses onto one line, so nested leaves inherit that line number.
 */
function collectEntries(key: string, value: YValue, line: number, entries: YEntry[]): void {
  if (typeof value === "string") {
    entries.push({ key, value, line });
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectEntries(key, v, line, entries);
    return;
  }
  for (const [k, v] of Object.entries(value)) collectEntries(k, v, line, entries);
}

export function parseYaml(block: string): ParsedYaml {
  const rawLines = block.split("\n");
  const lines: Line[] = [];
  for (let i = 0; i < rawLines.length; i++) {
    const stripped = stripComment(rawLines[i].replace(/\r$/, ""));
    if (stripped.trim() === "") continue;
    lines.push({
      indent: stripped.length - stripped.trimStart().length,
      text: stripped.trim(),
      // +2 because the block excludes the opening `---` line.
      line: i + 2,
    });
  }
  // The root mapping may itself be indented — YAML allows it, and anchoring at
  // column 0 meant one leading space hid every top-level key at once.
  const base = lines.length ? Math.min(...lines.map((l) => l.indent)) : 0;
  const entries: YEntry[] = [];
  const [root] = parseNode(lines, 0, base, entries);
  const map: YMap = typeof root === "object" && !Array.isArray(root) ? root : {};
  return { root: map, rootKeys: Object.keys(map), entries };
}

/** Flatten a parsed value to the comparable string the checks expect. */
export function flatten(v: YValue | undefined): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.map((x) => flatten(x) ?? "").join(", ");
  return Object.entries(v)
    .map(([k, x]) => `${k}: ${flatten(x) ?? ""}`)
    .join(", ");
}
