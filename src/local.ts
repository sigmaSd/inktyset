// Pages never leave the user's own machines: a model server must be on this computer or the local network
// (a home server, a NAS, a desktop with a big graphics card), never a cloud service. The address is checked
// when the model is chosen and again before every reading, after the name is resolved, so a name that
// points to a public address is refused too.

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { msg } from "./i18n.ts";

/** Loopback, private, link-local and shared (CGNAT, VPNs like Tailscale) addresses. */
export function isPrivateAddress(ip: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) ip = mapped[1];
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 127 ||
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  if (isIP(ip) === 6) {
    const s = ip.toLowerCase();
    return s === "::1" || /^f[cd][0-9a-f]{2}:/.test(s) || /^fe[89ab][0-9a-f]:/.test(s);
  }
  return false;
}

/** Throws unless `url` is an http(s) address on this computer or the local network. */
export async function checkLocalUrl(url: string): Promise<void> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error(msg("notAnAddress", { url }));
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error(msg("notAnAddress", { url }));
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host)
    ? [host]
    : (await lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
  if (!addresses.length) throw new Error(msg("hostNotFound", { host }));
  if (!addresses.every(isPrivateAddress)) throw new Error(msg("notLocal", { host }));
}
