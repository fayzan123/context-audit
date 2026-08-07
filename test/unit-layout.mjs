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
// Chrome is not a dependency of this package, and neither is a WebSocket
// client. Without either the file says so and passes — a headless browser
// missing on a CI runner, or a Node old enough to predate the WebSocket
// global, is not a defect in the dashboard — but it names the skip rather than
// quietly reporting nothing.
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
// The other prerequisite, checked here beside Chrome's so that neither a server
// nor a browser is started before both are known present. `WebSocket` became a
// global in Node 21; this package supports Node 18, where driving CDP would
// mean taking a dependency the zero-dependency constraint forbids. Named, not
// silent — a measurement that did not run must never read as one that passed.
if (typeof WebSocket === "undefined") {
  ok(`skipped: no global WebSocket on ${process.version} (Node 21+ required for the CDP driver)`);
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
// Node 21+ ships a global WebSocket, so this needs no dependency — which is the
// whole point: the published package stays at zero. Older supported Nodes took
// the skip above rather than reaching here.
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

/**
 * Set when the CDP transport itself dies, as opposed to a measurement coming
 * back wrong. The distinction decides whether this file fails the build.
 *
 * The `open`/`error` race above used `{ once: true }` on BOTH, so the moment
 * the socket opened the error listener was removed and the socket ran the rest
 * of the session unguarded. A transport blip then surfaced as an unhandled
 * error inside undici's write path — a stack with no frame of ours in it,
 * failing one CI job out of four with nothing a reader could act on. Seen on
 * ubuntu/node22 on 2026-08-07; the same commit passed on re-run.
 *
 * A dead socket is the same class of event as a missing Chrome, which this file
 * already treats as "not a defect in the dashboard" and skips by name. A page
 * that genuinely broke does not close the socket — it answers, and answers
 * wrongly, and those assertions still fail the build.
 */
let transportError;

let nextId = 0;
const pending = new Map();
ws.addEventListener("message", (ev) => {
  const msg = JSON.parse(ev.data);
  const p = pending.get(msg.id);
  if (!p) return;
  pending.delete(msg.id);
  msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
});
// Persistent, unlike the handshake listeners above: every in-flight and future
// send has to fail loudly rather than hang until the job's timeout.
const die = (why) => {
  transportError ??= why;
  for (const [id, p] of pending) {
    pending.delete(id);
    p.reject(new Error(`CDP transport lost: ${why}`));
  }
};
ws.addEventListener("error", (ev) => die(ev?.message ?? "socket error"));
ws.addEventListener("close", (ev) => die(`socket closed (${ev?.code ?? "?"})`));

const send = (method, params = {}, sessionId) =>
  new Promise((resolve, reject) => {
    if (transportError) return reject(new Error(`CDP transport lost: ${transportError}`));
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    try {
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    } catch (err) {
      pending.delete(id);
      reject(err);
    }
  });

/**
 * A dead transport surfaces as a rejected top-level await, which Node reports
 * as an unhandled rejection and exits 1 on — a red build for something that is
 * not a layout regression. Exactly that case becomes the named skip this file
 * already uses for a missing Chrome; everything else still fails, loudly, with
 * the error printed.
 */
const onFatal = (err) => {
  if (transportError) {
    ok(`skipped: CDP transport lost mid-session (${transportError}) — layout not measured`);
    cleanup();
    process.removeAllListeners("exit");
    process.exit(0);
  }
  console.error(err);
  cleanup();
  process.removeAllListeners("exit");
  process.exit(1);
};
process.on("unhandledRejection", onFatal);
process.on("uncaughtException", onFatal);

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

  // --- readability, measured rather than asserted on source ----------------
  // The first version of this overhaul paid for its chrome budget by shrinking
  // text — table 12px, provenance 11px, terms 10.5px, axis labels 9.5px. That
  // is the one saving that makes a page harder to read rather than easier, so
  // the floor is pinned in COMPUTED pixels, where a stylesheet edit cannot
  // quietly walk it back.
  const type = await evaluate(`(() => {
    const px = (s) => { const el = document.querySelector(s); return el ? parseFloat(getComputedStyle(el).fontSize) : null; };
    const all = [...document.querySelectorAll("#page *")]
      .filter((el) => el.textContent && el.textContent.trim() && !el.querySelector("*"))
      .filter((el) => !el.closest("[aria-hidden='true']"))
      .map((el) => parseFloat(getComputedStyle(el).fontSize))
      .filter((n) => Number.isFinite(n));
    return {
      smallest: Math.min(...all),
      row: px(".inv tbody td.c-name"),
      nav: px(".nav span"),
      colDef: px(".thdef"),
      sampled: all.length,
    };
  })()`);
  check(
    "nothing rendered on the page is set below 11px",
    type.smallest >= 11 && type.sampled > 40,
    `smallest ${type.smallest}px across ${type.sampled} nodes`
  );
  check(
    "the table, the sidebar and the column definitions are all at reading size",
    type.row >= 13 && type.nav >= 13 && type.colDef >= 11,
    `row ${type.row}, nav ${type.nav}, def ${type.colDef}`
  );

  // --- light and dark are two calibrations of one instrument ----------------
  const themes = await evaluate(`(() => {
    const root = document.documentElement;
    const read = () => {
      const cs = getComputedStyle(root);
      const names = ["--bg","--ink","--ink-dim","--ink-faint","--rule","--rule-strong","--signal","--signal-dim","--signal-text","--danger","--wash"];
      const out = {};
      for (const n of names) out[n] = cs.getPropertyValue(n).trim();
      out.scheme = cs.colorScheme;
      return out;
    };
    const was = root.getAttribute("data-theme");
    root.setAttribute("data-theme", "dark");
    const dark = read();
    root.setAttribute("data-theme", "light");
    const light = read();
    if (was === null) root.removeAttribute("data-theme"); else root.setAttribute("data-theme", was);
    return { dark, light };
  })()`);
  check(
    "both themes define every palette token — no rule falls through to a default",
    Object.entries(themes.dark).every(([, v]) => v !== "") &&
      Object.entries(themes.light).every(([, v]) => v !== ""),
    JSON.stringify(themes)
  );
  check(
    "…and every one of them actually differs between the two",
    Object.keys(themes.dark).filter((k) => k !== "scheme").every((k) => themes.dark[k] !== themes.light[k]),
    Object.keys(themes.dark).filter((k) => themes.dark[k] === themes.light[k]).join(",")
  );
  check(
    "the light calibration declares its color-scheme, so form controls follow",
    themes.dark.scheme === "dark" && themes.light.scheme === "light",
    `${themes.dark.scheme} / ${themes.light.scheme}`
  );

  // --- contrast, computed from what the browser actually paints -------------
  // "AA" written in a comment beside a colour is not a measurement. This reads
  // the resolved rgb of every text token against every surface it can land on,
  // in BOTH calibrations, and does the WCAG arithmetic — so a palette tweak
  // that quietly drops a token under 4.5:1 fails here rather than in someone's
  // eyes. Light-mode amber on the lifted surface measured 4.42 before this
  // existed.
  const contrast = await evaluate(`(() => {
    // Chrome serialises computed colours in the space they were authored in,
    // so getComputedStyle().color on an oklch token comes back as oklch — and
    // parsing that as rgb yields nonsense. Rasterising one pixel through a
    // canvas asks the browser for the sRGB it will actually paint.
    const cv = document.createElement("canvas");
    cv.width = cv.height = 1;
    const ctx = cv.getContext("2d", { willReadFrequently: true });
    const rgb = (s) => {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = s;
      ctx.fillRect(0, 0, 1, 1);
      const d = ctx.getImageData(0, 0, 1, 1).data;
      return [d[0] / 255, d[1] / 255, d[2] / 255];
    };
    const lum = (c) => {
      const f = (v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
      return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
    };
    const ratio = (a, b) => {
      const x = Math.max(lum(a), lum(b)), y = Math.min(lum(a), lum(b));
      return (x + 0.05) / (y + 0.05);
    };
    const probe = document.createElement("span");
    document.body.appendChild(probe);
    const read = (v) => {
      probe.style.color = "var(" + v + ")";
      return rgb(getComputedStyle(probe).color);
    };
    const root = document.documentElement;
    const was = root.getAttribute("data-theme");
    const out = {};
    for (const theme of ["dark", "light"]) {
      root.setAttribute("data-theme", theme);
      const surfaces = ["--bg", "--bg-lift", "--bg-drawer"].map(read);
      const inks = ["--ink", "--ink-dim", "--ink-faint", "--signal", "--signal-text", "--danger"];
      out[theme] = {};
      for (const ink of inks) {
        const c = read(ink);
        out[theme][ink] = Math.min(...surfaces.map((s) => ratio(c, s)));
      }
    }
    if (was === null) root.removeAttribute("data-theme"); else root.setAttribute("data-theme", was);
    probe.remove();
    return out;
  })()`);
  for (const theme of ["dark", "light"]) {
    const failing = Object.entries(contrast[theme]).filter(([, r]) => r < 4.5);
    check(
      `every ${theme} text token clears WCAG AA on every surface it can land on`,
      failing.length === 0,
      failing.map(([k, r]) => `${k} ${r.toFixed(2)}:1`).join(", ")
    );
  }

  // --- one committed type scale, in rem -------------------------------------
  const scale = await evaluate(`(() => {
    const sizes = [...document.querySelectorAll("#page *")]
      .filter((el) => el.textContent && el.textContent.trim() && !el.querySelector("*"))
      .filter((el) => !el.closest("[aria-hidden='true']"))
      .map((el) => Math.round(parseFloat(getComputedStyle(el).fontSize) * 100) / 100);
    const cs = getComputedStyle(document.documentElement);
    return {
      distinct: [...new Set(sizes)].sort((a, b) => a - b),
      tokens: ["--text-micro", "--text-small", "--text-base", "--text-lead", "--text-figure"]
        .map((t) => cs.getPropertyValue(t).trim()),
      rootPx: parseFloat(getComputedStyle(document.documentElement).fontSize),
    };
  })()`);
  check(
    "the page renders a handful of committed sizes, not a spread of near-identical ones",
    scale.distinct.length <= 6,
    `${scale.distinct.length} distinct: ${scale.distinct.join(", ")}`
  );
  check(
    "the scale is declared in rem, so a reader's own default size still wins",
    scale.tokens.length === 5 && scale.tokens.every((t) => t.endsWith("rem")),
    scale.tokens.join(" · ")
  );
  // The proof that rem is doing something: double the root size and the page
  // has to follow. A px scale would sit there unchanged.
  const zoom = await evaluate(`(() => {
    const before = parseFloat(getComputedStyle(document.querySelector(".inv tbody td.c-name")).fontSize);
    document.documentElement.style.fontSize = "32px";
    const after = parseFloat(getComputedStyle(document.querySelector(".inv tbody td.c-name")).fontSize);
    document.documentElement.style.fontSize = "";
    return { before, after };
  })()`);
  check(
    "…and raising the reader's default size actually scales the table",
    zoom.after > zoom.before * 1.8,
    `${zoom.before}px → ${zoom.after}px at a 32px root`
  );

  // --- the prune view answers before it draws -------------------------------
  const prune = await evaluate(`(async () => {
    document.querySelector('[data-nav="prune"]').click();
    await new Promise((r) => setTimeout(r, 60));
    const verdict = document.querySelector(".panel-prune .verdict");
    const act = document.querySelector(".sl-act");
    const list = document.querySelector(".sl-list");
    const chart = document.querySelector(".pq-chart");
    return {
      verdict: verdict && verdict.textContent.trim(),
      verdictTop: verdict && Math.round(verdict.getBoundingClientRect().top),
      actionTop: act && Math.round(act.getBoundingClientRect().top),
      listTop: list && Math.round(list.getBoundingClientRect().top),
      foldOpen: document.querySelector(".panel-prune .pq-fold")?.open ?? null,
      hasChart: !!chart,
      viewport: window.innerHeight,
    };
  })()`);
  check(
    "the prune view leads with the finding in words, not with a plot",
    !!prune.verdict && /cost you [\d,]+ tok every session/.test(prune.verdict) &&
      prune.foldOpen === false && prune.hasChart === true,
    JSON.stringify(prune)
  );
  check(
    "the action sits above the list, on screen without scrolling past it",
    prune.actionTop !== null &&
      prune.actionTop > prune.verdictTop &&
      prune.actionTop < prune.listTop &&
      prune.actionTop < prune.viewport,
    JSON.stringify(prune)
  );

  // The footer carries payload-length content — a legend, two counts and an
  // absolute path — and it is the one band that can push the document sideways
  // if nothing in it is allowed to give.
  const feet = await evaluate(`(async () => {
    const out = [];
    for (const w of [1512, 1324, 1024]) {
      document.documentElement.style.width = w + "px";
      await new Promise((r) => requestAnimationFrame(r));
      const foot = document.querySelector(".foot");
      out.push({ w, over: foot.scrollWidth - foot.clientWidth });
    }
    document.documentElement.style.width = "";
    return out;
  })()`);
  check(
    "the footer gives before the document does, at every width",
    feet.every((f) => f.over === 0),
    feet.map((f) => `${f.w}: +${f.over}px`).join(", ")
  );

  // One narrow width, because a fixed sidebar plus a table is exactly the
  // shape that grows a horizontal scrollbar when nobody looks. Same 900px
  // height as above, so the budget comparison is like for like — a shorter
  // viewport spends a larger share on chrome that did not change.
  await send("Emulation.setDeviceMetricsOverride", { width: 1024, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);
  const narrow = await evaluate(`(() => {
    document.querySelector('[data-nav="all"]').click();
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
