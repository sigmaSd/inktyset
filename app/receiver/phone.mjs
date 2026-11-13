// Phone receiver for the hand2tex app: Folder Camera's receiver engine, run by app.py.
//
//   node phone.mjs STATE_DIR PHOTO_DIR
//
// Its own state folder, so it never touches the user's normal Folder Camera receiver.
// Talks JSON lines: commands on stdin ({"cmd":"pair"} / {"cmd":"revoke","id":...}),
// snapshots on stdout whenever something changes. Quits when stdin closes, so it
// lives and dies with app.py.
import { Receiver } from "folder-camera-receiver";

const [state, root] = process.argv.slice(2);
if (!state || !root) {
  console.error("usage: node phone.mjs STATE_DIR PHOTO_DIR");
  process.exit(2);
}

const receiver = new Receiver(state, new Map([["--root", root]]));
let last = "";
let closing = false;

function emit(force = false) {
  const s = receiver.snapshot();
  const msg = JSON.stringify({
    type: "snapshot",
    status: s.status,
    error: s.error,
    endpoint: s.endpoint,
    active: s.active,
    pairingExpiresAt: s.pairing ? s.pairing.expiresAt : null,
    qr: s.qr, // SVG of the pairing code; only ever shown in the local window
    devices: s.devices.filter((d) => !d.revoked).map((d) => ({ id: d.id, name: d.name })),
  });
  if (force || msg !== last) {
    last = msg;
    process.stdout.write(msg + "\n");
  }
}

async function shutdown(code = 0) {
  if (closing) return;
  closing = true;
  try {
    await receiver.close();
  } catch { /* already closed */ }
  process.exit(code);
}

try {
  await receiver.init();
  await receiver.start();
} catch (e) {
  process.stdout.write(JSON.stringify({ type: "snapshot", status: "error", error: String(e?.message || e) }) + "\n");
  process.exit(1);
}
emit(true);

setInterval(() => emit(), 1000);
setInterval(() => receiver.refreshNetwork().catch(() => {}), 5000);

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", async (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let m;
    try {
      m = JSON.parse(line);
      if (m.cmd === "pair") await receiver.pair();
      else if (m.cmd === "revoke") await receiver.revoke(m.id);
      else if (m.cmd === "start") await receiver.start();
    } catch (e) {
      process.stderr.write(`phone: ${m?.cmd ?? "?"} failed: ${e?.message || e}\n`);
    }
    emit(true);
  }
});
process.stdin.on("end", () => shutdown(0));
process.stdin.on("close", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
process.on("SIGINT", () => shutdown(0));
