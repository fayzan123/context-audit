import { execFile, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { isAbsolute, join } from "node:path";
import { openLedger, type Ledger } from "../ledger.js";
import { scanLedgerHome, type AuditContext } from "../sources/index.js";
import type { UiPayload } from "../types.js";
import { buildUiPayload, eventDigest, type UiBuildOptions } from "./inventory.js";
import { openInEditor } from "./open.js";
import { performToggle } from "./toggle.js";

/**
 * A localhost server with mutating endpoints is a CSRF/DNS-rebinding target:
 * any webpage can POST to 127.0.0.1 blind. For a security-branded tool that
 * has to be closed from v1, not patched later:
 *
 *  - bound to 127.0.0.1, never 0.0.0.0;
 *  - a random session token, embedded in the URL the browser is opened at,
 *    required on EVERY /api request — reads included;
 *  - Host and Origin validated on every request;
 *  - anything failing a check gets a 403 and a line in the terminal.
 */
export interface UiServer {
  server: Server;
  url: string;
  token: string;
  port: number;
}

const JSON_LIMIT = 64 * 1024;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > JSON_LIMIT) {
        reject(new Error("body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolvePromise(body));
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, type: string, body: string): void {
  res.writeHead(status, {
    "Content-Type": type,
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  });
  res.end(body);
}

const sendJson = (res: ServerResponse, status: number, value: unknown): void =>
  send(res, status, "application/json; charset=utf-8", JSON.stringify(value));

/**
 * Names and paths come out of files an attacker may have written, and these
 * lines go to a terminal that interprets escape sequences: an item called
 * `\e[2J…` could clear the screen or rewrite the line above it, which is a
 * way to forge the tool's own output. Control characters never reach the TTY.
 */
const plain = (s: string): string =>
  s.replace(/[\u0000-\u001f\u007f-\u009f]/g, "?").slice(0, 200);

let codeCliSeen: boolean | undefined;

/**
 * Open a transcript at a cited line. `code --goto file:line` opens a buffer at
 * the exact line and never runs its argument; without the VS Code CLI the OS
 * opener shows the file (no line affordance) behind openInEditor's own
 * launcher guards.
 */
function openTranscriptAt(file: string, line: number): { ok: true; command: string } | { ok: false; error: string } {
  if (codeCliSeen === undefined) {
    try {
      codeCliSeen = spawnSync("code", ["--version"], { stdio: "ignore", timeout: 3000 }).status === 0;
    } catch {
      codeCliSeen = false;
    }
  }
  if (!codeCliSeen) return openInEditor(file);
  const child = spawn("code", ["--goto", `${file}:${line}`], { stdio: "ignore", detached: true });
  child.on("error", () => {});
  child.unref();
  return { ok: true, command: "code" };
}

export async function startUiServer(
  ctx: AuditContext,
  opts: UiBuildOptions
): Promise<UiServer> {
  // A closed stdout must never take the dashboard down with it: launch the
  // process through `head`, or lose the terminal, and the next console.log
  // raises EPIPE — which by default exits node MID-REQUEST. The browser saw
  // it as ERR_EMPTY_RESPONSE on a toggle. Logging is best-effort; serving is
  // not.
  process.stdout.on("error", () => {});
  process.stderr.on("error", () => {});

  // The scan's own ledger instance, reused by open-event: reopening the
  // store per click re-parsed the entire event history for one lookup.
  let scanLedger: Ledger | undefined;
  const buildOpts: UiBuildOptions = { ...opts, onLedger: (l) => { scanLedger = l; } };

  let payload: UiPayload = await buildUiPayload(ctx, buildOpts);
  const token = randomBytes(16).toString("hex");

  // Two tabs, or a toggle landing mid-rescan, race on `payload`: scans are
  // async and finish out of order, so the last WRITER would otherwise win
  // rather than the newest SCAN — republishing a pre-move inventory whose
  // item IDs point at directories that have already been renamed.
  let scanGen = 0;
  const rescan = async (): Promise<UiPayload> => {
    const gen = ++scanGen;
    const fresh = await buildUiPayload(ctx, buildOpts);
    if (gen === scanGen) payload = fresh;
    // A superseded scan hands back the CURRENT inventory, not its own stale
    // one — otherwise the tab that asked would render item IDs the server has
    // already replaced, and its next click would 404.
    return payload;
  };

  // The page ships inside the package as one self-contained file; reading it
  // once at startup means a mid-session `npm update` cannot swap the UI out
  // from under an open dashboard.
  const html = readFileSync(new URL("../ui.html", import.meta.url), "utf8");

  const skillRoots = {
    enabledRoot: join(ctx.home, ".claude", "skills"),
    disabledRoot: join(ctx.home, ".claude", "skills-disabled"),
  };

  const server = createServer(async (req, res) => {
    // Node's HTTP parser accepts absolute-form request targets that WHATWG URL
    // then rejects (`GET http://[ HTTP/1.1`). In an async handler that throw
    // becomes an unhandled rejection — fatal by default — so one line on a raw
    // socket killed the dashboard before any Host, Origin or token check ran.
    let url: URL;
    try {
      url = new URL(req.url ?? "/", `http://127.0.0.1`);
    } catch {
      return sendJson(res, 400, { ok: false, error: "bad request" });
    }
    const deny = (why: string): void => {
      console.error(`context-audit ui: denied ${plain(String(req.method))} ${plain(url.pathname)} — ${why}`);
      sendJson(res, 403, { ok: false, error: "forbidden" });
    };

    // Host must be exactly this server. A DNS-rebinding page reaches this
    // port with the attacker's hostname in Host; that request dies here.
    const port = (server.address() as { port: number }).port;
    const host = req.headers.host ?? "";
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
      return deny(`bad Host: ${JSON.stringify(plain(host))}`);
    }
    // Same-origin requests carry no Origin or their own; anything else is a
    // foreign page speaking to this port.
    const origin = req.headers.origin;
    if (origin && origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) {
      return deny(`bad Origin: ${JSON.stringify(plain(origin))}`);
    }

    if (url.pathname === "/" && (req.method === "GET" || req.method === "HEAD")) {
      res.setHeader(
        "Content-Security-Policy",
        "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; connect-src 'self'"
      );
      return send(res, 200, "text/html; charset=utf-8", html);
    }

    if (!url.pathname.startsWith("/api/")) {
      return sendJson(res, 404, { ok: false, error: "not found" });
    }

    // Every /api request — reads included — presents the session token. The
    // frontend sends it as a custom header, which is itself CSRF-proof: a
    // cross-origin page cannot attach one without a preflight this server
    // never approves.
    const presented = req.headers["x-context-audit-token"] ?? url.searchParams.get("token");
    if (presented !== token) return deny("missing or wrong session token");

    try {
      if (url.pathname === "/api/audit" && req.method === "GET") {
        return sendJson(res, 200, { ok: true, payload });
      }

      if (url.pathname === "/api/rescan" && req.method === "POST") {
        return sendJson(res, 200, { ok: true, payload: await rescan() });
      }

      if (url.pathname === "/api/toggle" && req.method === "POST") {
        const body = JSON.parse((await readBody(req)) || "{}");
        // The ID is the only thing taken from the client; the path it maps to
        // comes from the server's own inventory.
        const item = payload.items.find((i) => i.id === body?.id);
        if (!item) {
          return sendJson(res, 404, { ok: false, error: "unknown item — rescan and retry" });
        }
        if (!item.togglable) {
          return sendJson(res, 403, {
            ok: false,
            error: item.readOnlyReason ?? "this item cannot be toggled",
          });
        }
        // A name that exists on both sides of the toggle is a collision the
        // drawer tells the user about, so the refusal has to be real at the
        // level the drawer states it: the DISPATCH NAME. performToggle's own
        // guard compares basenames, which is the filesystem's question and a
        // different one — a bare `zed.md` whose frontmatter says `name: eta`
        // is the same dispatch name as `eta/` with a different basename, and
        // moving it would silently produce two enabled copies of one name.
        if (item.twinPath) {
          return sendJson(res, 409, {
            ok: false,
            error: `"${item.name}" exists both enabled and disabled (${item.path} and ${item.twinPath}) — resolve the duplicate before toggling`,
          });
        }
        const result = performToggle(item.path, skillRoots);
        if (!result.ok) return sendJson(res, 409, { ok: false, error: result.error });
        console.log(`context-audit ui: ${result.action}d ${plain(item.name)} (${plain(result.from)} → ${plain(result.to)})`);
        // A successful action always triggers a rescan so the UI never shows
        // stale state — measured at <1s on a real setup, no cache needed.
        // from/to ride along so the browser's activity log can print the same
        // line the terminal just did.
        return sendJson(res, 200, {
          ok: true,
          action: result.action,
          from: result.from,
          to: result.to,
          payload: await rescan(),
        });
      }

      if (url.pathname === "/api/open" && req.method === "POST") {
        const body = JSON.parse((await readBody(req)) || "{}");
        const item = payload.items.find((i) => i.id === body?.id);
        if (!item) {
          return sendJson(res, 404, { ok: false, error: "unknown item — rescan and retry" });
        }
        const result = openInEditor(item.path);
        if (!result.ok) {
          console.error(`context-audit ui: refused to open ${plain(item.name)} — ${plain(result.error)}`);
          return sendJson(res, 409, { ok: false, error: result.error });
        }
        console.log(`context-audit ui: opened ${plain(item.name)} via ${result.command}`);
        return sendJson(res, 200, { ok: true, command: result.command });
      }

      if (url.pathname === "/api/open-event" && req.method === "POST") {
        const body = JSON.parse((await readBody(req)) || "{}");
        const item = payload.items.find((i) => i.id === body?.itemId);
        if (!item) {
          return sendJson(res, 404, { ok: false, error: "unknown item — rescan and retry" });
        }
        // The browser names events by id only, and only ids this item's own
        // drill-down lists resolve — the payload is the server's inventory of
        // what the browser may cite, exactly as with item ids.
        const eventId = typeof body?.eventId === "string" ? body.eventId : "";
        if (!item.fires?.events?.some((e) => e.id === eventId)) {
          return sendJson(res, 404, { ok: false, error: "unknown event — rescan and retry" });
        }
        // The transcript location comes from the server's own ledger, never
        // from the request — the browser-side event id is an opaque digest of
        // the ledger id (raw ids can embed paths), resolved here server-side.
        // The last scan's ledger instance is reused; the reopen is only the
        // fallback for a scan that could not hand one over.
        const src = (scanLedger ?? openLedger(scanLedgerHome(ctx)))
          .readEvents()
          .find((e) => eventDigest(e.id) === eventId)?.src;
        if (!src) {
          return sendJson(res, 409, { ok: false, error: "no transcript pointer was recorded for this event" });
        }
        // The ledger lives in the user's home and is treated like every other
        // on-disk input: a pointer that is not an absolute path with a real
        // line number is refused, not repaired.
        if (!isAbsolute(src.file) || !Number.isInteger(src.line) || src.line < 1) {
          return sendJson(res, 409, { ok: false, error: "this event's transcript pointer is malformed" });
        }
        if (!existsSync(src.file)) {
          return sendJson(res, 410, { ok: false, error: "transcript deleted (event retained)" });
        }
        const result = openTranscriptAt(src.file, src.line);
        if (!result.ok) {
          console.error(`context-audit ui: refused to open event ${plain(eventId)} — ${plain(result.error)}`);
          return sendJson(res, 409, { ok: false, error: result.error });
        }
        console.log(`context-audit ui: opened transcript for ${plain(item.name)} at line ${src.line} via ${result.command}`);
        return sendJson(res, 200, { ok: true, command: result.command });
      }

      if (url.pathname === "/api/plugin-update" && req.method === "POST") {
        const body = JSON.parse((await readBody(req)) || "{}");
        // Same trust model as toggle/open: the client names a plugin, the
        // server acts only on plugins present in its own inventory — and the
        // command runs via execFile, so nothing here ever touches a shell.
        const meta = payload.items
          .map((i) => i.plugin)
          .find((p) => p && p.name === body?.name && p.marketplace === body?.marketplace);
        if (!meta?.marketplace) {
          return sendJson(res, 404, { ok: false, error: "unknown plugin — rescan and retry" });
        }
        // The ref becomes an argv for the claude CLI. execFile means no shell,
        // but a name starting with "-" would still parse as a FLAG — and these
        // names originate in installed_plugins.json, a file this tool treats
        // as attacker-influenced everywhere else.
        const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
        if (!SAFE_REF.test(meta.name) || !SAFE_REF.test(meta.marketplace)) {
          return sendJson(res, 400, { ok: false, error: "plugin name or marketplace has an unsafe shape" });
        }
        const ref = `${meta.name}@${meta.marketplace}`;
        const command = `claude plugin update ${ref}`;
        // The CLI's own stdout+stderr travel back with the response — the
        // browser's activity log shows exactly what the terminal would have.
        const capture = (stdout: string, stderr: string): string =>
          `${stdout ?? ""}${stderr ? (stdout ? "\n" : "") + stderr : ""}`.slice(0, 8192);
        try {
          const output = await new Promise<string>((resolvePromise, reject) => {
            execFile("claude", ["plugin", "update", ref], { timeout: 180_000 }, (err, stdout, stderr) => {
              if (!err) return resolvePromise(capture(stdout, stderr));
              if ((err as NodeJS.ErrnoException).code === "ENOENT") {
                return reject(
                  Object.assign(new Error("the `claude` CLI was not found on this machine's PATH"), { output: "" })
                );
              }
              reject(
                Object.assign(new Error((stderr || stdout || err.message).trim().slice(0, 400)), {
                  output: capture(stdout, stderr),
                })
              );
            });
          });
          console.log(
            `context-audit ui: updated plugin ${plain(ref)} — ${plain(output.trim().split("\n").pop() ?? "")}`
          );
          return sendJson(res, 200, { ok: true, command, output, payload: await rescan() });
        } catch (err: any) {
          const msg = err?.message ?? "update failed";
          console.error(`context-audit ui: plugin update failed for ${plain(ref)} — ${plain(msg)}`);
          return sendJson(res, 502, { ok: false, error: msg, command, output: err?.output ?? "" });
        }
      }

      return sendJson(res, 404, { ok: false, error: "not found" });
    } catch (err: any) {
      sendJson(res, 500, { ok: false, error: err?.message ?? String(err) });
    }
  });

  // A malformed request must never take the dashboard down with it.
  server.on("clientError", (_err, socket) => {
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  });

  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const port = (server.address() as { port: number }).port;

  return { server, url: `http://127.0.0.1:${port}/?token=${token}`, token, port };
}
