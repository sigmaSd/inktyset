import { expect, test } from "vite-plus/test";
import {
  cleanProfile,
  parseFit,
  parseHelp,
  profileArgs,
  profileKey,
  splitArgs,
} from "../src/engine-profile.ts";

// lines of llama-server's --help (build 12651), as they are
const HELP = `----- common params -----
-ub,   --ubatch-size N                  physical maximum batch size (default: 512)
                                        (env: LLAMA_ARG_UBATCH)
-fa,   --flash-attn [on|off|auto]       set Flash Attention use ('on', 'off', or 'auto', default: 'auto')
-kvo,  --kv-offload, -nkvo, --no-kv-offload
                                        whether to enable KV cache offloading (default: enabled)
-ctk,  --cache-type-k TYPE              KV cache data type for K
-ctv,  --cache-type-v TYPE              KV cache data type for V
--op-offload, --no-op-offload           whether to offload host tensor operations to device (default: true)
--mmproj-offload, --no-mmproj-offload   whether to enable GPU offloading for multimodal projector (default: true)
-lm,   --load-mode MODE                 model loading mode (default: auto)
-ot,   --override-tensor <tensor name pattern>=<buffer type>,...
-ngl,  --gpu-layers, --n-gpu-layers N   max. number of layers to store in VRAM
--jinja                                 use jinja template for chat`;

test("engine profile: an engine's options, read from its --help, with what each takes after it", () => {
  const f = parseHelp(HELP);
  expect(f.get("-ub")).toBe("value");
  expect(f.get("--ubatch-size")).toBe("value");
  expect(f.get("-fa")).toBe("optional");
  expect(f.get("-nkvo")).toBe("none");
  expect(f.get("--no-kv-offload")).toBe("none");
  expect(f.get("--no-op-offload")).toBe("none");
  expect(f.get("-ot")).toBe("value");
  expect(f.get("--n-gpu-layers")).toBe("value");
  expect(f.get("--jinja")).toBe("none");
  expect(f.has("--no-mmap")).toBe(false);
});

test("engine profile: only what is set is kept, checked; the same profile, the same key", () => {
  expect(cleanProfile({})).toBeUndefined();
  expect(
    cleanProfile({ ubatch: "256", kvType: "q9", flashAttn: "on", opOffload: true, extra: "  " }),
  ).toEqual({
    ubatch: 256,
    flashAttn: "on",
  });
  expect(profileKey(undefined)).toBe("");
  expect(profileKey({ flashAttn: "on", ubatch: 256 })).toBe(profileKey({ ubatch: 256, flashAttn: "on" }));
  expect(profileKey({ ubatch: 256 })).not.toBe(profileKey({ ubatch: 128 }));
});

test("engine profile: its options as the engine names them; what it doesn't know is left out and said", () => {
  const flags = parseHelp(HELP);
  const { args, skipped } = profileArgs(
    {
      ubatch: 256,
      flashAttn: "on",
      kvOnCpu: true,
      kvType: "q8_0",
      opOffload: false,
      visionOnCpu: true,
      loadMode: "none",
      extra: '--jinja --top-k 1 -ngl 20 -fa off --nonsense "a b"',
    },
    flags,
  );
  expect(args).toEqual([
    "-ub",
    "256",
    "-fa",
    "on",
    "-nkvo",
    "-ctk",
    "q8_0",
    "-ctv",
    "q8_0",
    "--no-op-offload",
    "--no-mmproj-offload",
    "-lm",
    "none",
    "--jinja",
    "-ngl",
    "20",
    "-fa",
    "off",
  ]);
  expect(skipped).toEqual(["--top-k 1", "--nonsense a b"]);
  // an engine from before --load-mode: its own words for it
  const old = new Map([["--no-mmap", "none" as const]]);
  expect(profileArgs({ loadMode: "none" }, old)).toEqual({ args: ["--no-mmap"], skipped: [] });
  expect(profileArgs({ loadMode: "mlock" }, old)).toEqual({ args: [], skipped: ["--load-mode mlock"] });
  expect(profileArgs(undefined, flags)).toEqual({ args: [], skipped: [] });
});

test("engine profile: options typed on one line, a quoted part whole", () => {
  expect(splitArgs(` -ot "blk\\.2.*=CPU" --x 'a b'  -n -1 `)).toEqual([
    "-ot",
    "blk\\.2.*=CPU",
    "--x",
    "a b",
    "-n",
    "-1",
  ]);
});

// llama-fit-params -lv 4, Inkling 2 Mini UD-Q4_K_XL on a 16 GB RX 7600 XT (shortened: the first table and the last)
const HEAD = `0.00.387.443 I common_memory_breakdown_print: | memory breakdown [MiB]                 | total    free     self   model   context   compute    unaccounted |
0.00.387.445 I common_memory_breakdown_print: |   - Vulkan1 (RX 7600 XT (RADV NAVI33)) | 16368 = 16343 + (18427 = 16332 +     627 +    1467) +      -18402 |
0.00.387.446 I common_memory_breakdown_print: |   - Host                               |                   469 =   469 +       0 +      49                |
0.00.417.533 I common_params_fit_impl: projected to use 18427 MiB of device memory vs. 16343 MiB of free device memory
0.00.417.535 I common_params_fit_impl: cannot meet free memory target of 1024 MiB, need to reduce device memory by 3108 MiB`;

test("engine profile: a model split between the chip and the computer's memory, as llama.cpp chose it", () => {
  const log = `${HEAD}
0.01.344.737 I common_params_fit_impl:   - Vulkan1 (AMD Radeon RX 7600 XT (RADV NAVI33)): 49 layers,  10437 MiB used,   5905 MiB free
0.04.019.827 I common_memory_breakdown_print: | memory breakdown [MiB]                 | total    free     self   model   context   compute    unaccounted |
0.04.019.830 I common_memory_breakdown_print: |   - Vulkan1 (RX 7600 XT (RADV NAVI33)) | 16368 = 16343 + (14985 = 12889 +     627 +    1467) +      -14960 |
0.04.019.830 I common_memory_breakdown_print: |   - Host                               |                   3961 =  3911 +       0 +      49                |
0.04.054.739 I common_params_fit_impl:   - Vulkan1 (AMD Radeon RX 7600 XT (RADV NAVI33)): 49 layers (29 overflowing),  14985 MiB used,   1357 MiB free
0.04.054.744 I common_fit_params: successfully fit params to free device memory`;
  const fit = parseFit(log, '-c 12288 -ngl 49 -ot "blk\\.20\\.ffn_down.*=CPU"\n');
  expect(fit.devices).toEqual([
    {
      name: "Vulkan1 (RX 7600 XT (RADV NAVI33))",
      total: 16368,
      free: 16343,
      model: 12889,
      context: 627,
      compute: 1467,
    },
  ]);
  expect(fit.host).toEqual({ model: 3911, context: 0, compute: 49 });
  expect(fit.layers).toEqual({ total: 49, partial: 29 });
  expect(fit.fitted).toBe('-c 12288 -ngl 49 -ot "blk\\.20\\.ffn_down.*=CPU"');
  expect(fit.problem).toBe("");
});

test("engine profile: a context so large that almost all of the model goes to the processor", () => {
  const log = `${HEAD}
0.03.272.890 I common_memory_breakdown_print: | memory breakdown [MiB]                 | total    free     self   model   context   compute    unaccounted |
0.03.272.892 I common_memory_breakdown_print: |   - Vulkan1 (RX 7600 XT (RADV NAVI33)) | 16368 = 16343 + (13563 =   469 +       0 +   13093) +      -13538 |
0.03.272.893 I common_memory_breakdown_print: |   - Host                               |                  18414 = 16332 +    1907 +     174                |
0.03.301.112 I common_params_fit_impl:   - Vulkan1 (AMD Radeon RX 7600 XT (RADV NAVI33)):  1 layers,  13563 MiB used,   2780 MiB free`;
  const fit = parseFit(log, "-c 53248 -ngl 1");
  expect(fit.layers).toEqual({ total: 1, partial: 0 });
  expect(fit.devices[0]).toMatchObject({ model: 469, compute: 13093 });
  expect(fit.host).toEqual({ model: 16332, context: 1907, compute: 174 });
});

test("engine profile: a model that fits as asked; a fit llama.cpp refused", () => {
  const fits = parseFit(
    `0.00.230.101 I common_memory_breakdown_print: | memory breakdown [MiB]                 | total    free     self   model   context   compute    unaccounted |
0.00.230.103 I common_memory_breakdown_print: |   - Vulkan1 (RX 7600 XT (RADV NAVI33)) | 16368 = 16343 + ( 5832 =  4983 +     435 +     414) +       -5807 |
0.00.230.104 I common_memory_breakdown_print: |   - Host                               |                   589 =   545 +       0 +      44                |
0.00.262.410 I common_params_fit_impl: will leave 10510 >= 1024 MiB of free device memory, no changes needed`,
    "-c 12288",
  );
  expect(fits.layers).toBeNull();
  expect(fits.devices[0]).toMatchObject({ model: 4983, context: 435, compute: 414 });
  const refused = parseFit(
    "0.00.382.131 W common_fit_params: failed to fit params to free device memory: n_gpu_layers already set by user to 99, abort",
    "",
  );
  expect(refused.problem).toBe(
    "common_fit_params: failed to fit params to free device memory: n_gpu_layers already set by user to 99, abort",
  );
});
