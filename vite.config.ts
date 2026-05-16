import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

import { cloudflare } from "@cloudflare/vite-plugin";

// Pull the deployment version straight from package.json so the worker's
// `/api/_meta` and the UI's diagnostics report a single source of truth.
// Inlined via `define` because both the worker bundle and the SPA need it,
// and a static string avoids a JSON import that would also need a tsconfig
// flag flip for the worker target.
const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL("./package.json", import.meta.url)), "utf8"),
) as { version: string };
// Storelib version — what the worker is *actually* running. Pull from the
// installed package.json (the resolved runtime version, not whatever range we
// declared as a dependency).
const storelibPkg = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL("./node_modules/@query-store-links/storelib_rs/package.json", import.meta.url),
    ),
    "utf8",
  ),
) as { version: string };

// The published `@query-store-links/storelib_rs` package's `exports` field
// only exposes the root entry, and the root resolves to the `bundler/` flavour
// — which the Cloudflare Vite plugin can ship in a production build but
// can't run through the dev-server's SSR runner (the auto-`__wbindgen_start`
// fires before the wasm namespace is populated). Alias the deep paths to
// node_modules so the worker can use the `web/` flavour directly and call
// `initSync({ module })` itself.
const webJs = fileURLToPath(
  new URL("./node_modules/@query-store-links/storelib_rs/web/storelib_rs.js", import.meta.url),
);
const webWasm = fileURLToPath(
  new URL("./node_modules/@query-store-links/storelib_rs/web/storelib_rs_bg.wasm", import.meta.url),
);

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), cloudflare()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __STORELIB_VERSION__: JSON.stringify(storelibPkg.version),
  },
  resolve: {
    alias: {
      "@query-store-links/storelib_rs/web/storelib_rs.js": webJs,
      "@query-store-links/storelib_rs/web/storelib_rs_bg.wasm": webWasm,
    },
  },
});
