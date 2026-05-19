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
  Fe3Handler,
  Locale,
  initSync,
  parseIdentifierType,
  parseLanguage,
  parseLanguageTag,
  parseMarket,
} from "@query-store-links/storelib_rs/web/storelib_rs.js";
import type {
  IdentifierType,
  PackageInstance,
  ProgressEvent,
  StorelibError,
} from "@query-store-links/storelib_rs/web/storelib_rs.js";
import {
  detectIdentifierType,
  renderApiCode,
  type ApiCode,
  type AppInfo,
  type DownloadItem,
  type ResolveAllRequest,
  type ResolveAllResponse,
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

// storelib_rs 0.1.8 attaches a `causes: string[]` source-chain to its thrown
// errors. Surface it in the diagnostic payload so the UI's debug panel can
// show the underlying reqwest / DNS / TLS failure instead of just the wasm
// wrapper's generic top-level message.
function errCauses(e: unknown): string[] | undefined {
  if (e && typeof e === "object" && "causes" in e) {
    const c = (e as { causes?: unknown }).causes;
    if (Array.isArray(c)) return c.filter((s): s is string => typeof s === "string");
  }
  return undefined;
}

/** Parse the message string from a `fe3.linkReceived` progress event back
 *  into structured fields. storelib 0.1.8 emits one such event per package
 *  the instant its FE3 download URL is parsed — earlier than the final
 *  `getPackagesForProduct` resolve completes, which is what lets us stream
 *  rows into the UI as they arrive.
 *
 *  Wire format (defined in storelib_rs's display_catalog.rs):
 *    "<moniker> | uri=<url> | size=<bytes-or-?> | updateId=<id>"
 *  The first `" | uri="` is unambiguous (monikers don't contain that token),
 *  and `size`/`updateId` are anchored to the tail so a URL containing
 *  embedded `|`s wouldn't break the parser. */
function parseLinkReceived(
  message: string,
): { moniker: string; uri: string; size: number | null; updateId: string } | null {
  const uriMark = " | uri=";
  const uriIdx = message.indexOf(uriMark);
  if (uriIdx < 0) return null;
  const moniker = message.slice(0, uriIdx);
  const after = message.slice(uriIdx + uriMark.length);

  const updateIdMark = " | updateId=";
  const updateIdIdx = after.lastIndexOf(updateIdMark);
  if (updateIdIdx < 0) return null;
  const updateId = after.slice(updateIdIdx + updateIdMark.length);
  const uriAndSize = after.slice(0, updateIdIdx);

  const sizeMark = " | size=";
  const sizeIdx = uriAndSize.lastIndexOf(sizeMark);
  if (sizeIdx < 0) return null;
  const uri = uriAndSize.slice(0, sizeIdx);
  const sizeStr = uriAndSize.slice(sizeIdx + sizeMark.length);
  const sizeNum = sizeStr === "?" ? null : Number(sizeStr);
  return {
    moniker,
    uri,
    size: Number.isFinite(sizeNum as number) ? sizeNum : null,
    updateId,
  };
}

function code(c: string, params?: Record<string, string | number>): ApiCode {
  return params ? { code: c, params } : { code: c };
}

// Mirror coded errors/warnings into the legacy `Errors`/`Warnings` string
// arrays so non-localizing API consumers (curl, scripts, older frontends)
// keep working unchanged. New consumers read the structured `*Codes` form.
function asErrors(codes: ApiCode[]): { Errors: string[]; ErrorCodes: ApiCode[] } {
  return { Errors: codes.map((c) => renderApiCode(c)), ErrorCodes: codes };
}

function asWarnings(codes: ApiCode[] | undefined): {
  Warnings?: string[];
  WarningCodes?: ApiCode[];
} {
  if (!codes || codes.length === 0) return {};
  return { Warnings: codes.map((c) => renderApiCode(c)), WarningCodes: codes };
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
  warnings: ApiCode[];
}

function resolveLocale(req: ResolveAllRequest): ResolvedLocale {
  const warnings: ApiCode[] = [];

  const rawMarket = (req.Market ?? "US").trim() || "US";
  let market = rawMarket.toUpperCase().slice(0, 2) || "US";
  try {
    market = parseMarket(rawMarket).code;
  } catch (e) {
    warnings.push(
      code("locale.unknownMarket", { raw: rawMarket, fallback: market, detail: String(e) }),
    );
  }

  const tagSource = req.Locale?.trim() || req.LanguageTag?.trim();
  if (tagSource) {
    try {
      const tag = parseLanguageTag(tagSource).code;
      return { market, language: tag.split("-")[0].toLowerCase(), tag, warnings };
    } catch (e) {
      warnings.push(code("locale.unknownLanguageTag", { raw: tagSource, detail: String(e) }));
    }
  }

  const langInput = req.Language?.trim();
  if (langInput) {
    let language = langInput.split("-")[0].toLowerCase() || "en";
    try {
      language = parseLanguage(langInput).code;
    } catch (e) {
      warnings.push(code("locale.unknownLanguage", { raw: langInput, detail: String(e) }));
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

function buildLocale(resolved: ResolvedLocale): { locale: Locale; warnings: ApiCode[] } {
  const warnings = [...resolved.warnings];
  try {
    return { locale: Locale.fromTag(resolved.tag, true), warnings };
  } catch (e) {
    warnings.push(code("locale.tagFailed", { tag: resolved.tag, detail: String(e) }));
    return { locale: Locale.fromTag("en-US", true), warnings };
  }
}

function resolveIdType(t: string | undefined): IdentifierType {
  try {
    return parseIdentifierType(t ?? "ProductId");
  } catch {
    return "productId";
  }
}

// `WuCategoryId` is an FE3-side identifier — DCat doesn't accept it as a
// lookup key, so `parseIdentifierType` rejects it. We detect it ahead of the
// storelib parser and dispatch to the FE3-only handler.
function isWuCategoryIdType(t: string | undefined): boolean {
  if (!t) return false;
  return t.replace(/[^a-z0-9]/gi, "").toLowerCase() === "wucategoryid";
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
  const notFound = (): ResolveAllResponse => asErrors([code("nonAppx.notFound")]);
  let manifest: PackageManifestResponse;
  try {
    const r = await fetch(url);
    if (!r.ok) return notFound();
    manifest = await r.json();
  } catch {
    return notFound();
  }
  const data = manifest.Data;
  if (!data) return notFound();
  const version = data.Versions[0];
  if (!version) return notFound();

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

// ── WuCategoryId path — FE3 only, no DisplayCatalog ─────────────────────
//
// DCat doesn't accept WuCategoryId as a lookup key, so this path skips it
// entirely and drives FE3 directly. Product metadata (title, publisher,
// description) isn't available, so AppInfo carries placeholder strings and
// the WuCategoryId is echoed as both CategoryId and ProductId. SHA-256 is
// not surfaced either — FE3's `<File Digest>` is SHA-1 in practice.

async function handleWuCategoryId(
  wuCategoryId: string,
  resolved: ResolvedLocale,
  signal: AbortSignal | null,
  onProgress: ((e: ProgressEvent) => void) | null = null,
): Promise<ResolveAllResponse> {
  const warnings: ApiCode[] = [...resolved.warnings];
  const debug = {
    market: resolved.market,
    language: resolved.language,
    tag: resolved.tag,
    idType: "wuCategoryId",
    productInput: wuCategoryId,
  };

  // `DisplayCatalogHandler` emits progress events through wasm; this path
  // skips it entirely, so synthesize the same `fe3.*` stages by hand. The
  // stream consumer in `streamResolveAll` parses `fe3.packageResolved` to
  // push live package rows — the wire format must match `parseLinkReceived`.
  const emit = (
    stage: ProgressEvent["stage"],
    message: string,
    current: number | null = null,
    total: number | null = null,
  ): void => {
    onProgress?.({ stage, message, current, total });
  };
  const sizeForMessage = (n: number | bigint | null | undefined): string => {
    if (n == null) return "?";
    const num = typeof n === "bigint" ? n.toString() : String(n);
    return num;
  };

  const checkAborted = (): boolean => signal?.aborted === true;
  const fe3 = new Fe3Handler();
  try {
    emit("fe3.start", `WuCategoryId=${wuCategoryId}`);
    emit("fe3.syncUpdates", `wuCategoryId=${wuCategoryId}`);
    let xml: string;
    try {
      xml = await fe3.syncUpdates(wuCategoryId, null);
    } catch (e) {
      return {
        ...asErrors([code("packages.fetchFailed", { detail: String(e) })]),
        ...asWarnings(warnings),
        Debug: { ...debug, kind: errKind(e), causes: errCauses(e) },
      };
    }
    if (checkAborted()) {
      return {
        ...asErrors([code("packages.fetchFailed", { detail: "aborted" })]),
        ...asWarnings(warnings),
        Debug: { ...debug, kind: "cancelled" },
      };
    }

    let ids: { updateIds: string[]; revisionIds: string[] };
    let instances: PackageInstance[];
    try {
      emit("fe3.parseUpdateIds", `${xml.length} bytes XML`);
      ids = Fe3Handler.processUpdateIds(xml) as {
        updateIds: string[];
        revisionIds: string[];
      };
      emit(
        "fe3.parseUpdateIds.done",
        "update IDs parsed",
        ids.updateIds.length,
        ids.updateIds.length,
      );
      emit("fe3.parsePackages", "parsing package instances");
      instances = (await Fe3Handler.getPackageInstances(xml)) as PackageInstance[];
      emit(
        "fe3.parsePackages.done",
        "package instances parsed",
        instances.length,
        instances.length,
      );
    } catch (e) {
      return {
        ...asErrors([code("packages.fetchFailed", { detail: String(e) })]),
        ...asWarnings(warnings),
        Debug: { ...debug, kind: errKind(e), causes: errCauses(e) },
      };
    }

    if (instances.length === 0) {
      return {
        ...asErrors([code("product.notFound")]),
        ...asWarnings(warnings),
        Debug: { ...debug, isFound: false, syncUpdatesBytes: xml.length },
      };
    }

    // Fan-out one `fe3.packageFound` per discovered package — same shape the
    // wasm side emits after `SyncUpdates` parse completes.
    const totalPkgs = instances.length;
    for (let i = 0; i < totalPkgs; i++) {
      const inst = instances[i];
      const uid = ids.updateIds[i] ?? "";
      emit("fe3.packageFound", `${inst.packageMoniker} | updateId=${uid}`, i + 1, totalPkgs);
    }

    emit("fe3.resolveUrls", `resolving ${ids.updateIds.length} URLs`);
    // storelib 0.1.10 exposes `Fe3Handler.onProgress`, which fires
    // `fe3.linkReceived` per URL as each `GetExtendedUpdateInfo2` response
    // is parsed. The wasm message format is
    //   `"uri=<url> | size=<bytes-or-?> | updateId=<id>"`
    // — no moniker prefix. The streaming consumer (`parseLinkReceived` in
    // this file) requires `"<moniker> | uri=<url> | size=… | updateId=…"`,
    // so we intercept the wasm event, look up the owning moniker by
    // updateId, and re-emit with the moniker prepended.
    const monikerByUpdateId = new Map<string, string>();
    for (let i = 0; i < instances.length; i++) {
      const uid = ids.updateIds[i];
      if (uid) monikerByUpdateId.set(uid, instances[i].packageMoniker);
    }
    fe3.onProgress((e) => {
      if (e.stage !== "fe3.linkReceived") {
        onProgress?.(e);
        return;
      }
      // Parse `uri=<url> | size=<...> | updateId=<id>`. Anchor on the tail
      // tokens so a URL containing `|` doesn't break the split.
      const updateIdMark = " | updateId=";
      const sizeMark = " | size=";
      const uriMark = "uri=";
      const updateIdIdx = e.message.lastIndexOf(updateIdMark);
      const sizeIdx = e.message.lastIndexOf(sizeMark);
      const uriIdx = e.message.indexOf(uriMark);
      if (updateIdIdx < 0 || sizeIdx < 0 || uriIdx !== 0) {
        onProgress?.(e);
        return;
      }
      const updateId = e.message.slice(updateIdIdx + updateIdMark.length);
      const sizeStr = e.message.slice(sizeIdx + sizeMark.length, updateIdIdx);
      const uri = e.message.slice(uriMark.length, sizeIdx);
      const moniker = monikerByUpdateId.get(updateId) ?? "<unknown>";
      onProgress?.({
        stage: "fe3.linkReceived",
        message: `${moniker} | uri=${uri} | size=${sizeStr} | updateId=${updateId}`,
        current: e.current,
        total: e.total,
      });
    });

    let urls: Array<{ url: string; size: number | bigint | null }>;
    try {
      urls = (await fe3.getFileUrls(ids.updateIds, ids.revisionIds, null)) as Array<{
        url: string;
        size: number | bigint | null;
      }>;
    } catch (e) {
      return {
        ...asErrors([code("packages.fetchFailed", { detail: String(e) })]),
        ...asWarnings(warnings),
        Debug: { ...debug, kind: errKind(e), causes: errCauses(e) },
      };
    }
    emit("fe3.resolveUrls.done", "URLs resolved", urls.length, ids.updateIds.length);

    // FE3 returns parallel arrays — index i in `instances` corresponds to
    // index i in `urls` / `ids.updateIds`. `getPackageInstances` leaves
    // `packageUri` null because the URL resolution is a separate SOAP call,
    // so merge it back in here. After each merge, emit `fe3.packageResolved`
    // so the streaming consumer can push the row immediately.
    const items: DownloadItem[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < instances.length; i++) {
      const pkg = instances[i];
      const resolvedUrl = urls[i] ?? null;
      const uri = resolvedUrl?.url ?? pkg.packageUri ?? "";
      const size = resolvedUrl?.size ?? pkg.packageSize ?? null;
      const updateId = ids.updateIds[i] ?? "";
      emit(
        "fe3.packageResolved",
        `${pkg.packageMoniker} | uri=${uri || "<none>"} | size=${sizeForMessage(size)} | updateId=${updateId}`,
        i + 1,
        totalPkgs,
      );
      const key = uri || pkg.packageMoniker;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      items.push({
        FileName: pkg.readableFileName || pkg.packageMoniker || "Unknown",
        FileLink: uri,
        FileSize: bytesToString(size),
        Sha256: null,
      });
    }
    emit("fe3.done", `${items.length} package(s) resolved`);

    const appInfo: AppInfo = {
      Name: "Unknown Name",
      Publisher: "Unknown Publisher",
      Description: "",
      CategoryId: wuCategoryId,
      ProductId: wuCategoryId,
    };

    return {
      ProductId: wuCategoryId,
      AppInfo: appInfo,
      AppxPackages: items,
      ...asWarnings(warnings),
      Debug: {
        ...debug,
        fe3PackageCount: instances.length,
        fe3ResolvedUrlCount: urls.length,
      },
    };
  } finally {
    fe3.free();
  }
}

// ── AppX (DisplayCatalog) path ───────────────────────────────────────────

async function handleAppx(
  productInput: string,
  req: ResolveAllRequest,
  resolved: ResolvedLocale,
  signal: AbortSignal | null,
  onProgress: ((e: ProgressEvent) => void) | null = null,
): Promise<ResolveAllResponse> {
  if (isWuCategoryIdType(req.IdentifierType)) {
    return handleWuCategoryId(productInput, resolved, signal, onProgress);
  }
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
        ...asErrors([code("product.lookupFailed", { detail: String(e) })]),
        ...asWarnings(warnings),
        Debug: {
          ...debug,
          kind: errKind(e),
          causes: errCauses(e),
          handlerError: handler.error ?? null,
        },
      };
    }

    if (!handler.isFound) {
      return {
        ...asErrors([code("product.notFound")]),
        ...asWarnings(warnings),
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
        ...asErrors([code("packages.fetchFailed", { detail: String(e) })]),
        ...asWarnings(warnings),
        Debug: { ...debug, kind: errKind(e), causes: errCauses(e) },
      };
    }

    // SHA-256 lives on the DCat-side `Package` metadata (handler.packages),
    // keyed by `packageFullName`. The FE3 `packageMoniker` is the same
    // identity but uses `~` as the empty-ResourceID placeholder, so DCat's
    // `Name_Ver_Arch__PubHash` shows up as `Name_Ver_Arch_~_PubHash` here.
    // Normalise both sides to a common key. We also accept matches by
    // `packageId` (Package) ↔ `applicabilityBlob["content.packageId"]`
    // (PackageInstance) when the name-based join misses.
    const normalizeKey = (s: string): string => s.replace(/_~_/g, "__");
    const sha256ByName = new Map<string, string>();
    const sha256ByPackageId = new Map<string, string>();
    for (const p of handler.packages) {
      const hash = p.hash;
      const algo = p.hashAlgorithm;
      if (!hash) continue;
      if (algo && algo.toLowerCase() !== "sha256") continue;
      const lower = hash.toLowerCase();
      if (p.packageFullName) sha256ByName.set(normalizeKey(p.packageFullName), lower);
      if (p.packageId) sha256ByPackageId.set(p.packageId, lower);
    }
    const lookupSha = (pkg: PackageInstance): string | null => {
      const nameKey = normalizeKey(pkg.packageMoniker);
      const byName = sha256ByName.get(nameKey);
      if (byName) return byName;
      const pid = pkg.applicabilityBlob?.["content.packageId"];
      if (pid) {
        const byId = sha256ByPackageId.get(pid);
        if (byId) return byId;
      }
      return null;
    };

    // PackageInstance carries packageSize (FE3-reported bytes) and a
    // pre-formatted readableFileName — no HEAD requests needed any more.
    //
    // FE3's update graph can surface the same package under multiple update
    // IDs, so storelib may return multiple PackageInstances for one file.
    // Dedupe by packageUri (canonical pointer), falling back to packageMoniker
    // for framework packages where packageUri is null.
    const seen = new Set<string>();
    const items: DownloadItem[] = [];
    let hashMatched = 0;
    for (const pkg of packages) {
      const key = pkg.packageUri || pkg.packageMoniker;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const sha = lookupSha(pkg);
      if (sha) hashMatched++;
      items.push({
        FileName: pkg.readableFileName || pkg.packageMoniker || "Unknown",
        FileLink: pkg.packageUri ?? "",
        FileSize: bytesToString(pkg.packageSize),
        Sha256: sha,
      });
    }

    return {
      ProductId: productId,
      AppInfo: appInfo,
      AppxPackages: items,
      ...asWarnings(warnings),
      Debug: {
        ...debug,
        dcatPackageCount: handler.packages.length,
        dcatPackagesWithSha256: sha256ByName.size,
        itemsWithSha256: hashMatched,
      },
    };
  } finally {
    handler.free();
    built.locale.free();
  }
}

// ── HTTP entry ──────────────────────────────────────────────────────────

async function resolveAll(req: Request): Promise<Response> {
  if (req.method !== "POST") {
    return json(asErrors([code("method.notAllowed")]), 405);
  }
  let body: ResolveAllRequest;
  try {
    body = (await req.json()) as ResolveAllRequest;
  } catch (e) {
    return json(asErrors([code("request.invalidJson", { detail: String(e) })]), 400);
  }
  const productInput = body.ProductInput?.trim();
  if (!productInput) return json(asErrors([code("productInput.required")]), 400);

  // Streaming: when the client sends `Accept: application/x-ndjson` we
  // emit one JSON event per line — progress events as storelib_rs reaches
  // each stage, then a final `result` (or `error`) event. Otherwise we
  // return the legacy single-JSON response so curl/integration callers
  // don't need to change.
  const wantsStream = (req.headers.get("accept") ?? "").includes("application/x-ndjson");
  return wantsStream ? streamResolveAll(productInput, body) : oneShotResolveAll(productInput, body);
}

/** Dispatch a `ResolveAllRequest` through the right backend handler
 *  (non-appx vs. DCat vs. FE3-only WuCategoryId). Returns the same shape
 *  as the API but as a JS value, not a `Response`. Internal callers
 *  (download permalink, future endpoints) reuse this without re-paying
 *  the JSON-encode/decode round-trip. */
async function resolveProduct(
  productInput: string,
  body: ResolveAllRequest,
  signal: AbortSignal | null = null,
  onProgress: ((e: ProgressEvent) => void) | null = null,
): Promise<{ resolved: ResolvedLocale; result: ResolveAllResponse }> {
  const resolved = resolveLocale(body);
  const result = productInput.toLowerCase().startsWith("xp")
    ? await handleNonAppx(productInput, resolved.tag, resolved.market)
    : await handleAppx(productInput, body, resolved, signal, onProgress);
  return { resolved, result };
}

async function oneShotResolveAll(productInput: string, body: ResolveAllRequest): Promise<Response> {
  try {
    const { result } = await resolveProduct(productInput, body);
    return json(result);
  } catch (e) {
    console.error("resolveAll uncaught:", e);
    const resolved = resolveLocale(body);
    return json(
      {
        ...asErrors([code("internal.error", { detail: String(e) })]),
        Debug: { ...resolved, productInput, kind: errKind(e), causes: errCauses(e) },
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
  // still in flight. Each `write` is awaited individually — the next chunk
  // queues immediately, so the producer is never blocked and the consumer
  // sees lines the moment each one is flushed.
  let queue: Promise<unknown> = Promise.resolve();
  const send = (obj: unknown): Promise<unknown> => {
    queue = queue.then(() =>
      writer.write(encoder.encode(JSON.stringify(obj) + "\n")).catch(() => {}),
    );
    return queue;
  };

  // Per-stream dedup so a package isn't pushed twice when both
  // `fe3.linkReceived` and `fe3.packageResolved` fire for it (the latter is
  // emitted after the merge loop, with identical message shape).
  const seenMonikers = new Set<string>();

  (async () => {
    const resolved = resolveLocale(body);
    await send({ type: "start", productInput, ...resolved });
    if (resolved.warnings.length) {
      // Mirror both forms in the streaming event for parity with the final
      // result payload: legacy English strings + structured codes.
      await send({
        type: "warnings",
        warnings: resolved.warnings.map((c) => renderApiCode(c)),
        warningCodes: resolved.warnings,
      });
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
            // storelib 0.1.8 emits per-package events with structured
            // moniker/url/size data in the `message` field:
            //   • `fe3.linkReceived`    — fires the instant each FE3 SOAP
            //     response is parsed (true streaming, one at a time).
            //   • `fe3.packageResolved` — fires in a final merge loop after
            //     all URLs are in. Same message format. Acts as a fallback
            //     for builds where `linkReceived` doesn't surface to the JS
            //     callback; the row still appears before the `result` event.
            // Dedup by moniker so we only push each package once regardless
            // of which stage delivered it first.
            if (e.stage === "fe3.linkReceived" || e.stage === "fe3.packageResolved") {
              const parsed = parseLinkReceived(e.message);
              if (
                parsed &&
                parsed.uri &&
                parsed.uri !== "<none>" &&
                !seenMonikers.has(parsed.moniker)
              ) {
                seenMonikers.add(parsed.moniker);
                void send({
                  type: "package",
                  FileName: `${parsed.moniker}.appx`,
                  FileLink: parsed.uri,
                  FileSize: bytesToString(parsed.size ?? undefined),
                  Moniker: parsed.moniker,
                  UpdateId: parsed.updateId,
                });
              }
            }
          });
      await send({ type: "result", ...result });
    } catch (e) {
      console.error("streamResolveAll uncaught:", e);
      await send({
        type: "result",
        ...asErrors([code("internal.error", { detail: String(e) })]),
        Debug: { ...resolved, productInput, kind: errKind(e), causes: errCauses(e) },
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

// ── Download permalink — GET /d, /download, /installer/download ─────────
//
// Shareable redirect: a GET URL that resolves a Microsoft Store identifier
// through the same pipeline as `/api/links/resolve-all` and either redirects
// (default), proxies (`?proxy=true`), or returns JSON (`?format=json` or
// `Accept: application/json`) for the picked download.
//
// Selection algorithm
// --------------------
// 1. Drop framework packages (VCLibs, .NET Native, etc.) unless `include`
//    contains `framework`.
// 2. If `match=<regex>` is set, keep only filenames matching the regex
//    (case-insensitive).
// 3. If `arch=<a>` is set, keep only that architecture.
// 4. Sort by score: bundle (-bundle) → preferred arch (x64 > arm64 > x86 >
//    neutral) → larger size first (better match for the "real" package
//    over a tiny stub).
// 5. Pick `n` (default 0). If empty after filtering, 404.
//
// Identifier handling
// -------------------
// The id is taken from the path component, URI-decoded. If `type` is given
// in the query, it's used verbatim (any casing). Otherwise the
// shared-side `detectIdentifierType` heuristic runs; a miss falls back to
// `ProductId`. `WuCategoryId` is supported same as the POST API.

const FRAMEWORK_PREFIXES: readonly string[] = [
  "microsoft.vclibs",
  "microsoft.net.native",
  "microsoft.netcore",
  "microsoft.ui.xaml",
  "microsoft.services.store.engagement",
  "microsoft.windowsappruntime",
];

function isFrameworkFileName(name: string): boolean {
  const lower = name.toLowerCase();
  return FRAMEWORK_PREFIXES.some((p) => lower.startsWith(p));
}

function isBundleFileName(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower.endsWith(".appxbundle") ||
    lower.endsWith(".msixbundle") ||
    lower.endsWith(".eappxbundle") ||
    lower.endsWith(".emsixbundle")
  );
}

/** Files that aren't end-user installable: the AppxBlockMap.xml manifest
 *  and DRM-encrypted `.eappx*` / `.emsix*` variants. These tag along with
 *  every package response but should never be the default pick — callers
 *  who really want them can pass `?include=auxiliary`. */
function isAuxiliaryFileName(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower.endsWith(".blockmap") ||
    lower.endsWith(".eappx") ||
    lower.endsWith(".eappxbundle") ||
    lower.endsWith(".emsix") ||
    lower.endsWith(".emsixbundle")
  );
}

function archFromFileName(name: string): "x64" | "arm64" | "x86" | "neutral" | "unknown" {
  if (/_x64[._]/i.test(name)) return "x64";
  if (/_arm64[._]/i.test(name)) return "arm64";
  if (/_x86[._]/i.test(name)) return "x86";
  if (/_neutral[._]/i.test(name)) return "neutral";
  return "unknown";
}

function archRank(arch: ReturnType<typeof archFromFileName>): number {
  switch (arch) {
    case "x64":
      return 0;
    case "arm64":
      return 1;
    case "x86":
      return 2;
    case "neutral":
      return 3;
    default:
      return 4;
  }
}

interface DownloadQuery {
  type?: string;
  arch?: "x64" | "arm64" | "x86" | "neutral";
  market?: string;
  lang?: string;
  match?: RegExp;
  matchRaw?: string;
  include: { framework: boolean; auxiliary: boolean };
  n: number;
  proxy: boolean;
  format: "redirect" | "json" | "auto";
}

function parseDownloadQuery(
  url: URL,
): { ok: true; query: DownloadQuery } | { ok: false; error: ApiCode } {
  const sp = url.searchParams;
  const archRaw = sp.get("arch");
  let arch: DownloadQuery["arch"];
  if (archRaw) {
    const a = archRaw.toLowerCase();
    if (a === "x64" || a === "arm64" || a === "x86" || a === "neutral") arch = a;
    else return { ok: false, error: code("download.badArch", { raw: archRaw }) };
  }

  const includeRaw = (sp.get("include") ?? "").toLowerCase();
  const includeParts = new Set(includeRaw.split(/[,\s]+/).filter(Boolean));

  let match: RegExp | undefined;
  const matchRaw = sp.get("match") ?? undefined;
  if (matchRaw) {
    try {
      match = new RegExp(matchRaw, "i");
    } catch (e) {
      return { ok: false, error: code("download.badRegex", { raw: matchRaw, detail: String(e) }) };
    }
  }

  const nRaw = sp.get("n");
  const nParsed = nRaw == null ? 0 : Number(nRaw);
  if (nRaw != null && (!Number.isInteger(nParsed) || nParsed < 0)) {
    return { ok: false, error: code("download.badN", { raw: nRaw }) };
  }

  const formatRaw = (sp.get("format") ?? "auto").toLowerCase();
  let format: DownloadQuery["format"];
  if (formatRaw === "auto" || formatRaw === "redirect" || formatRaw === "json") format = formatRaw;
  else return { ok: false, error: code("download.badFormat", { raw: formatRaw }) };

  const proxyRaw = (sp.get("proxy") ?? "").toLowerCase();
  const proxy = proxyRaw === "1" || proxyRaw === "true" || proxyRaw === "yes";

  return {
    ok: true,
    query: {
      type: sp.get("type") ?? undefined,
      arch,
      market: sp.get("market") ?? undefined,
      lang: sp.get("lang") ?? sp.get("locale") ?? undefined,
      match,
      matchRaw,
      include: {
        framework:
          includeParts.has("framework") ||
          includeParts.has("frameworks") ||
          includeParts.has("all"),
        auxiliary:
          includeParts.has("auxiliary") ||
          includeParts.has("aux") ||
          includeParts.has("blockmap") ||
          includeParts.has("encrypted") ||
          includeParts.has("all"),
      },
      n: nParsed,
      proxy,
      format,
    },
  };
}

interface Candidate {
  item: DownloadItem;
  arch: ReturnType<typeof archFromFileName>;
  isBundle: boolean;
  isFramework: boolean;
  isAuxiliary: boolean;
  sizeBytes: number;
}

function buildCandidates(items: DownloadItem[]): Candidate[] {
  return items.map((item) => {
    const name = item.FileName ?? "";
    const sizeBytes = sizeStringToBytes(item.FileSize ?? "");
    return {
      item,
      arch: archFromFileName(name),
      isBundle: isBundleFileName(name),
      isFramework: isFrameworkFileName(name),
      isAuxiliary: isAuxiliaryFileName(name),
      sizeBytes,
    };
  });
}

function sizeStringToBytes(s: string): number {
  const m = s.trim().match(/^([\d.]+)\s*(B|KB|MB|GB|TB|PB)?/i);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  const u = (m[2] ?? "B").toUpperCase();
  const factor: Record<string, number> = {
    B: 1,
    KB: 1024,
    MB: 1024 ** 2,
    GB: 1024 ** 3,
    TB: 1024 ** 4,
    PB: 1024 ** 5,
  };
  return n * (factor[u] ?? 1);
}

function selectCandidates(all: Candidate[], q: DownloadQuery): Candidate[] {
  let pool = all.filter((c) => c.item.FileLink);
  if (!q.include.framework) pool = pool.filter((c) => !c.isFramework);
  if (!q.include.auxiliary) pool = pool.filter((c) => !c.isAuxiliary);
  if (q.match) pool = pool.filter((c) => q.match!.test(c.item.FileName ?? ""));
  if (q.arch) pool = pool.filter((c) => c.arch === q.arch);

  pool.sort((a, b) => {
    if (a.isBundle !== b.isBundle) return a.isBundle ? -1 : 1;
    const ra = archRank(a.arch);
    const rb = archRank(b.arch);
    if (ra !== rb) return ra - rb;
    return b.sizeBytes - a.sizeBytes;
  });

  return pool;
}

/** Build a `Content-Disposition` value with both the plain and RFC 5987
 *  encoded filename, so non-ASCII characters survive intermediate proxies. */
function contentDisposition(fileName: string): string {
  // Strip path separators and control chars for safety. The control-char
  // range is intentional — eslint flags it but that's exactly what we want.
  // eslint-disable-next-line no-control-regex
  const safe = fileName.replace(/[\\/\x00-\x1f]/g, "_");
  const ascii = safe.replace(/[^\x20-\x7e]/g, "_");
  const encoded = encodeURIComponent(safe);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

function wantsHtml(req: Request): boolean {
  return (req.headers.get("accept") ?? "").toLowerCase().includes("text/html");
}

function wantsJsonByHeader(req: Request): boolean {
  const a = (req.headers.get("accept") ?? "").toLowerCase();
  // Only honour an explicit JSON preference, not a wildcard.
  return a.includes("application/json") && !a.includes("text/html");
}

function downloadErrorResponse(
  req: Request,
  url: URL,
  status: number,
  errCode: ApiCode,
  query: DownloadQuery | null = null,
  extra: Record<string, unknown> | null = null,
): Response {
  const body = {
    ...asErrors([errCode]),
    Code: status,
    ...(extra ? { Debug: extra } : {}),
  };
  // HTML-preferring clients (browsers clicking a stale share link) get
  // bounced into the SPA with `?error=<code>&id=<id>` so the UI can render
  // a friendly failure rather than a JSON blob. JSON callers / curl
  // see the structured body.
  if (query?.format !== "json" && wantsHtml(req) && !wantsJsonByHeader(req)) {
    const spa = new URL("/", url);
    spa.searchParams.set("error", errCode.code);
    if (query?.matchRaw) spa.searchParams.set("match", query.matchRaw);
    const fwd = url.pathname.split("/").pop() ?? "";
    if (fwd) spa.searchParams.set("id", decodeURIComponent(fwd));
    const res = new Response(null, {
      status: 303,
      headers: { location: spa.toString(), "cache-control": "no-store" },
    });
    return res;
  }
  return json(body, status);
}

const DOWNLOAD_PATH_RE = /^\/(?:d|download|installer\/download)\/[^/?#]+\/?$/i;

/** True when `pathname` is a download-permalink URL shape. Used at the
 *  routing layer to gate the handler above the static-asset fallback so
 *  a typo'd id doesn't end up serving the SPA shell. */
function isDownloadPermalink(pathname: string): boolean {
  return DOWNLOAD_PATH_RE.test(pathname);
}

/** Parse the id out of the request path. Supports `/d/<id>`,
 *  `/download/<id>`, `/installer/download/<id>`. Returns `null` when the
 *  path doesn't match. The id is URI-decoded. */
function parseDownloadPath(pathname: string): string | null {
  const m = pathname.match(/^\/(?:d|download|installer\/download)\/(.+?)\/?$/i);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1];
  }
}

async function handleDownload(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const id = parseDownloadPath(url.pathname);
  if (!id) {
    return json({ ...asErrors([code("route.notFound", { path: url.pathname })]), Code: 404 }, 404);
  }

  if (isApiDisabled(env)) {
    return json({ ...asErrors([code("apiDisabled")]), Code: 503 }, 503);
  }

  const parsed = parseDownloadQuery(url);
  if (!parsed.ok) {
    return downloadErrorResponse(request, url, 400, parsed.error);
  }
  const query = parsed.query;

  // Detect identifier type if the caller didn't pin one. Detection is a
  // best-effort shape match; ambiguous inputs default to ProductId, which
  // matches the SPA's own behaviour.
  const idType: string = query.type ?? detectIdentifierType(id) ?? "ProductId";

  const body: ResolveAllRequest = {
    ProductInput: id,
    IdentifierType: idType as ResolveAllRequest["IdentifierType"],
    Market: query.market,
    LanguageTag: query.lang,
  };

  let result: ResolveAllResponse;
  try {
    const ac = new AbortController();
    request.signal?.addEventListener("abort", () => ac.abort(), { once: true });
    const dispatched = await resolveProduct(id, body, ac.signal);
    result = dispatched.result;
  } catch (e) {
    console.error("download dispatch uncaught:", e);
    return downloadErrorResponse(
      request,
      url,
      500,
      code("internal.error", { detail: String(e) }),
      query,
      { kind: errKind(e), causes: errCauses(e) },
    );
  }

  if (result.ErrorCodes?.length) {
    const errCode = result.ErrorCodes[0];
    const status = errCode.code === "product.notFound" ? 404 : 502;
    return downloadErrorResponse(request, url, status, errCode, query, result.Debug ?? null);
  }

  const items = [...(result.AppxPackages ?? []), ...(result.NonAppxPackages ?? [])];
  if (items.length === 0) {
    return downloadErrorResponse(
      request,
      url,
      404,
      code("download.noLinks"),
      query,
      result.Debug ?? null,
    );
  }

  const candidates = selectCandidates(buildCandidates(items), query);
  if (candidates.length === 0) {
    return downloadErrorResponse(
      request,
      url,
      404,
      code("download.noMatch", {
        arch: query.arch ?? "",
        match: query.matchRaw ?? "",
      }),
      query,
      { totalItems: items.length, totalCandidates: candidates.length },
    );
  }

  if (query.n >= candidates.length) {
    return downloadErrorResponse(
      request,
      url,
      404,
      code("download.indexOutOfRange", { n: query.n, total: candidates.length }),
      query,
    );
  }

  const picked = candidates[query.n];

  // JSON mode: caller asked for the picked candidate as a JSON blob (so
  // they can render their own UI, integrate into a script, etc).
  const wantJson =
    query.format === "json" || (query.format === "auto" && wantsJsonByHeader(request));
  if (wantJson) {
    return json({
      Picked: {
        FileName: picked.item.FileName,
        FileLink: picked.item.FileLink,
        FileSize: picked.item.FileSize,
        Sha256: picked.item.Sha256,
        Arch: picked.arch,
        IsBundle: picked.isBundle,
        IsFramework: picked.isFramework,
        IsAuxiliary: picked.isAuxiliary,
      },
      Candidates: candidates.map((c, i) => ({
        Index: i,
        FileName: c.item.FileName,
        FileLink: c.item.FileLink,
        FileSize: c.item.FileSize,
        Sha256: c.item.Sha256,
        Arch: c.arch,
        IsBundle: c.isBundle,
        IsFramework: c.isFramework,
        IsAuxiliary: c.isAuxiliary,
      })),
      AppInfo: result.AppInfo ?? null,
      Query: {
        id,
        type: idType,
        market: query.market ?? null,
        lang: query.lang ?? null,
        arch: query.arch ?? null,
        match: query.matchRaw ?? null,
        include: query.include,
        n: query.n,
      },
    });
  }

  // Proxy mode: fetch the binary server-side and stream it back. Hides the
  // FE3 URL from the client and bypasses firewalls that block
  // `*.dl.delivery.mp.microsoft.com`. Cloudflare Workers will tee the body
  // through without buffering.
  if (query.proxy) {
    let upstream: Response;
    try {
      upstream = await fetch(picked.item.FileLink, { redirect: "follow" });
    } catch (e) {
      return downloadErrorResponse(
        request,
        url,
        502,
        code("download.proxyFailed", { detail: String(e) }),
        query,
      );
    }
    if (!upstream.ok) {
      return downloadErrorResponse(
        request,
        url,
        upstream.status === 404 ? 404 : 502,
        code("download.proxyUpstream", { status: upstream.status }),
        query,
      );
    }
    const headers = new Headers();
    const ct = upstream.headers.get("content-type");
    if (ct) headers.set("content-type", ct);
    const cl = upstream.headers.get("content-length");
    if (cl) headers.set("content-length", cl);
    const ar = upstream.headers.get("accept-ranges");
    if (ar) headers.set("accept-ranges", ar);
    headers.set("content-disposition", contentDisposition(picked.item.FileName ?? "package.appx"));
    headers.set("cache-control", "private, max-age=300");
    headers.set("x-qsl-source", "fe3-proxy");
    return new Response(upstream.body, { status: 200, headers });
  }

  // Default: 302 redirect to FE3's signed URL. The URL is time-limited
  // (FE3 bakes auth into the query string), so we set `no-store` to
  // discourage intermediate caching that would serve a stale token.
  return new Response(null, {
    status: 302,
    headers: {
      location: picked.item.FileLink,
      "cache-control": "no-store",
      "x-qsl-picked": picked.item.FileName ?? "",
      "x-qsl-arch": picked.arch,
      "x-qsl-candidates": String(candidates.length),
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

function isApiDisabled(env: Env): boolean {
  const raw = (env as Env & { DISABLE_API?: string }).DISABLE_API;
  return typeof raw === "string" && raw.toLowerCase() === "true";
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });

    const apiDisabled = isApiDisabled(env);

    let response: Response;
    if (url.pathname === "/api/_meta") {
      // Always available — the SPA reads this on boot so it can prompt the
      // user to configure a third-party backend when the same-origin API is
      // intentionally off. `version` mirrors package.json and `storelibVersion`
      // is the installed `@query-store-links/storelib_rs` version (both
      // inlined at build time via Vite `define`) so a client can detect
      // feature parity and which WASM resolver is actually running.
      response = json({
        apiDisabled,
        version: __APP_VERSION__,
        storelibVersion: __STORELIB_VERSION__,
        commit: __APP_COMMIT__ || null,
      });
    } else if (url.pathname === "/api/_debug/parse") {
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
      if (apiDisabled) {
        response = json({ ...asErrors([code("apiDisabled")]), Code: 503 }, 503);
      } else {
        response = await resolveAll(request);
      }
    } else if (url.pathname.startsWith("/api/")) {
      response = json(
        { ...asErrors([code("route.notFound", { path: url.pathname })]), Code: 404 },
        404,
      );
    } else if (isDownloadPermalink(url.pathname)) {
      // GET-only permalink endpoint — gated above the asset-binding fallback
      // so `/download/<id>` doesn't accidentally serve the SPA shell.
      if (request.method !== "GET" && request.method !== "HEAD") {
        response = json({ ...asErrors([code("method.notAllowed")]), Code: 405 }, 405);
      } else {
        response = await handleDownload(request, env);
      }
    } else {
      // Asset responses are same-origin and have immutable headers — return
      // them directly without applying CORS.
      return await serveAsset(request, env);
    }
    for (const [k, v] of Object.entries(CORS_HEADERS)) response.headers.set(k, v);
    return response;
  },
} satisfies ExportedHandler<Env>;
