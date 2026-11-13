import type { IncomingMessage } from "node:http";
import { expect, test } from "vite-plus/test";
import { cookieName, guard } from "../src/guard.ts";

const PORT = 4567;
const SECRET = "s3cret";
const req = (url: string, headers: Record<string, string> = {}, method = "GET") =>
  ({ url, method, headers: { host: `127.0.0.1:${PORT}`, ...headers } }) as unknown as IncomingMessage;
const withCookie = { cookie: `${cookieName(PORT)}=${SECRET}` };

test("guard: our own window, with the cookie, gets through", () => {
  expect(guard(req("/api/state", withCookie), SECRET, PORT)).toBeNull();
});

test("guard: no cookie, or the wrong one, is refused", () => {
  expect(guard(req("/api/state"), SECRET, PORT)?.status).toBe(403);
  expect(guard(req("/api/state", { cookie: `${cookieName(PORT)}=nope` }), SECRET, PORT)?.status).toBe(403);
});

test("guard: another host name (DNS rebinding) is refused, even with the cookie", () => {
  expect(guard(req("/", { ...withCookie, host: `evil.example:${PORT}` }), SECRET, PORT)?.status).toBe(403);
});

test("guard: writes from another origin or another site are refused", () => {
  expect(
    guard(req("/api/settings", { ...withCookie, origin: "https://evil.example" }, "POST"), SECRET, PORT)
      ?.status,
  ).toBe(403);
  expect(
    guard(req("/api/settings", { ...withCookie, "sec-fetch-site": "cross-site" }, "POST"), SECRET, PORT)
      ?.status,
  ).toBe(403);
});

test("guard: the dev link's key becomes the cookie, and leaves the address", () => {
  const r = guard(req(`/?k=${SECRET}`), SECRET, PORT);
  expect(r?.status).toBe(303);
  expect(r?.headers.location).toBe("/");
  expect(r?.headers["set-cookie"]).toContain(`${cookieName(PORT)}=${SECRET}`);
  expect(guard(req("/?k=wrong"), SECRET, PORT)?.status).toBe(403);
});
