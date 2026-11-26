// Where llama.cpp would put a model with an engine profile (src/engine-profile.ts), without loading it:
//   node tools/fit.ts <model.gguf> [--mmproj f.gguf] [--ctx N] [--ub N] [--fa on|off|auto] [--nkvo]
//                     [--kv f16|q8_0|q4_0] [--no-op-offload] [--vision-cpu] [--load auto|none|mmap|mlock]
//                     [--extra="more llama-server options"] [--engine path/to/llama-server]
// The engine: --engine, else the one Inktyset downloaded (INKTYSET_USERDATA, else ~/.config/Inktyset).

import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { programPath } from "../src/components.ts";
import { cleanProfile, fitPreview, profileArgs, programFlags } from "../src/engine-profile.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    mmproj: { type: "string" },
    ctx: { type: "string", default: "12288" },
    ub: { type: "string" },
    fa: { type: "string" },
    nkvo: { type: "boolean" },
    kv: { type: "string" },
    "no-op-offload": { type: "boolean" },
    "vision-cpu": { type: "boolean" },
    load: { type: "string" },
    extra: { type: "string" },
    engine: { type: "string" },
  },
});
const model = positionals[0];
if (!model) {
  console.error("node tools/fit.ts <model.gguf> [options]: see the top of tools/fit.ts");
  process.exit(2);
}
const userData = process.env.INKTYSET_USERDATA ?? join(homedir(), ".config", "Inktyset");
const server = values.engine ?? (await programPath(userData, "engine"));
if (!server) {
  console.error(`no engine: --engine, or download it in Inktyset (looked in ${userData})`);
  process.exit(2);
}
const profile = cleanProfile({
  ctx: values.ctx,
  ubatch: values.ub,
  flashAttn: values.fa,
  kvOnCpu: values.nkvo,
  kvType: values.kv,
  opOffload: values["no-op-offload"] ? false : undefined,
  visionOnCpu: values["vision-cpu"],
  loadMode: values.load,
  extra: values.extra,
});

const gb = (mib: number) => `${(mib / 1024).toFixed(1)} GB`;
const t0 = Date.now();
const fit = await fitPreview({ server, model, mmproj: values.mmproj, ctx: Number(values.ctx), profile });
const { args, skipped } = profileArgs(profile, await programFlags(server));
console.log(`llama-server options: ${args.join(" ") || "(none)"}`);
if (skipped.length) console.log(`not known to this engine, left out: ${skipped.join(", ")}`);
for (const d of fit.devices) {
  const used = d.model + d.context + d.compute + fit.vision;
  console.log(
    `${d.name}: ${gb(used)} of ${gb(d.total)} — model ${gb(d.model)}, context ${gb(d.context)}, ` +
      `scratch ${gb(d.compute)}${fit.vision ? `, vision ${gb(fit.vision)}` : ""}`,
  );
}
const h = fit.host;
console.log(`computer's memory: model ${gb(h.model)}, context ${gb(h.context)}, scratch ${gb(h.compute)}`);
console.log(
  fit.layers
    ? `layers on the chip: ${fit.layers.total}${fit.layers.partial ? `, ${fit.layers.partial} with experts in the computer's memory` : ""}`
    : "all of it on the chip, as asked",
);
if (fit.problem) console.log(`llama.cpp: ${fit.problem}`);
console.log(
  `(${((Date.now() - t0) / 1000).toFixed(1)} s; chosen: ${fit.fitted.length > 120 ? `${fit.fitted.slice(0, 120)}…` : fit.fitted})`,
);
