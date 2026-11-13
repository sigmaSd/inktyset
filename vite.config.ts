// The whole toolchain, through Vite+ (`vp`):
//   vp build   the window pages (app/ui/*.html and their scripts) → app/ui/dist/
//   vp pack    Electron's main process (everything Inktyset does), one file → dist/app/electron.mjs
//   vp check   format (Oxfmt), lint (Oxlint) and type-check (TypeScript 7) — at commit (.vite-hooks/pre-commit)
//   vp lint    lint and type-check, no formatting: while editing
//   vp test    the tests (Vitest), tests/*.test.ts
//   vp run dev the app from this checkout (builds, then starts Electron)

import { defineConfig } from "vite-plus";

const ui = new URL("./app/ui/", import.meta.url).pathname;
const pages = ["index", "worker"]; // the window, and the hidden page that renders images and PDFs

export default defineConfig({
  root: ui,
  base: "/",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "chrome140", // Electron's Chromium
    rollupOptions: { input: Object.fromEntries(pages.map((p) => [p, `${ui}${p}.html`])) },
  },

  fmt: {
    printWidth: 110,
    ignorePatterns: ["app/ui/dist/**", "dist/**", "pnpm-lock.yaml", "*.md", "models/**", "test/**"],
  },
  lint: {
    ignorePatterns: ["app/ui/dist/**", "dist/**", "test/**"],
    options: { typeAware: true, typeCheck: true },
    rules: {
      // deliberate: the windows start work they don't wait for (each catches and shows its own errors)
      "typescript/no-floating-promises": "off",
      // deliberate: untyped input (JSON) is cleaned with String(x ?? "")
      "typescript/no-base-to-string": "off",
      "typescript/restrict-template-expressions": "off",
    },
  },
  staged: { "*": "vp check --fix" },
  test: {
    root: new URL(".", import.meta.url).pathname,
    include: ["tests/*.test.ts"],
  },
  pack: {
    entry: { electron: "shell/electron/main.ts" },
    outDir: "dist/app",
    format: "esm",
    platform: "node",
    target: "node24",
    clean: true,
    dts: false,
    // dependencies bundled in: the package needs no node_modules (Electron itself is the runtime)
    deps: { alwaysBundle: [/.*/], neverBundle: ["electron"], onlyBundle: false },
  },
});
