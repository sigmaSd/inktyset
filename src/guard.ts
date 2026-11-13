// Who may talk to the local server (src/server.ts): only Inktyset's own windows. As in MedStation's src/guard.ts,
// for node:http's requests:
// - Host: requests addressed to 127.0.0.1 / localhost on our port only — a website can't point a name of its
//   own at this machine (DNS rebinding) and reach the server.
// - A secret per launch, as a cookie (HttpOnly, SameSite=Strict) that the shell sets in the windows' session;
//   a normal browser gets it from /?k=<secret> (the link `--dev` prints), turned into the cookie and dropped
//   from the address. Any request without the cookie is refused.
// - Writes: refused when they say they come from another origin, or from another site.

import { randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

/** A random secret for this launch. */
export const newSecret = () => randomUUID().replaceAll("-", "");

/** The cookie holding the secret: one per port (cookies ignore ports), so two launches don't overwrite each other. */
export const cookieName = (port: number) => `inktyset_${port}`;

const HOSTS = ["127.0.0.1", "localhost", "[::1]"];
const READS = ["GET", "HEAD"];

const same = (a: string, b: string) => {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

function cookie(req: IncomingMessage, name: string): string {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return "";
}

export interface Refusal {
  status: number;
  headers: Record<string, string>;
  body: string;
}

const refuse = (req: IncomingMessage, why: string): Refusal =>
  (req.headers.accept ?? "").includes("text/html")
    ? {
        status: 403,
        headers: { "content-type": "text/html; charset=utf-8" },
        body:
          `<!doctype html><meta charset="utf-8"><title>Inktyset</title>` +
          `<p style="font:16px sans-serif;margin:3em">Inktyset only opens in its own window: start the app.</p>`,
      }
    : {
        status: 403,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ error: `Access refused (${why})` }),
      };

/** null when the request may go on; else the answer to give instead (a refusal, or the cookie being set). */
export function guard(req: IncomingMessage, secret: string, port: number): Refusal | null {
  const url = new URL(req.url ?? "/", "http://x");
  const method = req.method ?? "GET";

  const host = req.headers.host ?? "";
  if (!HOSTS.some((h) => host === `${h}:${port}`)) return refuse(req, "address");

  const origin = req.headers.origin;
  if (origin && !HOSTS.some((h) => origin === `http://${h}:${port}`)) return refuse(req, "origin");
  if (!READS.includes(method) && req.headers["sec-fetch-site"] === "cross-site") return refuse(req, "origin");

  const name = cookieName(port);
  const k = url.searchParams.get("k");
  if (k !== null) {
    if (!READS.includes(method) || !same(k, secret)) return refuse(req, "key");
    url.searchParams.delete("k");
    return {
      status: 303,
      headers: {
        location: url.pathname + url.search,
        "set-cookie": `${name}=${secret}; Path=/; HttpOnly; SameSite=Strict`,
        "cache-control": "no-store",
      },
      body: "",
    };
  }
  if (!same(cookie(req, name), secret)) return refuse(req, "key");
  return null;
}

/**
 * What the pages may load (Content-Security-Policy): only from the server itself — no inline script, nothing
 * from elsewhere. Inline styles stay allowed (the pages set some); pdf.js draws with blob: workers and images.
 */
export const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");
