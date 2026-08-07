// DOM glue only — every piece of markup comes from render.ts, every number
// from the server payload. State lives here; rendering stays pure.
import type { UiItem, UiPayload } from "../../types.js";
import {
  KIND_LABEL,
  defaultState,
  fmtInt,
  initialState,
  isFiltered,
  liveCounts,
  pluginUpdateSummary,
  pruneFiltersForNav,
  renderDrawerBody,
  renderPage,
  renderResults,
  tokens,
  usageWindow,
  type AppState,
  type LogEntry,
  type SortKey,
} from "./render.js";
import { PANELS, pruneModel, quadrantIds, type QuadrantKey } from "./views.js";

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
  // The value-carrying controls, each with the tag its selector must pin to
  // where more than one kind of node carries that attribute: `data-quadrant`
  // is on the readout BUTTONS and on the plot's hit zones, `data-id` is on
  // table rows, matrix rows, budget segments and scatter marks — and focus has
  // to come back to the focusable one, not to whichever the query finds first.
  for (const [attr, tag] of [
    ["data-sort", ""],
    ["data-toggle", ""],
    ["data-open", ""],
    ["data-open-event", ""],
    ["data-nav", ""],
    ["data-lens", ""],
    ["data-provider", ""],
    ["data-stat", ""],
    ["data-quadrant", "button"],
    // Every host of data-id is a different element type, so the selector takes
    // the focused node's own tag: a table row, a matrix row, a budget segment,
    // a scatter mark and a top-spend link can carry the same id, and only one
    // of them was holding the caret.
    ["data-id", "self"],
  ] as [string, string][]) {
    const owner: HTMLElement | null = el.closest<HTMLElement>(`[${attr}]`);
    if (owner === el) {
      const prefix = tag === "self" ? el.tagName.toLowerCase() : tag;
      return { root, sel: `${prefix}[${attr}="${CSS.escape(el.getAttribute(attr)!)}"]` };
    }
  }
  if (el.hasAttribute("data-rescan")) return { root, sel: "[data-rescan]" };
  if (el.hasAttribute("data-close")) return { root, sel: "[data-close]" };
  if (el.hasAttribute("data-statbar")) return { root, sel: "[data-statbar]" };
  if (el.hasAttribute("data-prov")) return { root, sel: "[data-prov]" };
  if (el.hasAttribute("data-theme-toggle")) return { root, sel: "[data-theme-toggle]" };
  if (el.hasAttribute("data-check-all")) return { root, sel: "[data-check-all]" };
  if (el.hasAttribute("data-disable-checked")) return { root, sel: "[data-disable-checked]" };
  if (el.dataset.check) return { root, sel: `[data-check="${CSS.escape(el.dataset.check)}"]` };
  if (el.dataset.pluginUpdate) {
    return {
      root,
      sel: `[data-plugin-update="${CSS.escape(el.dataset.pluginUpdate)}"][data-marketplace="${CSS.escape(el.dataset.marketplace ?? "")}"]`,
    };
  }
  if (el.hasAttribute("data-search")) return { root, sel: "[data-search]" };
  // After clearing, the .clear button is visibility:hidden and unfocusable,
  // and the focus chip is gone entirely — the search input is where a keyboard
  // user goes next anyway.
  if (el.hasAttribute("data-clear") || el.hasAttribute("data-unfocus")) {
    return { root, sel: "[data-search]" };
  }
  if (el.hasAttribute("data-logtoggle")) return { root, sel: "[data-logtoggle]" };
  return undefined;
}

function applyTheme(): void {
  if (state.theme === "auto") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", state.theme);
}

/** What "light" and "dark" mean right now, with no explicit choice made. */
const systemPrefersLight = (): boolean =>
  typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: light)").matches;

function render(): void {
  if (!payload) return;
  applyTheme();
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

  // The projection lived on a node that no longer exists, and the figure it
  // was projecting from has just been re-measured.
  whatIfPinned = false;
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
 * The live what-if total: what "always in context" would read if this row's
 * toggle went through. It is a DOM state — a projection that exists only while
 * a control is being reached for or acted on — so it cannot live in render.ts,
 * which knows nothing about hover or in-flight actions.
 *
 * The measured figure is never overwritten: the projection is a second line
 * under it, arrow-led, so the number the page reports and the number it is
 * guessing at can never be confused for each other.
 */
let whatIfPinned = false;

function showWhatIf(item: UiItem | undefined, chars = 0): void {
  // Absent entirely while the stat bar is hidden — the projection is a second
  // line under a measured figure, and with no figure drawn there is nothing to
  // project from.
  const box = page.querySelector<HTMLElement>('[data-readout="cost"]');
  if (!box) return;
  box.querySelector(".whatif")?.remove();
  box.classList.toggle("projecting", !!item);
  if (!item || !payload) return;
  const delta = item.enabled ? -chars : chars;
  const next = Math.max(0, payload.header.injectedChars + delta);
  const line = document.createElement("span");
  line.className = "sub whatif";
  // textContent, not innerHTML: item names come off disk.
  line.textContent = `→ ${fmtInt(tokens(next))} tok if ${item.name} is ${item.enabled ? "disabled" : "enabled"} · ${delta < 0 ? "−" : "+"}${fmtInt(tokens(Math.abs(delta)))}`;
  box.appendChild(line);
}

/** Resolve the hovered or focused control to its row and its own figure. */
function whatIfFrom(host: HTMLElement): void {
  const item = payload?.items.find((i) => i.id === host.dataset.toggle);
  if (!item) return;
  // The affordance states the saving it would make; the payload states the
  // cost. They are the same number, and the attribute is what the row
  // committed to on screen — so it wins where it exists.
  const attr = Number(host.dataset.savingChars);
  showWhatIf(item, Number.isFinite(attr) && attr > 0 ? attr : item.injectedChars);
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
  // The what-if total is pinned for the length of the action: the switch has
  // already moved, and the header should show where the total is going while
  // the server does the work.
  if (prev) {
    const host = document.querySelector<HTMLElement>(
      `[data-toggle="${CSS.escape(id)}"][data-saving-chars]`
    );
    const attr = Number(host?.dataset.savingChars);
    whatIfPinned = true;
    showWhatIf(prev, Number.isFinite(attr) && attr > 0 ? attr : prev.injectedChars);
    announce(
      `${prev.enabled ? "disabling" : "enabling"} ${prev.name} — always in context would be ${fmtInt(
        tokens(Math.max(0, payload.header.injectedChars + (prev.enabled ? -prev.injectedChars : prev.injectedChars)))
      )} tokens`
    );
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
      state.checked = [];
      const moved = relocate(prev);
      // Only the SELECTED row's selection follows the move. Reselecting on
      // every toggle made the drawer slide open uninvited whenever a switch
      // was flipped from the table, and silently swapped the drawer's subject
      // when a different row was showing.
      if (wasSelected) state.selected = moved?.id;
      // A pinned set is a set of IDS, and toggling moves the directory — which
      // changes the path-derived id. Without this the row would drop silently
      // out of a pin it still belongs to, and the chip would quietly count one
      // fewer than the panel that produced it.
      if (state.focus && moved) {
        state.focus = {
          ...state.focus,
          ids: state.focus.ids.map((x) => (x === id ? moved.id : x)),
        };
      }
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

/**
 * Turn off everything the prune shortlist has checked, in one request.
 *
 * The verdict the button states is the one that gets acted on: the ids are
 * resolved and counted here, the server runs the same per-item guards the
 * single toggle does, and anything it refuses is named in the activity log
 * rather than quietly dropped from the count.
 */
async function doDisableChecked(): Promise<void> {
  if (!payload || state.busy) return;
  const ids = (state.checked ?? []).filter((id) => payload!.items.some((i) => i.id === id));
  if (ids.length === 0) return announce("nothing selected");
  const saving = ids.reduce(
    (a, id) => a + (payload!.items.find((i) => i.id === id)?.injectedChars ?? 0),
    0
  );
  state.busy = true;
  state.error = undefined;
  pushLog("cmd", `turning off ${ids.length} item${ids.length === 1 ? "" : "s"} — saving ~${fmtInt(tokens(saving))} tok/session`);
  state.logOpen = true;
  announce(`turning off ${ids.length} items`);
  render();
  try {
    const r = await api("/api/toggle-many", { ids });
    state.busy = false;
    if (r.ok) {
      payload = r.payload;
      // The ids are path-derived and every move changed a path, so the whole
      // selection is stale by construction. Clearing it is the honest state:
      // the rows it named are not those rows any more.
      state.checked = [];
      state.selected = undefined;
      for (const name of r.done ?? []) pushLog("ok", `disabled ${name}`);
      for (const f of r.refused ?? []) pushLog("err", `${f.name} — ${f.error}`);
      const n = (r.done ?? []).length;
      const summary =
        `turned off ${n} of ${ids.length}` +
        ((r.refused ?? []).length > 0 ? ` — ${(r.refused ?? []).length} refused, see above` : "") +
        ` · always in context is now ${fmtInt(payload!.header.injectedTokens)} tok/session`;
      pushLog("ok", summary);
      announce(summary);
    } else {
      state.error = r.error ?? "could not turn these off";
      pushLog("err", state.error!);
      announce(state.error!);
    }
    render();
  } catch {
    state.busy = false;
    render();
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
      state.checked = [];
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

/**
 * Reaching for a savings affordance previews what it would do to the header
 * total, by pointer or by keyboard. The same projection the in-flight toggle
 * pins, shown a beat earlier — the question "what would this save me" is asked
 * before the click, not after it.
 */
const savingHost = (t: EventTarget | null): HTMLElement | null =>
  t instanceof Element ? t.closest<HTMLElement>("[data-saving-chars]") : null;

app.addEventListener("mouseover", (e) => {
  if (whatIfPinned) return;
  const host = savingHost(e.target);
  if (host) whatIfFrom(host);
});
app.addEventListener("mouseout", (e) => {
  if (whatIfPinned) return;
  const host = savingHost(e.target);
  // Moving between a control and its own child is not leaving it.
  if (host && !(e.relatedTarget instanceof Node && host.contains(e.relatedTarget))) {
    showWhatIf(undefined);
  }
});
app.addEventListener("focusin", (e) => {
  if (whatIfPinned) return;
  const host = savingHost(e.target);
  if (host) whatIfFrom(host);
});
app.addEventListener("focusout", (e) => {
  if (whatIfPinned) return;
  if (savingHost(e.target)) showWhatIf(undefined);
});

function renderResultsOnly(): void {
  if (!payload) return;
  const results = page.querySelector("#results");
  if (!results) return render();
  results.innerHTML = renderResults(payload, state);
  page.querySelector(".clear")?.classList.toggle("gone", !isFiltered(state));
  // Sidebar and provider counts are faceted by the query, so typing changes
  // them. Neither is rebuilt while typing (the caret lives in the view bar) —
  // patch each count node in place instead, so every number keeps predicting
  // what clicking it shows.
  for (const { group, key, count } of liveCounts(payload, state)) {
    const el = page.querySelector<HTMLElement>(`[data-${group}="${CSS.escape(key)}"]`);
    if (!el) continue;
    const b = el.querySelector("b");
    if (b) b.textContent = fmtInt(count);
    el.classList.toggle("empty", count === 0);
  }
  scrollLog();
}

function clearFilters(): void {
  state.providers = [];
  state.query = "";
  state.lens = "all";
  state.focus = undefined;
  render();
  announce("filters cleared");
}

/**
 * Pin the exact id set a prune quadrant plotted, and land on the inventory
 * entry that can actually show them.
 *
 * The lens, the search and the provider chips are left alone on purpose: the
 * quadrant was computed FROM them, so clearing them would show a set the plot
 * never plotted. The nav entry does have to widen — the quadrant plots every
 * kind, so a pin landing under `skills` would silently drop the agents in it.
 */
function pinFocus(f: { label: string; ids: string[] }): void {
  if (!payload) return;
  state.focus = f;
  state.nav = "all";
  pruneFiltersForNav(payload, state);
  render();
  announce(`inventory pinned to ${f.ids.length} row${f.ids.length === 1 ? "" : "s"} — ${f.label}`);
}

/**
 * Where a stat-bar figure leads: the view that EXPLAINS it. That is the whole
 * reason the figures could shed their paragraphs — the derivation is one click
 * away rather than attached to every number.
 */
function openStat(key: string): void {
  if (!payload) return;
  if (key === "never") {
    state.nav = "all";
    state.lens = "never-fired";
    render();
    return announce("inventory, never-fired only");
  }
  const to = key === "cost" ? "prune" : key === "listing" ? "budget" : "growth";
  state.nav = to;
  pruneFiltersForNav(payload, state);
  render();
  announce(`${PANELS.find((p) => p.key === to)?.label ?? to} view`);
}

app.addEventListener("click", (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>(
    "[data-nav], [data-lens], [data-provider], [data-stat], [data-statbar], [data-prov], [data-theme-toggle], [data-check], [data-check-all], [data-disable-checked], [data-plugin-update], [data-logtoggle], [data-sort], [data-toggle], [data-open], [data-open-event], [data-rescan], [data-close], [data-clear], [data-unfocus], [data-quadrant], #catch, [data-id]"
  );
  if (!el || !payload) return;

  if (el.hasAttribute("data-clear")) return clearFilters();

  if (el.hasAttribute("data-unfocus")) {
    state.focus = undefined;
    render();
    return announce("pinned rows released — your other filters are unchanged");
  }

  // The stat bar switch. It changes only whether the figures are drawn — no
  // figure moves, and nothing is recomputed.
  if (el.hasAttribute("data-statbar")) {
    state.statBar = !state.statBar;
    render();
    return announce(state.statBar ? "headline figures shown" : "headline figures hidden");
  }

  if (el.hasAttribute("data-prov")) {
    state.provOpen = !state.provOpen;
    render();
    page.querySelector<HTMLElement>(".prov")?.scrollIntoView({ block: "nearest" });
    return announce(state.provOpen ? "caveats shown" : "caveats hidden");
  }

  if (el.hasAttribute("data-theme-toggle")) {
    // From "auto", the toggle flips away from whatever the system is showing —
    // pressing "light" while the system is already light would otherwise do
    // nothing visible and read as a broken control.
    const showing = state.theme === "auto" ? (systemPrefersLight() ? "light" : "dark") : state.theme;
    state.theme = showing === "light" ? "dark" : "light";
    render();
    return announce(`${state.theme} theme`);
  }

  if (el.dataset.check) {
    e.stopPropagation();
    const id = el.dataset.check;
    const on = state.checked ?? [];
    state.checked = on.includes(id) ? on.filter((x) => x !== id) : [...on, id];
    return render();
  }

  if (el.hasAttribute("data-check-all")) {
    // "All" means every row this list can actually act on — offering to select
    // a read-only row would print a count the action could not deliver.
    const selectable = [...page.querySelectorAll<HTMLElement>("[data-check]")].map((n) => n.dataset.check!);
    state.checked = (state.checked ?? []).length === selectable.length ? [] : selectable;
    return render();
  }

  if (el.hasAttribute("data-disable-checked")) {
    void doDisableChecked();
    return;
  }

  if (el.dataset.stat) return openStat(el.dataset.stat);

  // A quadrant of the prune plot: the ids it actually plotted, filtered into
  // the table. Resolved through the panel's own model so the set the click
  // shows is the set the readout counted, median and all.
  if (el.dataset.quadrant) {
    const key = el.dataset.quadrant;
    const ids = quadrantIds(payload, state, key);
    if (ids.length === 0) return announce("that quadrant is empty");
    const label = pruneModel(payload, state).quads[key as QuadrantKey]?.label ?? key;
    return pinFocus({ label, ids });
  }

  if (el.hasAttribute("data-logtoggle")) {
    state.logOpen = !state.logOpen;
    return render();
  }

  if (el.dataset.pluginUpdate) {
    e.stopPropagation();
    void doPluginUpdate(el.dataset.pluginUpdate, el.dataset.marketplace ?? "");
    return;
  }

  if (el.dataset.nav) {
    const to = el.dataset.nav;
    // Security is never reduced by a presentation default: the flagged entry
    // printed a count over the whole inventory and promised to show it, so it
    // clears the narrowing that would deliver fewer rows than it named. Every
    // other entry leaves the lens and the search exactly where they were.
    if (to === "flagged") {
      state.lens = "all";
      state.query = "";
      state.providers = [];
      state.focus = undefined;
    }
    state.nav = to;
    // A provider filter whose chip disappears in the new entry must not
    // survive as invisible narrowing with nothing on screen to turn off.
    pruneFiltersForNav(payload, state);
    const label = PANELS.find((p) => p.key === to)?.label ?? KIND_LABEL[to] ?? to;
    announce(`${label} view`);
    return render();
  }

  if (el.dataset.lens) {
    const v = el.dataset.lens as AppState["lens"];
    state.lens = state.lens === v ? "all" : v;
    return render();
  }

  if (el.dataset.provider) {
    const v = el.dataset.provider;
    state.providers = state.providers.includes(v)
      ? state.providers.filter((p) => p !== v)
      : [...state.providers, v];
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
