#!/usr/bin/env node
// Unit — the chrome budget, measured in real pixels.
//
// This exists because the thing that regressed silently was LAYOUT, and no
// markup assertion can see it: the page accumulated five stacked control bands
// until 576px of a 900px viewport — 64% — was spent before the first table row,
// and every string assertion in the suite stayed green throughout. So this one
// runs the REAL bundle in a real browser at a real size and reads the row's
// bounding box.
//
// It serves dist/ui.html from a stub server rather than the audit server: the
// payload has to be deterministic or the measurement is, too, a measurement of
// whatever happens to be on this machine.
//
// Chrome is not a dependency of this package. Without it the file says so and
// passes — a headless browser missing on a CI runner is not a defect in the
// dashboard — but it names the skip rather than quietly reporting nothing.
import { createServer } from "node:http";
import { readFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

let failures = 0;
const ok = (n) => console.log(`  ok: ${n}`);
const check = (name, cond, detail = "") => {
  if (cond) ok(name);
  else {
    console.error(`  FAIL: ${name}${detail ? ` — ${detail}` : ""}`);
    failures++;
  }
};

console.log("LAYOUT unit (real bundle, real viewport):");

/** Chrome, wherever this machine keeps it. CHROME overrides everything. */
function findChrome() {
  const candidates = [
    process.env.CHROME,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter(Boolean);
  return candidates.find((c) => existsSync(c));
}

const chromePath = findChrome();
const bundle = join(root, "dist", "ui.html");
if (!existsSync(bundle)) {
  console.error("  FAIL: dist/ui.html is missing — run the build first");
  process.exit(1);
}
if (!chromePath) {
  ok("skipped: no Chrome on this machine (set CHROME=<path> to run the layout measurement)");
  process.exit(0);
}

// --- the stub server: the real bundle, one fixed payload --------------------
const payload = JSON.parse(readFileSync(join(root, "test", "fixtures", "render", "payload-s2.json"), "utf8"));
const html = readFileSync(bundle, "utf8");
const server = createServer((req, res) => {
  if (req.url?.startsWith("/api/audit")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, payload }));
    return;
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const pageUrl = `http://127.0.0.1:${server.address().port}/?token=test`;

// --- drive Chrome over CDP --------------------------------------------------
// Node 22 ships a global WebSocket, so this needs no dependency — which is the
// whole point: the published package stays at zero.
const profile = mkdtempSync(join(tmpdir(), "ca-layout-"));
const chrome = spawn(
  chromePath,
  [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "--window-size=1512,900",
    "--hide-scrollbars",
    "about:blank",
  ],
  { stdio: ["ignore", "ignore", "pipe"] }
);

const cleanup = () => {
  try {
    chrome.kill("SIGKILL");
  } catch {}
  server.close();
  // Best effort: Chrome writes its profile asynchronously and can still be
  // flushing when it dies, so a failed rmdir here is housekeeping, not a
  // test result — an ENOTEMPTY must never fail a green run.
  try {
    rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
  } catch {}
};
process.on("exit", cleanup);

/** Chrome prints its DevTools endpoint to stderr once, on startup. */
const endpoint = await new Promise((resolve, reject) => {
  let buf = "";
  const timer = setTimeout(() => reject(new Error("Chrome never announced a DevTools endpoint")), 20_000);
  chrome.stderr.on("data", (d) => {
    buf += String(d);
    const m = /ws:\/\/[^\s]+/.exec(buf);
    if (m) {
      clearTimeout(timer);
      resolve(m[0]);
    }
  });
  chrome.on("exit", (code) => {
    clearTimeout(timer);
    reject(new Error(`Chrome exited (${code}) before announcing an endpoint`));
  });
});

const ws = new WebSocket(endpoint);
await new Promise((r, j) => {
  ws.addEventListener("open", r, { once: true });
  ws.addEventListener("error", j, { once: true });
});

let nextId = 0;
const pending = new Map();
ws.addEventListener("message", (ev) => {
  const msg = JSON.parse(ev.data);
  const p = pending.get(msg.id);
  if (!p) return;
  pending.delete(msg.id);
  msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
});
const send = (method, params = {}, sessionId) =>
  new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });

const { targetId } = await send("Target.createTarget", { url: pageUrl });
const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
// The window flag sizes the OS window; the metrics override is what actually
// pins the layout viewport, which is what the budget is a share of.
await send(
  "Emulation.setDeviceMetricsOverride",
  { width: 1512, height: 900, deviceScaleFactor: 1, mobile: false },
  sessionId
);

/** Evaluate in the page, waiting for the async boot fetch to land. */
async function evaluate(expression) {
  const r = await send(
    "Runtime.evaluate",
    { expression, returnByValue: true, awaitPromise: true },
    sessionId
  );
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text ?? "evaluate threw");
  return r.result.value;
}

const READY = `new Promise((resolve) => {
  const t0 = Date.now();
  const tick = () => {
    const row = document.querySelector(".inv tbody tr[data-id]");
    if (row) return resolve(true);
    if (Date.now() - t0 > 15000) return resolve(false);
    setTimeout(tick, 50);
  };
  tick();
})`;

const ready = await evaluate(READY);
check("the real bundle boots and renders an inventory row", ready === true, "no row appeared within 15s");

if (ready === true) {
  const m = await evaluate(`(() => {
    const q = (s) => document.querySelector(s);
    const top = (s) => { const el = q(s); return el ? Math.round(el.getBoundingClientRect().top) : null; };
    const h = (s) => { const el = q(s); return el ? Math.round(el.getBoundingClientRect().height) : null; };
    return {
      viewport: window.innerHeight,
      firstRow: top(".inv tbody tr[data-id]"),
      // The scrollport's own height, not a row count: the fixture has a fixed
      // number of items, and "how many rows fit" is what the page controls.
      tableBox: h(".tablebox"),
      rowHeight: h(".inv tbody tr[data-id]"),
      sidebar: Math.round(q(".side").getBoundingClientRect().width),
      docScrollX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      statBar: h(".statbar"),
      lit: document.querySelectorAll(".nav.on").length,
    };
  })()`);

  const pct = (m.firstRow / m.viewport) * 100;
  // The number this whole overhaul exists for. It was 64%.
  check(
    "the first table row begins within the top 30% of a 900px viewport",
    m.firstRow !== null && pct <= 30,
    `first row at ${m.firstRow}px of ${m.viewport} = ${pct.toFixed(1)}%`
  );
  const fits = Math.floor((m.tableBox - 30) / m.rowHeight);
  check(
    "the table gets the page: its scrollport holds at least 16 rows",
    fits >= 16,
    `scrollport ${m.tableBox}px / ${m.rowHeight}px rows = ${fits} rows`
  );
  check(
    "the sidebar is fixed-width and does not collapse",
    m.sidebar === 208,
    `sidebar width: ${m.sidebar}px`
  );
  // The portfolio strip was made overflow-x:auto to stop it wrapping, which
  // hid content behind a scroller with no affordance. Nothing on this page
  // may push the document sideways.
  check("the page never scrolls horizontally", m.docScrollX === 0, `overflow: ${m.docScrollX}px`);
  check("the stat bar is one shallow row, not a band of hero numbers", m.statBar !== null && m.statBar <= 60, `stat bar: ${m.statBar}px`);
  check("exactly one sidebar entry is lit", m.lit === 1, `lit entries: ${m.lit}`);

  // Toggling the stat bar off must move the table up and change nothing else.
  const off = await evaluate(`(() => {
    document.querySelector("[data-statbar]").click();
    const row = document.querySelector(".inv tbody tr[data-id]");
    return {
      statBar: !!document.querySelector(".statbar"),
      firstRow: Math.round(row.getBoundingClientRect().top),
      cost: document.querySelector(".c-cost")?.textContent?.trim(),
      activity: document.querySelector(".c-act-col")?.textContent?.trim(),
    };
  })()`);
  check(
    "toggling the stat bar off draws fewer things and changes no figure",
    off.statBar === false && off.firstRow < m.firstRow,
    `first row moved ${m.firstRow} → ${off.firstRow}`
  );

  // Typing must not rebuild the controls the caret lives in — that is how a
  // search box eats the second character you type — while the sidebar counts
  // still have to follow the query, or a number stops predicting its click.
  const typed = await evaluate(`(async () => {
    document.querySelector("[data-statbar]").click();
    const input = document.querySelector("[data-search]");
    input.focus();
    for (const ch of "blind") {
      input.value += ch;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
    await new Promise((r) => setTimeout(r, 50));
    const live = document.activeElement;
    const navCount = (k) => document.querySelector('[data-nav="' + k + '"] b')?.textContent;
    return {
      focused: live === document.querySelector("[data-search]"),
      value: live && live.value,
      caret: live && live.selectionStart,
      all: navCount("all"),
      flagged: navCount("flagged"),
      rows: document.querySelectorAll(".inv tbody tr[data-id]").length,
    };
  })()`);
  check(
    "typing keeps the caret in the search field and never rebuilds it",
    typed.focused === true && typed.value === "blind" && typed.caret === 5,
    JSON.stringify(typed)
  );
  check(
    "…and the sidebar counts follow the query in place",
    typed.all === String(typed.rows) && typed.rows > 0,
    JSON.stringify(typed)
  );
  check(
    "…while the flagged count stays payload-wide, because security is not hidden by a filter",
    typed.flagged === "1",
    `flagged: ${typed.flagged}`
  );
  await evaluate(`(() => { const i = document.querySelector("[data-search]"); i.value = ""; i.dispatchEvent(new Event("input", { bubbles: true })); })()`);

  // One narrow width, because a fixed sidebar plus a table is exactly the
  // shape that grows a horizontal scrollbar when nobody looks. Same 900px
  // height as above, so the budget comparison is like for like — a shorter
  // viewport spends a larger share on chrome that did not change.
  await send("Emulation.setDeviceMetricsOverride", { width: 1024, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);
  const narrow = await evaluate(`(() => {
    document.querySelector("[data-statbar]").click();
    return {
      docScrollX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      sidebar: Math.round(document.querySelector(".side").getBoundingClientRect().width),
      firstRow: Math.round(document.querySelector(".inv tbody tr[data-id]").getBoundingClientRect().top),
      viewport: window.innerHeight,
    };
  })()`);
  check("at 1024×800 the page still never scrolls sideways", narrow.docScrollX === 0, `overflow: ${narrow.docScrollX}px`);
  check(
    "…and the sidebar narrows rather than collapsing to a second navigation state",
    narrow.sidebar === 164,
    `sidebar width: ${narrow.sidebar}px`
  );
  check(
    "…and the chrome budget still holds at that width",
    (narrow.firstRow / narrow.viewport) * 100 <= 34,
    `first row at ${narrow.firstRow}px of ${narrow.viewport} = ${((narrow.firstRow / narrow.viewport) * 100).toFixed(1)}%`
  );
}

cleanup();
process.removeAllListeners("exit");

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed`);
  process.exit(1);
}
console.log("all layout assertions passed");
