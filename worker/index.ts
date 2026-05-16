// Cloudflare Worker — proxies Microsoft Store calls via storelib_rs (WASM).
// Mirrors the qsl_rs `/api/links/resolve-all` API so the existing client works.

// Use the `web/` flavour of the installed `@query-store-links/storelib_rs`
// package directly. The package's `exports` field only exposes the root
// (which resolves to `bundler/` and auto-runs `__wbindgen_start` on import —
// that's fine for production builds but breaks Vite's dev-server SSR runner
// because the wasm namespace isn't populated yet). The `web/` flavour leaves
// initialisation explicit, so we hand the `WebAssembly.Module` produced by
// the Cloudflare Vite plugin's `.wasm` import to `initSync` at cold-start.
//
// Deep import paths are aliased in `vite.config.ts` + `tsconfig.worker.json`.
//
// The package ships a `.wasm.d.ts` that describes the wasm's named exports
// (memory, raw function pointers, …) — what you'd get from
// `WebAssembly.instantiate`. The Cloudflare Vite plugin instead returns a
// `WebAssembly.Module` for the default import. Suppress the resulting "no
// default export" error at the single import site.
// @ts-expect-error: cloudflare-vite-plugin yields WebAssembly.Module for *.wasm
import wasmModule from "@query-store-links/storelib_rs/web/storelib_rs_bg.wasm";
import {
  DisplayCatalogHandler,
  Locale,
  initSync,
  parseIdentifierType,
  parseLanguage,
  parseLanguageTag,
  parseMarket,
} from "@query-store-links/storelib_rs/web/storelib_rs.js";
import type {
  IdentifierTypeStr,
  PackageInstance,
  ProgressEvent,
  StorelibError,
} from "@query-store-links/storelib_rs/web/storelib_rs.js";
import type {
  AppInfo,
  DownloadItem,
  IdentifierType,
  ResolveAllRequest,
  ResolveAllResponse,
} from "../src/shared";

initSync({ module: wasmModule });

// ── helpers ─────────────────────────────────────────────────────────────

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

// storelib_rs 0.1.7-fix-1 returns `packageSize` as `bigint` when the value
// exceeds Number.MAX_SAFE_INTEGER (some DCat manifests carry full u64 sizes).
// Convert to Number for the log-based bucketing — precision loss at that
// scale is irrelevant since we only render one decimal place anyway.
function bytesToString(n: number | bigint | null | undefined): string {
  if (n == null) return "Unknown";
  const num = typeof n === "bigint" ? Number(n) : n;
  if (!Number.isFinite(num) || num <= 0) return "Unknown";
  const suffixes = ["B", "KB", "MB", "GB", "TB", "PB", "EB"] as const;
  const place = Math.min(Math.floor(Math.log(num) / Math.log(1024)), suffixes.length - 1);
  const rounded = Math.round((num / 1024 ** place) * 10) / 10;
  return `${rounded}${suffixes[place]}`;
}

function errKind(e: unknown): StorelibError["kind"] | "unknown" {
  if (e && typeof e === "object" && "kind" in e) {
    const k = (e as { kind?: unknown }).kind;
    if (typeof k === "string") return k as StorelibError["kind"];
  }
  return "unknown";
}

// ── locale resolution ───────────────────────────────────────────────────
// storelib_rs 0.1.7 adds `Locale.fromTag(bcp47, includeNeutral)` which
// accepts BCP-47 tags directly (incl. `en-GB`, `zh-Hant-TW`). We resolve
// the request fields in priority order:
//
//   1. `Locale` or `LanguageTag`  — full BCP-47 tag → Locale.fromTag()
//   2. `Language` + `Market`       — bare ISO 639-1 + region → composed tag
//   3. neither                     — defaults to en-US
//
// All parser failures are surfaced as `Warnings` so the UI can show them.

export interface ResolvedLocale {
  market: string; // canonical ISO 3166-1, e.g. "US"
  language: string; // canonical ISO 639-1, e.g. "en"
  tag: string; // canonical BCP-47, e.g. "en-US"
  warnings: string[];
}

function resolveLocale(req: ResolveAllRequest): ResolvedLocale {
  const warnings: string[] = [];

  const rawMarket = (req.Market ?? "US").trim() || "US";
  let market = rawMarket.toUpperCase().slice(0, 2) || "US";
  try {
    market = parseMarket(rawMarket).code;
  } catch (e) {
    warnings.push(`Unknown market "${rawMarket}", defaulting to "${market}". (${String(e)})`);
  }

  const tagSource = req.Locale?.trim() || req.LanguageTag?.trim();
  if (tagSource) {
    try {
      const tag = parseLanguageTag(tagSource).code;
      return { market, language: tag.split("-")[0].toLowerCase(), tag, warnings };
    } catch (e) {
      warnings.push(`Unknown language tag "${tagSource}". (${String(e)})`);
    }
  }

  const langInput = req.Language?.trim();
  if (langInput) {
    let language = langInput.split("-")[0].toLowerCase() || "en";
    try {
      language = parseLanguage(langInput).code;
    } catch (e) {
      warnings.push(`Unknown language "${langInput}". (${String(e)})`);
    }
    const composed = `${language}-${market}`;
    try {
      const tag = parseLanguageTag(composed).code;
      return { market, language, tag, warnings };
    } catch {
      // Composed tag isn't on the MS Store list — fall through using the
      // bare language code; Locale.fromTag will reject if truly bad.
      return { market, language, tag: composed, warnings };
    }
  }

  return { market, language: "en", tag: "en-US", warnings };
}

function buildLocale(resolved: ResolvedLocale): { locale: Locale; warnings: string[] } {
  const warnings = [...resolved.warnings];
  try {
    return { locale: Locale.fromTag(resolved.tag, true), warnings };
  } catch (e) {
    warnings.push(
      `Locale.fromTag("${resolved.tag}") failed: ${String(e)} — falling back to en-US.`,
    );
    return { locale: Locale.fromTag("en-US", true), warnings };
  }
}

function resolveIdType(t: IdentifierType | undefined): IdentifierTypeStr {
  try {
    return parseIdentifierType(t ?? "ProductId");
  } catch {
    return "productId";
  }
}

// ── non-AppX (winget) path — mirrors qsl_rs handle_non_appx ──────────────

interface PackageManifestResponse {
  Data?: {
    PackageIdentifier: string;
    Versions: Array<{
      DefaultLocale?: {
        PackageName?: string;
        Publisher?: string;
        ShortDescription?: string;
        Agreements?: Array<{ AgreementLabel?: string; Agreement?: string }>;
      };
      Installers: Array<{
        InstallerUrl: string;
        Architecture: string;
        InstallerType: string;
      }>;
    }>;
  };
}

async function handleNonAppx(
  productId: string,
  locale: string,
  market: string,
): Promise<ResolveAllResponse> {
  const url =
    `http://storeedgefd.dsx.mp.microsoft.com/v9.0/packageManifests/${productId.toLowerCase()}` +
    `?locale=${locale.toLowerCase()}&market=${market.toUpperCase()}`;
  let manifest: PackageManifestResponse;
  try {
    const r = await fetch(url);
    if (!r.ok) return { Errors: ["Non-Appx product not found."] };
    manifest = await r.json();
  } catch {
    return { Errors: ["Non-Appx product not found."] };
  }
  const data = manifest.Data;
  if (!data) return { Errors: ["Non-Appx product not found."] };
  const version = data.Versions[0];
  if (!version) return { Errors: ["Non-Appx product not found."] };

  const loc = version.DefaultLocale;
  const appName = loc?.PackageName ?? "Unknown";
  const appInfo: AppInfo = {
    Name: appName,
    Publisher: loc?.Publisher ?? "Unknown",
    Description: loc?.ShortDescription ?? "",
    CategoryId: loc?.Agreements?.find((a) => a.AgreementLabel === "Category")?.Agreement ?? null,
    ProductId: data.PackageIdentifier,
  };

  const downloads: DownloadItem[] = version.Installers.map((i) => ({
    FileName: `${appName}_${i.Architecture}.${i.InstallerType}`,
    FileLink: i.InstallerUrl,
    FileSize: "Unknown",
  }));

  return {
    ProductId: productId.toUpperCase(),
    AppInfo: appInfo,
    NonAppxPackages: downloads,
  };
}

// ── AppX (DisplayCatalog) path ───────────────────────────────────────────

async function handleAppx(
  productInput: string,
  req: ResolveAllRequest,
  resolved: ResolvedLocale,
  signal: AbortSignal | null,
  onProgress: ((e: ProgressEvent) => void) | null = null,
): Promise<ResolveAllResponse> {
  const idType = resolveIdType(req.IdentifierType);
  const built = buildLocale(resolved);
  const warnings = built.warnings;
  const debug = {
    market: resolved.market,
    language: resolved.language,
    tag: resolved.tag,
    idType,
    productInput,
  };

  const handler = new DisplayCatalogHandler("production", built.locale);
  if (onProgress) handler.onProgress(onProgress);
  try {
    try {
      await handler.queryDcat(productInput, idType, null, signal);
    } catch (e) {
      return {
        Errors: [`Product lookup failed: ${String(e)}`],
        Warnings: warnings.length ? warnings : undefined,
        Debug: { ...debug, kind: errKind(e), handlerError: handler.error ?? null },
      };
    }

    if (!handler.isFound) {
      return {
        Errors: ["Product not found."],
        Warnings: warnings.length ? warnings : undefined,
        Debug: { ...debug, isFound: false, handlerError: handler.error ?? null },
      };
    }

    const productId = handler.id ?? productInput;
    const appInfo: AppInfo = {
      Name: handler.title ?? "Unknown Name",
      Publisher: handler.publisherName ?? "Unknown Publisher",
      Description: handler.description ?? "",
      CategoryId: handler.wuCategoryId ?? null,
      ProductId: productId,
    };

    let packages: PackageInstance[];
    try {
      packages = await handler.getPackagesForProduct(null, signal);
    } catch (e) {
      return {
        ProductId: productId,
        AppInfo: appInfo,
        Errors: [`Failed to fetch packages: ${String(e)}`],
        Warnings: warnings.length ? warnings : undefined,
        Debug: { ...debug, kind: errKind(e) },
      };
    }

    // PackageInstance carries packageSize (FE3-reported bytes) and a
    // pre-formatted readableFileName — no HEAD requests needed any more.
    const items: DownloadItem[] = packages.map((pkg) => ({
      FileName: pkg.readableFileName || pkg.packageMoniker || "Unknown",
      FileLink: pkg.packageUri ?? "",
      FileSize: bytesToString(pkg.packageSize),
    }));

    return {
      ProductId: productId,
      AppInfo: appInfo,
      AppxPackages: items,
      Warnings: warnings.length ? warnings : undefined,
      Debug: debug,
    };
  } finally {
    handler.free();
    built.locale.free();
  }
}

// ── HTTP entry ──────────────────────────────────────────────────────────

async function resolveAll(req: Request): Promise<Response> {
  if (req.method !== "POST") {
    return json({ Errors: ["Method not allowed. POST a JSON body."] }, 405);
  }
  let body: ResolveAllRequest;
  try {
    body = (await req.json()) as ResolveAllRequest;
  } catch (e) {
    return json({ Errors: [`Could not parse request body as JSON: ${String(e)}`] }, 400);
  }
  const productInput = body.ProductInput?.trim();
  if (!productInput) return json({ Errors: ["ProductInput is required."] }, 400);

  // Streaming: when the client sends `Accept: application/x-ndjson` we
  // emit one JSON event per line — progress events as storelib_rs reaches
  // each stage, then a final `result` (or `error`) event. Otherwise we
  // return the legacy single-JSON response so curl/integration callers
  // don't need to change.
  const wantsStream = (req.headers.get("accept") ?? "").includes("application/x-ndjson");
  return wantsStream ? streamResolveAll(productInput, body) : oneShotResolveAll(productInput, body);
}

async function oneShotResolveAll(productInput: string, body: ResolveAllRequest): Promise<Response> {
  const resolved = resolveLocale(body);
  try {
    const result = productInput.toLowerCase().startsWith("xp")
      ? await handleNonAppx(productInput, resolved.tag, resolved.market)
      : await handleAppx(productInput, body, resolved, null);
    return json(result);
  } catch (e) {
    console.error("resolveAll uncaught:", e);
    return json(
      {
        Errors: [`Internal error: ${String(e)}`],
        Debug: { ...resolved, productInput, kind: errKind(e) },
      },
      500,
    );
  }
}

function streamResolveAll(productInput: string, body: ResolveAllRequest): Response {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const encoder = new TextEncoder();
  const writer = writable.getWriter();
  // Coalesce writes serially so we don't interleave half-written lines if
  // onProgress fires from a sync wasm callback while the previous write is
  // still in flight.
  let queue: Promise<unknown> = Promise.resolve();
  const send = (obj: unknown): Promise<unknown> => {
    queue = queue.then(() =>
      writer.write(encoder.encode(JSON.stringify(obj) + "\n")).catch(() => {}),
    );
    return queue;
  };

  (async () => {
    const resolved = resolveLocale(body);
    await send({ type: "start", productInput, ...resolved });
    if (resolved.warnings.length) {
      await send({ type: "warnings", warnings: resolved.warnings });
    }
    try {
      const result = productInput.toLowerCase().startsWith("xp")
        ? await handleNonAppx(productInput, resolved.tag, resolved.market)
        : await handleAppx(productInput, body, resolved, null, (e) => {
            // Fire-and-forget: storelib's onProgress is sync; backpressure
            // doesn't matter for these tiny events.
            void send({
              type: "progress",
              stage: e.stage,
              message: e.message,
              current: e.current,
              total: e.total,
            });
          });
      await send({ type: "result", ...result });
    } catch (e) {
      console.error("streamResolveAll uncaught:", e);
      await send({
        type: "result",
        Errors: [`Internal error: ${String(e)}`],
        Debug: { ...resolved, productInput, kind: errKind(e) },
      });
    } finally {
      await queue;
      await writer.close().catch(() => {});
    }
  })();

  return new Response(readable, {
    status: 200,
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      // Streaming responses behind reverse proxies often need this so the
      // proxy doesn't buffer the whole body before forwarding.
      "x-content-type-options": "nosniff",
      "cache-control": "no-cache, no-transform",
    },
  });
}

const CORS_HEADERS: HeadersInit = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type",
};

// Real SPA entry routes — anything else that returns the SPA shell is the
// asset binding's not-found fallback, and should be re-emitted as HTTP 404.
const SPA_ROUTES = new Set<string>(["/", "/index.html"]);

async function serveAsset(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const assetRes = await env.ASSETS.fetch(request);

  // Asset binding returned the SPA fallback (index.html with 200) for a path
  // that isn't a known SPA route — wrap it as a proper 404 so browsers,
  // crawlers, and link checkers see the correct status. The body is still
  // the SPA shell, so React renders the NotFoundPage on hydrate.
  const isHtmlFallback =
    assetRes.status === 200 &&
    (assetRes.headers.get("content-type") ?? "").startsWith("text/html") &&
    !SPA_ROUTES.has(url.pathname) &&
    !url.pathname.startsWith("/assets/");

  if (!isHtmlFallback) return assetRes;

  const headers = new Headers(assetRes.headers);
  headers.set("x-not-found", "1");
  return new Response(assetRes.body, { status: 404, statusText: "Not Found", headers });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });

    let response: Response;
    if (url.pathname === "/api/_debug/parse") {
      const tag = url.searchParams.get("tag") ?? "en-US";
      const code = url.searchParams.get("lang") ?? "en";
      const m = url.searchParams.get("market") ?? "US";
      let parsedTag: unknown = null,
        parsedLang: unknown = null,
        parsedMarket: unknown = null,
        err: unknown = null;
      try {
        parsedTag = parseLanguageTag(tag);
      } catch (e) {
        err = String(e);
      }
      try {
        parsedLang = parseLanguage(code);
      } catch (e) {
        err = String(e);
      }
      try {
        parsedMarket = parseMarket(m);
      } catch (e) {
        err = String(e);
      }
      response = json({ parsedTag, parsedLang, parsedMarket, err });
    } else if (url.pathname === "/api/links/resolve-all") {
      response = await resolveAll(request);
    } else if (url.pathname.startsWith("/api/")) {
      response = json({ Errors: [`No such API route: ${url.pathname}`], Code: 404 }, 404);
    } else {
      // Asset responses are same-origin and have immutable headers — return
      // them directly without applying CORS.
      return await serveAsset(request, env);
    }
    for (const [k, v] of Object.entries(CORS_HEADERS)) response.headers.set(k, v);
    return response;
  },
} satisfies ExportedHandler<Env>;
