import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { join } from "node:path";
import type { SourceContext } from "../sources/types.js";
import type { UiPayload } from "../types.js";
import { buildUiPayload, type UiBuildOptions } from "./inventory.js";
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

export async function startUiServer(
  ctx: SourceContext,
  opts: UiBuildOptions
): Promise<UiServer> {
  // A closed stdout must never take the dashboard down with it: launch the
  // process through `head`, or lose the terminal, and the next console.log
  // raises EPIPE — which by default exits node MID-REQUEST. The browser saw
  // it as ERR_EMPTY_RESPONSE on a toggle. Logging is best-effort; serving is
  // not.
  process.stdout.on("error", () => {});
  process.stderr.on("error", () => {});

  let payload: UiPayload = await buildUiPayload(ctx, opts);
  const token = randomBytes(16).toString("hex");

  // Two tabs, or a toggle landing mid-rescan, race on `payload`: scans are
  // async and finish out of order, so the last WRITER would otherwise win
  // rather than the newest SCAN — republishing a pre-move inventory whose
  // item IDs point at directories that have already been renamed.
  let scanGen = 0;
  const rescan = async (): Promise<UiPayload> => {
    const gen = ++scanGen;
    const fresh = await buildUiPayload(ctx, opts);
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
