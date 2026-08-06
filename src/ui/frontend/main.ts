// DOM glue only — every piece of markup comes from render.ts, every number
// from the server payload. State lives here; rendering stays pure.
import type { UiItem, UiPayload } from "../../types.js";
import {
  chipCounts,
  defaultState,
  fmtInt,
  initialState,
  isFiltered,
  pluginUpdateSummary,
  pruneFiltersForMode,
  renderDrawerBody,
  renderPage,
  renderResults,
  usageWindow,
  type AppState,
  type LogEntry,
  type SortKey,
} from "./render.js";

const app = document.getElementById("app")!;
const page = document.getElementById("page")!;
// The drawer node OUTLIVES every render: its 260ms slide is a CSS transition,
// and a node replaced wholesale arrives already open with nothing to
// transition from. Only its contents are swapped.
const drawer = document.getElementById("drawer") as HTMLElement;
const catcher = document.getElementById("catch") as HTMLElement;
const status = document.getElementById("status") as HTMLElement;
const token = new URLSearchParams(location.search).get("token") ?? "";

let payload: UiPayload | undefined;
let state: AppState = defaultState();

async function api(path: string, body?: unknown): Promise<any> {
  const res = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      // The custom header doubles as CSRF armor: no cross-origin page can
      // attach it without a preflight the server never approves.
      "x-context-audit-token": token,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return res.json();
}

/** Announce to assistive tech without narrating the entire page on every keystroke. */
function announce(message: string): void {
  status.textContent = message;
}

/**
 * The activity log mirrors the server's terminal: every line the process
 * prints for an action this page triggered also lands here, plus the CLI
 * output of plugin updates. Capped so a long session cannot grow it forever.
 */
function pushLog(kind: LogEntry["kind"], text: string): void {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, "0");
  state.log.push({ at: `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`, kind, text });
  if (state.log.length > 300) state.log.splice(0, state.log.length - 300);
}

/** Multi-line CLI output becomes one log line per line, empty lines dropped. */
function pushOutput(output: unknown): void {
  for (const line of String(output ?? "").split("\n")) {
    if (line.trim()) pushLog("out", line);
  }
}

/** The open scrollback follows its tail, like the terminal it mirrors. */
function scrollLog(): void {
  const ll = page.querySelector("[data-loglines]");
  if (ll) ll.scrollTop = ll.scrollHeight;
}

/**
 * Re-rendering by innerHTML throws away the focused element. Remember what had
 * focus by its data attributes and put it back, or keyboard navigation resets
 * to the top of the document on every sort, filter and toggle. The drawer is
 * included: its contents are swapped on every render too, so a keyboard user
 * activating "disable" from the drawer would otherwise land on <body>.
 */
interface FocusMark {
  root: "page" | "drawer";
  sel: string;
}

/** The row whose click opened the drawer — focus goes back there on close. */
let lastOpenedId: string | undefined;

function focusKey(): FocusMark | undefined {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return undefined;
  const root: FocusMark["root"] | undefined = page.contains(el)
    ? "page"
    : drawer.contains(el)
      ? "drawer"
      : undefined;
  if (!root) return undefined;
  for (const attr of ["data-sort", "data-toggle", "data-open", "data-open-event", "data-id"]) {
    const owner: HTMLElement | null = el.closest<HTMLElement>(`[${attr}]`);
    if (owner === el) return { root, sel: `[${attr}="${CSS.escape(el.getAttribute(attr)!)}"]` };
  }
  if (el.hasAttribute("data-rescan")) return { root, sel: "[data-rescan]" };
  if (el.hasAttribute("data-close")) return { root, sel: "[data-close]" };
  if (el.dataset.chip) {
    return {
      root,
      sel: `[data-chip="${CSS.escape(el.dataset.chip)}"][data-value="${CSS.escape(el.dataset.value ?? "")}"]`,
    };
  }
  if (el.dataset.mode) return { root, sel: `[data-mode="${CSS.escape(el.dataset.mode)}"]` };
  if (el.dataset.pluginUpdate) {
    return {
      root,
      sel: `[data-plugin-update="${CSS.escape(el.dataset.pluginUpdate)}"][data-marketplace="${CSS.escape(el.dataset.marketplace ?? "")}"]`,
    };
  }
  if (el.hasAttribute("data-search")) return { root, sel: "[data-search]" };
  // After clearing, the .clear button is visibility:hidden and unfocusable —
  // the search input is where a keyboard user goes next anyway.
  if (el.hasAttribute("data-clear")) return { root, sel: "[data-search]" };
  if (el.hasAttribute("data-logtoggle")) return { root, sel: "[data-logtoggle]" };
  return undefined;
}

function render(): void {
  if (!payload) return;
  const active = document.activeElement as HTMLElement | null;
  const drawerHadFocus = !!active && (drawer === active || drawer.contains(active));
  const restore = focusKey();
  // Typing in the search box re-renders the page under the caret, so the
  // caret position has to survive the swap or every keystroke jumps to the end.
  const caret =
    active instanceof HTMLInputElement && active.hasAttribute("data-search")
      ? active.selectionStart
      : null;
  const selected = payload.items.find((i) => i.id === state.selected);

  page.innerHTML = renderPage(payload, state);

  if (selected) {
    drawer.innerHTML = renderDrawerBody(
      selected,
      state,
      usageWindow(payload),
      payload.history?.transcriptFiles ?? 0
    );
    drawer.setAttribute("aria-label", selected.name);
  }
  // Closing keeps the last contents in place so the 260ms slide-out has
  // something to slide; aria-hidden takes them out of the accessibility tree
  // immediately, and the next open overwrites them before the panel returns.
  drawer.classList.toggle("open", !!selected);
  drawer.setAttribute("aria-hidden", selected ? "false" : "true");
  catcher.hidden = !selected;

  if (restore) {
    const root = restore.root === "drawer" ? drawer : page;
    const el = root.querySelector<HTMLElement>(restore.sel);
    if (el) {
      el.focus();
      if (caret !== null && el instanceof HTMLInputElement) el.setSelectionRange(caret, caret);
    } else if (restore.root === "drawer" && selected) drawer.focus();
  }
  // Focus must never sit inside an aria-hidden subtree: hand it back to the
  // row the drawer was opened from.
  if (!selected && drawerHadFocus) {
    const row = lastOpenedId
      ? page.querySelector<HTMLElement>(`tr[data-id="${CSS.escape(lastOpenedId)}"]`)
      : null;
    (row ?? page.querySelector<HTMLElement>("[data-rescan]"))?.focus();
  }

  // Choreography plays once per data arrival, never on filter/sort churn.
  if (state.animate) clearReveal();
  state.animate = false;
  state.sweep = false;
  scrollLog();
}

/**
 * Second guarantee that the reveal cannot hide the page. The CSS resting state
 * is already visible (fill-mode backwards), and this drops the animation
 * entirely a beat after it should have finished — so an engine that stalls
 * mid-animation, or a tab that was never painted, still ends up showing the
 * inventory rather than an empty grid.
 */
let revealTimer: ReturnType<typeof setTimeout> | undefined;
function clearReveal(): void {
  clearTimeout(revealTimer);
  revealTimer = setTimeout(() => {
    for (const el of document.querySelectorAll(".settle")) el.classList.remove("settle");
    document.querySelector(".sweep")?.remove();
  }, 1500);
}

function connectionLost(): void {
  pushLog("err", "connection to the audit server was lost");
  const foot = page.querySelector(".foot .live");
  if (foot) {
    foot.innerHTML = "<i></i>connection lost — the server was stopped";
    (foot as HTMLElement).style.color = "var(--danger)";
  }
  announce("connection to the audit server was lost");
}

/**
 * Find an item again in a freshly scanned payload. Toggling moves the
 * directory, which changes the path-derived ID. Path first: a rescan keeps
 * paths, and name+kind+source alone cannot tell an enabled skill from its
 * disabled twin — a pair that really exists on real machines.
 */
function relocate(prev: UiItem | undefined): UiItem | undefined {
  if (!prev || !payload) return undefined;
  const byPath = payload.items.find((i) => i.path === prev.path);
  const candidates = payload.items.filter(
    (i) => i.name === prev.name && i.kind === prev.kind && i.source === prev.source && i.scope === prev.scope
  );
  return byPath ?? candidates.find((i) => i.enabled !== prev.enabled) ?? candidates[0];
}

async function doToggle(id: string): Promise<void> {
  if (!payload || state.busy) return;
  const prev = payload.items.find((i) => i.id === id);
  const wasSelected = state.selected === id;
  // Flip the switch on the live node first: the knob's transform transition is
  // the state-change feedback, and it needs a node that persists long enough
  // to run it — the re-render lands about a second later, after the rescan.
  // The ARIA state moves with it; a screen reader reads the switch at the
  // moment of activation, so a class-only flip would announce the old state.
  const sw = page.querySelector<HTMLElement>(`.sw[data-toggle="${CSS.escape(id)}"]`);
  const hadFocus = !!sw && document.activeElement === sw;
  if (sw && prev) {
    const next = !prev.enabled;
    sw.classList.toggle("on", next);
    sw.setAttribute("aria-checked", String(next));
    sw.setAttribute("aria-label", `${next ? "disable" : "enable"} ${prev.name}`);
  }
  state.busy = true;
  state.error = undefined;
  try {
    const r = await api("/api/toggle", { id });
    state.busy = false;
    if (r.ok) {
      pushLog(
        "ok",
        `${r.action}d ${prev?.name ?? "item"}${r.from && r.to ? ` — ${r.from} → ${r.to}` : ""}`
      );
      payload = r.payload;
      const moved = relocate(prev);
      // Only the SELECTED row's selection follows the move. Reselecting on
      // every toggle made the drawer slide open uninvited whenever a switch
      // was flipped from the table, and silently swapped the drawer's subject
      // when a different row was showing.
      if (wasSelected) state.selected = moved?.id;
      announce(`${prev?.name ?? "item"} ${r.action}d`);
      render();
      // The row's ID changed with its path, so the saved focus selector no
      // longer resolves — put the caret back on the same switch by its new ID.
      if (hadFocus && moved) {
        page.querySelector<HTMLElement>(`.sw[data-toggle="${CSS.escape(moved.id)}"]`)?.focus();
      }
      return;
    }
    {
      // Failures render in the drawer — open it on the item if it wasn't.
      state.selected = id;
      state.error = r.error ?? "toggle failed";
      pushLog("err", `toggle failed for ${prev?.name ?? "item"} — ${state.error}`);
      announce(state.error!);
    }
    render();
  } catch {
    state.busy = false;
    render();
    connectionLost();
  }
}

/**
 * Update one plugin through the claude CLI on the server side. The reference
 * is name + marketplace, validated server-side against its own inventory; a
 * successful update triggers a rescan so the group row shows the new version.
 */
async function doPluginUpdate(name: string, marketplace: string): Promise<void> {
  if (!payload || state.busy) return;
  // The busy render re-emits this button with `disabled`, and focus() on a
  // disabled control is a no-op — so the generic restore in render() cannot
  // hold the keyboard position through the update. Refocus explicitly once
  // the button is enabled again, the same way doToggle does for moved rows.
  const sel = `[data-plugin-update="${CSS.escape(name)}"][data-marketplace="${CSS.escape(marketplace)}"]`;
  const hadFocus = !!(document.activeElement as HTMLElement | null)?.matches?.(sel);
  const refocus = (): void => {
    if (hadFocus) page.querySelector<HTMLElement>(sel)?.focus();
  };
  state.busy = true;
  state.error = undefined;
  // The log panel is the feedback for this action: it opens on its own,
  // shows the command the way the terminal would, then the CLI's output.
  pushLog("cmd", `claude plugin update ${name}@${marketplace}`);
  pushLog("info", "running — the CLI may fetch from the marketplace, this can take a moment…");
  state.logOpen = true;
  announce(`updating ${name}…`);
  render();
  // The verdict comes from the rescan, not the CLI's prose: same version
  // after as before means nothing changed, whatever the exit code said.
  const versionOf = (): string | undefined =>
    payload?.items.find((i) => i.plugin?.name === name && i.plugin?.marketplace === marketplace)?.plugin
      ?.version;
  const before = versionOf();
  try {
    const r = await api("/api/plugin-update", { name, marketplace });
    state.busy = false;
    pushOutput(r.output);
    if (r.ok) {
      payload = r.payload;
      const summary = pluginUpdateSummary(name, before, versionOf());
      pushLog("ok", summary);
      announce(summary);
    } else {
      state.error = r.error ?? "plugin update failed";
      pushLog("err", state.error!);
      announce(state.error!);
    }
    render();
    refocus();
  } catch {
    state.busy = false;
    pushLog("err", "connection lost while the update was running — check the terminal that launched the dashboard");
    render();
    refocus();
    connectionLost();
  }
}

/** Open failures are readable, same as toggle failures — never silent. */
async function doOpen(id: string): Promise<void> {
  const name = payload?.items.find((i) => i.id === id)?.name ?? "item";
  try {
    const r = await api("/api/open", { id });
    if (!r.ok) {
      state.selected = id;
      state.error = r.error ?? "could not open this file";
      pushLog("err", `open failed for ${name} — ${state.error}`);
      announce(state.error!);
      render();
    } else {
      pushLog("ok", `opened ${name} in editor via ${r.command ?? "editor"}`);
      renderResultsOnly();
    }
  } catch {
    connectionLost();
  }
}

/**
 * Open the transcript behind one ledger event. A 410 means the harness purged
 * the transcript after the event was banked: the row stays — the ledger entry
 * is the durable record — but renders disabled, stating that fact.
 */
async function doOpenEvent(itemId: string, eventId: string): Promise<void> {
  const name = payload?.items.find((i) => i.id === itemId)?.name ?? "item";
  try {
    const r = await api("/api/open-event", { itemId, eventId });
    if (r.ok) {
      pushLog("ok", `opened transcript for ${name} via ${r.command ?? "editor"}`);
      renderResultsOnly();
      return;
    }
    const err = String(r.error ?? "could not open this invocation");
    // The server's own wording for a purged transcript — matched on, so the
    // row disables itself instead of offering the same dead button again.
    if (/transcript deleted/i.test(err)) {
      state.purgedEvents = [...(state.purgedEvents ?? []), eventId];
    }
    state.selected = itemId;
    state.error = err;
    pushLog("err", `open failed for ${name} — ${err}`);
    announce(err);
    render();
  } catch {
    connectionLost();
  }
}

async function doRescan(): Promise<void> {
  if (state.busy) return;
  const prev = payload?.items.find((i) => i.id === state.selected);
  // Same disabled-button focus trap as doPluginUpdate: restore by hand.
  const hadFocus = !!(document.activeElement as HTMLElement | null)?.hasAttribute?.("data-rescan");
  const refocus = (): void => {
    if (hadFocus) page.querySelector<HTMLElement>("[data-rescan]")?.focus();
  };
  state.busy = true;
  state.error = undefined;
  render();
  try {
    const r = await api("/api/rescan", {});
    state.busy = false;
    if (r.ok) {
      payload = r.payload;
      if (state.selected) state.selected = relocate(prev)?.id;
      state.animate = true; // the readouts re-settle: rescan has visible feedback
      pushLog("ok", `rescan complete — ${payload!.items.length} items · ${payload!.tookMs} ms`);
      announce(`rescan complete — ${payload!.items.length} items`);
    } else {
      // A scan that failed must say so; silently showing the previous one is
      // how a dashboard lies about being current.
      state.error = r.error ?? "rescan failed — still showing the previous scan";
      pushLog("err", state.error!);
      announce(state.error!);
    }
    render();
    refocus();
  } catch {
    state.busy = false;
    render();
    refocus();
    connectionLost();
  }
}

/**
 * Live filtering as you type. This re-renders ONLY the results, never the rail
 * — replacing the input node mid-keystroke made the browser drop focus and the
 * caret after the first character, so the box ate everything typed after it.
 */
app.addEventListener("input", (e) => {
  const el = e.target as HTMLElement;
  if (!el.hasAttribute("data-search")) return;
  state.query = (el as HTMLInputElement).value;
  renderResultsOnly();
});

function renderResultsOnly(): void {
  if (!payload) return;
  const results = page.querySelector("#results");
  if (!results) return render();
  results.innerHTML = renderResults(payload, state);
  page.querySelector(".clear")?.classList.toggle("gone", !isFiltered(state));
  // Chip counts are faceted by the query, so typing changes them. The rail is
  // never rebuilt while typing (the caret lives in it) — patch each count
  // node in place instead, so the numbers keep predicting what a click shows.
  for (const { group, value, count } of chipCounts(payload, state)) {
    const el = page.querySelector<HTMLElement>(
      `[data-chip="${CSS.escape(group)}"][data-value="${CSS.escape(value)}"]`
    );
    if (!el) continue;
    const b = el.querySelector("b");
    if (b) b.textContent = fmtInt(count);
    el.classList.toggle("empty", count === 0);
  }
  scrollLog();
}

function clearFilters(): void {
  state.providers = [];
  state.kinds = [];
  state.query = "";
  state.lens = "all";
  render();
  announce("filters cleared");
}

app.addEventListener("click", (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>(
    "[data-chip], [data-mode], [data-plugin-update], [data-logtoggle], [data-sort], [data-toggle], [data-open], [data-open-event], [data-rescan], [data-close], [data-clear], #catch, tr[data-id]"
  );
  if (!el || !payload) return;

  if (el.hasAttribute("data-clear")) return clearFilters();

  if (el.hasAttribute("data-logtoggle")) {
    state.logOpen = !state.logOpen;
    return render();
  }

  if (el.dataset.pluginUpdate) {
    e.stopPropagation();
    void doPluginUpdate(el.dataset.pluginUpdate, el.dataset.marketplace ?? "");
    return;
  }

  if (el.dataset.mode) {
    state.mode = el.dataset.mode as AppState["mode"];
    // Filters whose bank disappears in the new mode must not survive as
    // invisible narrowing with nothing on screen to turn off.
    pruneFiltersForMode(payload, state);
    if (el.dataset.lens) {
      // The flagged-outside-this-view caveat announced a count no other
      // filter reduced, and promised to show it — so the jump resets the
      // other dimensions rather than landing on a query-narrowed subset of
      // the flags it named.
      state.lens = el.dataset.lens as AppState["lens"];
      state.query = "";
      state.providers = [];
      state.kinds = [];
    }
    announce(state.mode === "skills" ? "showing skills only" : "showing the whole inventory");
    return render();
  }

  if (el.dataset.chip) {
    const { chip, value } = el.dataset as { chip: string; value: string };
    if (chip === "provider") {
      state.providers = state.providers.includes(value)
        ? state.providers.filter((p) => p !== value)
        : [...state.providers, value];
    } else if (chip === "kind") {
      state.kinds = state.kinds.includes(value) ? state.kinds.filter((k) => k !== value) : [...state.kinds, value];
    } else if (chip === "lens") {
      state.lens = state.lens === value ? "all" : (value as AppState["lens"]);
    }
    return render();
  }

  if (el.dataset.sort) {
    const key = el.dataset.sort as SortKey;
    state.sort = state.sort.key === key ? { key, dir: state.sort.dir === 1 ? -1 : 1 } : { key, dir: -1 };
    return render();
  }

  if (el.dataset.toggle) {
    e.stopPropagation();
    void doToggle(el.dataset.toggle);
    return;
  }

  if (el.dataset.openEvent) {
    e.stopPropagation();
    void doOpenEvent(el.dataset.eventItem ?? "", el.dataset.openEvent);
    return;
  }

  if (el.dataset.open) {
    e.stopPropagation();
    void doOpen(el.dataset.open);
    return;
  }

  if (el.hasAttribute("data-rescan")) return void doRescan();

  if (el.hasAttribute("data-close") || el.id === "catch") {
    state.selected = undefined;
    state.error = undefined;
    return render();
  }

  if (el.dataset.id) {
    state.error = undefined;
    const opening = state.selected !== el.dataset.id;
    state.selected = opening ? el.dataset.id : undefined;
    if (opening) lastOpenedId = el.dataset.id;
    render();
    if (state.selected) drawer.focus();
  }
});

app.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" && e.key !== " ") return;
  // Only when the row or header itself holds focus. `closest()` from an
  // in-row button matched the row too, so Enter on the toggle fired the
  // native button AND opened the drawer.
  const el = e.target as HTMLElement;
  if (!el.matches("tr[data-id], th[data-sort]")) return;
  e.preventDefault();
  el.click();
});

document.addEventListener("keydown", (e) => {
  const typing = document.activeElement instanceof HTMLInputElement;
  // `/` jumps to the search box, the way every list of 187 things should work.
  if (e.key === "/" && !typing) {
    e.preventDefault();
    page.querySelector<HTMLInputElement>("[data-search]")?.focus();
    return;
  }
  if (e.key !== "Escape") return;
  // Escape unwinds one layer at a time: drawer first, then filters.
  if (state.selected) {
    state.selected = undefined;
    state.error = undefined;
    render();
  } else if (isFiltered(state)) {
    clearFilters();
  }
});

(async () => {
  try {
    const r = await api("/api/audit");
    if (!r.ok) throw new Error(r.error);
    payload = r.payload;
    // Skills-first boot: the state machine's default is unscoped, but the
    // EXPERIENCE default is the skills layer whenever the machine has skills.
    state = initialState(payload!);
    pushLog("info", `audit loaded — ${payload!.items.length} instruction files · ${payload!.tookMs} ms`);
    render();
    announce(`audit loaded — ${payload!.items.length} instruction files`);
  } catch {
    page.innerHTML = `<div class="empty-state"><span class="engr">cannot reach the audit server</span>
      <p>The dashboard talks only to its own local process. Restart it with <code>context-audit ui</code>
      and open the printed URL — the URL carries this session&#39;s access token.</p></div>`;
  }
})();
