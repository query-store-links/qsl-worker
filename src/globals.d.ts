// Vite-`define` injected constants. Source of truth: `package.json` versions,
// inlined by vite.config.ts so the worker and the SPA share one value.
declare const __APP_VERSION__: string;
declare const __STORELIB_VERSION__: string;
/** Short git commit SHA of the build, or "" when built outside a git checkout. */
declare const __APP_COMMIT__: string;
