import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

import { cloudflare } from "@cloudflare/vite-plugin";

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
  resolve: {
    alias: {
      "@query-store-links/storelib_rs/web/storelib_rs.js": webJs,
      "@query-store-links/storelib_rs/web/storelib_rs_bg.wasm": webWasm,
    },
  },
});
