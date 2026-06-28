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
  type DependencyGraph,
  type DependencyMap,
  type DependencyNode,
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

// DisplayCatalog returns dependency `minVersion` / `maxTested` as either a
// version string ("14.0.33728.0") or a packed integer depending on the
// endpoint — storelib types them as `any`. Coerce to a display string and
// drop empty values to `null`.
function depValueToString(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === "string") return v.trim() || null;
  if (typeof v === "number" || typeof v === "bigint") return v.toString();
  return String(v);
}

// Read storelib_rs 0.1.11's named dependency map straight off the handler.
// `frameworkDependencies` are the runtime PFNs (VCLibs, WindowsAppRuntime,
// .NET Native, …) the product was built against; `platformDependencies` are
// the targeted OS families (Windows.Universal, Windows.Desktop, …). Both
// getters are already deduplicated wasm-side.
function buildDependencyMap(handler: DisplayCatalogHandler): DependencyMap {
  const frameworks = handler.frameworkDependencies.map((d) => ({
    PackageIdentity: d.packageIdentity ?? null,
    MinVersion: depValueToString(d.minVersion),
    MaxTested: depValueToString(d.maxTested),
  }));
  const platforms = handler.platformDependencies.map((d) => ({
    PlatformName: d.platformName ?? null,
    MinVersion: depValueToString(d.minVersion),
    MaxTested: depValueToString(d.maxTested),
  }));
  return { Frameworks: frameworks, Platforms: platforms };
}

// PFN identity base (the "Name" segment of a `Name_Version_Arch_ResId_PubHash`
// full name / moniker). Underscore is the PFN field separator and never
// appears inside the identity itself, so the first segment is the identity.
function identityFromName(name: string | null | undefined): string | null {
  if (!name) return null;
  const base = name.split("_")[0];
  return base || null;
}

// FE3 monikers are `Name_Version_Arch_ResourceId_PubHash`. Pull the version /
// arch segments so a resolved framework node can show what's downloadable.
function monikerVersion(moniker: string): string | null {
  return moniker.split("_")[1] || null;
}
function monikerArch(moniker: string): string | null {
  const a = moniker.split("_")[2];
  return a && a !== "~" ? a : null;
}

// Build the directed dependency graph for the resolved product. DisplayCatalog
// declares, per app package, the named framework identities it needs
// (`Package.frameworkDependencies`, e.g. `Microsoft.VCLibs.140.00.UWPDesktop`);
// storelib_rs 0.1.11 surfaces these. We union them under the app's own
// identity and cross-reference the resolved FE3 packages so each framework
// node knows whether it's actually in the download set and at which
// versions/arches. The result is `app needs [frameworks]`, with each framework
// a node in its own right (a leaf here, since a single resolve only carries
// the app's declared edges — frameworks' own deps would need separate
// queries).
function buildDependencyGraph(
  handler: DisplayCatalogHandler,
  instances: PackageInstance[],
): DependencyGraph {
  // Index resolved packages by identity → versions / arches present. Keyed on
  // a lowercased identity because FE3's `packageIdentityName` and DCat's
  // full-name casing don't always agree (e.g. `4DF9E0F8.NETFLIX` vs
  // `4DF9E0F8.Netflix`) — the edges below carry DCat's original casing, so we
  // only need a case-insensitive *lookup* here, not canonical ids.
  const resolved = new Map<string, { versions: Set<string>; archs: Set<string> }>();
  for (const inst of instances) {
    const id = inst.packageIdentityName ?? identityFromName(inst.packageMoniker);
    if (!id) continue;
    const key = id.toLowerCase();
    const entry = resolved.get(key) ?? { versions: new Set<string>(), archs: new Set<string>() };
    const v = monikerVersion(inst.packageMoniker);
    const a = monikerArch(inst.packageMoniker);
    if (v) entry.versions.add(v);
    if (a) entry.archs.add(a);
    resolved.set(key, entry);
  }

  // App identities → declared framework deps, unioned across arch packages.
  const appDeps = new Map<string, Set<string>>();
  for (const p of handler.packages) {
    const appId = identityFromName(p.packageFullName ?? p.packageFamilyName);
    if (!appId) continue;
    const set = appDeps.get(appId) ?? new Set<string>();
    for (const d of p.frameworkDependencies ?? []) {
      if (d.packageIdentity && d.packageIdentity !== appId) set.add(d.packageIdentity);
    }
    appDeps.set(appId, set);
  }

  const nodes = new Map<string, DependencyNode>();
  const ensure = (id: string, isFramework: boolean): DependencyNode => {
    let n = nodes.get(id);
    if (!n) {
      const r = resolved.get(id.toLowerCase());
      n = {
        Id: id,
        Name: id,
        IsFramework: isFramework,
        Resolved: r != null,
        Versions: r ? [...r.versions].sort() : [],
        Architectures: r ? [...r.archs].sort() : [],
        DependsOn: [],
      };
      nodes.set(id, n);
    }
    if (isFramework) n.IsFramework = true;
    return n;
  };

  for (const [appId, deps] of appDeps) {
    const appNode = ensure(appId, false);
    for (const depId of deps) {
      ensure(depId, true);
      if (!appNode.DependsOn.includes(depId)) appNode.DependsOn.push(depId);
    }
  }

  // Roots = nodes nothing depends on (the app packages, usually).
  const depended = new Set<string>();
  for (const n of nodes.values()) for (const d of n.DependsOn) depended.add(d);
  const roots = [...nodes.keys()].filter((id) => !depended.has(id));

  return { Nodes: [...nodes.values()], Roots: roots };
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

/** Parse the message string from an FE3 per-package progress event into
 *  structured fields. storelib emits one such event per package the instant
 *  its FE3 download URL is parsed — earlier than the final
 *  `getPackagesForProduct` resolve completes, which is what lets us stream
 *  rows into the UI as they arrive.
 *
 *  Wire formats (defined in storelib_rs's `display_catalog.rs` / `fe3.rs`).
 *  storelib 0.1.11 enriched these with `digest=` / `locs=` / `prereqs=`
 *  fields and dropped `size=` from `fe3.linkReceived`, so the parser is a
 *  tolerant tokenizer rather than a fixed positional split:
 *
 *    fe3.linkReceived  (DCat):  "<moniker> | uri=<url> | digest=<h> | updateId=<id>"
 *    fe3.packageResolved (DCat): "<moniker> | uri=<url> | size=<bytes-or-?> |
 *                                 digest=<h> | locs=<n> | prereqs=<n> | updateId=<id>"
 *    fe3.linkReceived  (FE3-only): "uri=<url> | size=<bytes-or-?> | updateId=<id>"
 *      (no moniker — the WuCategoryId handler re-emits these with one prepended)
 *
 *  The separator is a literal `" | "` (space-pipe-space). FE3 URLs are
 *  percent-encoded so they can never contain that token, which makes a plain
 *  split safe even though URLs carry their own `|`/`&`/`=` query characters.
 *  A bare segment with no `=` is the leading moniker (absent on the FE3-only
 *  form). Unknown fields are simply ignored, so future additions won't break
 *  the parser. */
function parseLinkReceived(
  message: string,
): { moniker: string; uri: string; size: number | null; updateId: string } | null {
  const fields: Record<string, string> = {};
  let moniker = "";
  for (const seg of message.split(" | ")) {
    const eq = seg.indexOf("=");
    if (eq < 0) {
      if (!moniker) moniker = seg;
      continue;
    }
    // First occurrence wins; the known keys are unique per message.
    const key = seg.slice(0, eq);
    if (!(key in fields)) fields[key] = seg.slice(eq + 1);
  }
  const uri = fields.uri;
  if (uri == null) return null;
  const sizeStr = fields.size;
  const sizeNum = sizeStr == null || sizeStr === "?" ? null : Number(sizeStr);
  return {
    moniker,
    uri,
    size: Number.isFinite(sizeNum as number) ? sizeNum : null,
    updateId: fields.updateId ?? "",
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
// the WuCategoryId is echoed as both CategoryId and ProductId. Hashes still
// come off each PackageInstance (`sha1` / `sha256`) since FE3 supplies them.

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
        Sha256: pkg.sha256,
        Sha1: pkg.sha1,
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

    // Named dependency map (storelib_rs 0.1.11+) — available straight off the
    // DCat listing, before the FE3 package round-trip.
    const dependencies = buildDependencyMap(handler);

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

    // Hashes come ready-to-use off each PackageInstance (storelib_rs
    // 0.1.11-fix-1): `sha1` / `sha256` are lowercase hex of the exact bytes
    // FE3 serves, decoded from the `<File Digest>` / `<AdditionalDigest>`.
    // We do NOT use DisplayCatalog's `Package.hash` — it's base64 and the
    // storefront catalog can list a different *version* than FE3 serves, so
    // it never reliably matches the download.
    //
    // PackageInstance carries packageSize (FE3-reported bytes) and a
    // pre-formatted readableFileName — no HEAD requests needed.
    //
    // FE3's update graph can surface the same package under multiple update
    // IDs, so storelib may return multiple PackageInstances for one file.
    // Dedupe by packageUri (canonical pointer), falling back to packageMoniker
    // for framework packages where packageUri is null.
    const seen = new Set<string>();
    const items: DownloadItem[] = [];
    let hashMatched = 0;
    let sha1Matched = 0;
    for (const pkg of packages) {
      const key = pkg.packageUri || pkg.packageMoniker;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const sha256 = pkg.sha256;
      const sha1 = pkg.sha1;
      if (sha256) hashMatched++;
      if (sha1) sha1Matched++;
      items.push({
        FileName: pkg.readableFileName || pkg.packageMoniker || "Unknown",
        FileLink: pkg.packageUri ?? "",
        FileSize: bytesToString(pkg.packageSize),
        Sha256: sha256,
        Sha1: sha1,
      });
    }

    // FE3 expresses the same dependency graph as raw Windows-Update category
    // GUIDs on each package (`prerequisites`). Summarise the edge counts for
    // the debug panel; the named map above is the user-facing view.
    const prereqEdges = packages.reduce((n, p) => n + p.prerequisites.length, 0);
    const pkgsWithPrereqs = packages.filter((p) => p.prerequisites.length > 0).length;

    // Named per-package dependency graph (who needs whom), keyed on the DCat
    // FrameworkDependencies and cross-referenced against the resolved packages.
    const dependencyGraph = buildDependencyGraph(handler, packages);
    const graphEdges = dependencyGraph.Nodes.reduce((n, node) => n + node.DependsOn.length, 0);

    return {
      ProductId: productId,
      AppInfo: appInfo,
      AppxPackages: items,
      Dependencies: dependencies,
      DependencyGraph: dependencyGraph,
      ...asWarnings(warnings),
      Debug: {
        ...debug,
        dcatPackageCount: handler.packages.length,
        itemsWithSha256: hashMatched,
        itemsWithSha1: sha1Matched,
        frameworkDepCount: dependencies.Frameworks.length,
        platformDepCount: dependencies.Platforms.length,
        fe3PrereqEdges: prereqEdges,
        fe3PackagesWithPrereqs: pkgsWithPrereqs,
        depGraphNodes: dependencyGraph.Nodes.length,
        depGraphEdges: graphEdges,
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
  // Note: auxiliary (`.BlockMap` / `.eappx*` / `.emsix*`) exclusion happens
  // upstream in `handleDownload` so those items never reach this function.
  let pool = all.filter((c) => c.item.FileLink);
  if (!q.include.framework) pool = pool.filter((c) => !c.isFramework);
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

  const rawItems = [...(result.AppxPackages ?? []), ...(result.NonAppxPackages ?? [])];
  if (rawItems.length === 0) {
    return downloadErrorResponse(
      request,
      url,
      404,
      code("download.noLinks"),
      query,
      result.Debug ?? null,
    );
  }

  // Drop `.BlockMap` / `.eappx*` / `.emsix*` files at the items level — they
  // aren't installable, so there's no point computing candidate metadata or
  // running the sort/pick logic on them. `?include=auxiliary` opts back in.
  const items = query.include.auxiliary
    ? rawItems
    : rawItems.filter((item) => !isAuxiliaryFileName(item.FileName ?? ""));

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
        Sha1: picked.item.Sha1,
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
        Sha1: c.item.Sha1,
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

// ── PowerShell installer — GET /psi/<id> ────────────────────────────────
//
// `irm https://<host>/psi/<id> | iex` resolves the identifier through the
// same pipeline as `/api/links/resolve-all`, then returns a self-contained
// PowerShell script that downloads and installs the package(s) with
// `Add-AppxPackage` (or runs the installer for non-Appx / winget products).
//
// The script embeds the full resolved package set and does selection
// *client-side* — architecture is detected on the machine running the
// script (`$env:PROCESSOR_ARCHITECTURE`), which the server can't see.
//
// Query parameters (all optional; sensible auto-detection when omitted)
// --------------------------------------------------------------------
//   arch=x64|x86|x32|arm64|arm|neutral   pin an architecture (else auto)
//   version=<v>|latest                    pin a version (else latest)
//   deps=true|false                       install framework dependencies (default true)
//   ui=1                                  interactive: pick package + action
//   dryrun=1 / whatif=1                   print the plan, install nothing
//   downloadonly=1 / noinstall=1          download but don't install
//   dir=<path>                            download target (default temp)
//   force=1                               Add-AppxPackage -ForceApplicationShutdown
//   launch=1 / run=1                      launch the app after install
//   verify=0                              skip the SHA-256 check (default on)
//   match=<regex>                         filter candidate filenames
//   type=<IdentifierType>                 pin the identifier type (else detected)
//   market=<US> / lang=<en-US>            locale overrides

interface PsiQuery {
  arch: string; // "" = auto-detect
  version: string; // "" / "latest" = newest
  deps: boolean;
  ui: boolean;
  dryRun: boolean;
  force: boolean;
  launch: boolean;
  verify: boolean;
  downloadOnly: boolean;
  dir: string;
  market?: string;
  lang?: string;
  type?: string;
  match?: RegExp;
}

interface PsiPkg {
  name: string;
  url: string;
  arch: string;
  version: string;
  size: number;
  // SHA-256 of the served bytes (storelib_rs `PackageInstance.sha256`,
  // lowercase hex) — verify the download against `Get-FileHash`.
  sha256: string;
  isBundle: boolean;
  isFramework: boolean;
  kind: "appx" | "installer";
}

const PSI_PATH_RE = /^\/psi\/[^/?#]+\/?$/i;

function isPsiPermalink(pathname: string): boolean {
  return PSI_PATH_RE.test(pathname);
}

function parsePsiPath(pathname: string): string | null {
  const m = pathname.match(/^\/psi\/(.+?)\/?$/i);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1];
  }
}

function psiBool(sp: URLSearchParams, key: string, dflt: boolean): boolean {
  const v = sp.get(key);
  if (v == null) return dflt;
  const s = v.toLowerCase();
  if (s === "1" || s === "true" || s === "yes" || s === "on") return true;
  if (s === "0" || s === "false" || s === "no" || s === "off") return false;
  return dflt;
}

// Normalise an architecture alias to the moniker form. Unknown → "" (auto).
function normalizePsiArch(raw: string | null): string {
  if (!raw) return "";
  const s = raw.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (s === "x64" || s === "amd64" || s === "x8664" || s === "win64") return "x64";
  if (s === "x86" || s === "x32" || s === "ia32" || s === "win32" || s === "i386") return "x86";
  if (s === "arm64" || s === "aarch64") return "arm64";
  if (s === "arm" || s === "arm32") return "arm";
  if (s === "neutral" || s === "any" || s === "anycpu") return "neutral";
  return "";
}

function versionFromFileName(name: string): string {
  const m = name.match(/_(\d+\.\d+\.\d+\.\d+)_/);
  return m?.[1] ?? "";
}

function parsePsiQuery(url: URL): PsiQuery {
  const sp = url.searchParams;
  let match: RegExp | undefined;
  const matchRaw = sp.get("match");
  if (matchRaw) {
    try {
      match = new RegExp(matchRaw, "i");
    } catch {
      /* ignore a bad regex — treat as no filter */
    }
  }
  return {
    arch: normalizePsiArch(sp.get("arch")),
    version: (sp.get("version") ?? "").trim(),
    deps: psiBool(sp, "deps", true),
    ui: psiBool(sp, "ui", false),
    dryRun: psiBool(sp, "dryrun", false) || psiBool(sp, "whatif", false),
    force: psiBool(sp, "force", false),
    launch: psiBool(sp, "launch", false) || psiBool(sp, "run", false),
    verify: psiBool(sp, "verify", true),
    downloadOnly: psiBool(sp, "downloadonly", false) || psiBool(sp, "noinstall", false),
    dir: (sp.get("dir") ?? "").trim(),
    market: sp.get("market") ?? undefined,
    lang: sp.get("lang") ?? sp.get("locale") ?? undefined,
    type: sp.get("type") ?? undefined,
    match,
  };
}

function buildPsiPackages(
  items: DownloadItem[],
  kind: "appx" | "installer",
  match?: RegExp,
): PsiPkg[] {
  const out: PsiPkg[] = [];
  for (const it of items) {
    const name = it.FileName ?? "";
    if (!it.FileLink) continue;
    // Skip blockmaps and DRM-encrypted variants — not installable.
    if (isAuxiliaryFileName(name)) continue;
    if (match && !match.test(name)) continue;
    out.push({
      name,
      url: it.FileLink,
      arch: archFromFileName(name),
      version: versionFromFileName(name),
      size: Math.round(sizeStringToBytes(it.FileSize ?? "")),
      sha256: (it.Sha256 ?? "").toLowerCase(),
      isBundle: isBundleFileName(name),
      isFramework: kind === "appx" ? isFrameworkFileName(name) : false,
      kind,
    });
  }
  return out;
}

// PowerShell single-quoted string literal with embedded quotes doubled.
function psStr(s: string | null | undefined): string {
  return "'" + String(s ?? "").replace(/'/g, "''") + "'";
}

function psBoolLit(b: boolean): string {
  return b ? "$true" : "$false";
}

function psiResponse(script: string): Response {
  return new Response(script, {
    status: 200,
    headers: {
      // text/plain so `Invoke-RestMethod` hands the body to `iex` as a string
      // (an application/* type would make it try to parse the script).
      "content-type": "text/plain; charset=utf-8",
      // FE3 download URLs are time-limited; never cache a stale script.
      "cache-control": "no-store",
    },
  });
}

// A script that just surfaces an error to the user — returned (with HTTP 200,
// so `irm` doesn't throw before `iex` can show it) when resolution fails.
function psiErrorScript(message: string): string {
  return [
    "Write-Host 'Query Store Links installer' -ForegroundColor Cyan",
    `Write-Error ${psStr(message)}`,
    "",
  ].join("\n");
}

function generatePsiScript(id: string, q: PsiQuery, dataUrl: string): string {
  // NOTE: this is a PowerShell source template embedded in a JS template
  // literal. Keep it free of backticks (PS escape char — would break the JS
  // string) and `${` sequences (use `$(...)` / `$var`); literal backslashes
  // must be written doubled.
  //
  // This is a *bootstrap*: it carries no packages. It fetches them from the
  // `?format=json` data endpoint at runtime (`Get-PsiData`), which is where
  // the slow catalog/FE3 resolve happens — so the user gets a live
  // "Querying..." status instead of an unexplained pause while `irm` waits.
  return `# Query Store Links - PowerShell Installer (psi)
# ${id}
# Generated for: irm <host>/psi/${id} | iex
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$Cfg = [pscustomobject]@{
  Id           = ${psStr(id)}
  Name         = ${psStr(id)}
  DataUrl      = ${psStr(dataUrl)}
  Arch         = ${psStr(q.arch)}
  Version      = ${psStr(q.version)}
  Deps         = ${psBoolLit(q.deps)}
  Ui           = ${psBoolLit(q.ui)}
  DryRun       = ${psBoolLit(q.dryRun)}
  Force        = ${psBoolLit(q.force)}
  Launch       = ${psBoolLit(q.launch)}
  Verify       = ${psBoolLit(q.verify)}
  DownloadOnly = ${psBoolLit(q.downloadOnly)}
  Dir          = ${psStr(q.dir)}
}

# Resolve the product server-side (catalog + FE3) and return the installable
# package set. The resolve is the slow part, so announce it up front and
# report how long it took once the data lands.
function Get-PsiData {
  Write-Step "Querying Microsoft Store catalog for $($Cfg.Id) ..."
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  try {
    $d = Invoke-RestMethod -Uri $Cfg.DataUrl -Headers @{ Accept = 'application/json' }
  } catch {
    throw "Could not reach the resolver ($($Cfg.DataUrl)): $_"
  }
  $sw.Stop()
  if (-not $d.ok) { throw "$($d.error)" }
  if ($d.name) { $Cfg.Name = $d.name }
  $pkgs = @($d.packages)
  Write-Info ("resolved {0} package(s) in {1:n1}s" -f $pkgs.Count, $sw.Elapsed.TotalSeconds)
  return ,$pkgs
}

function Write-Step($m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Write-Info($m) { Write-Host "    $m" -ForegroundColor DarkGray }

function Get-HostArch {
  $a = $env:PROCESSOR_ARCHITEW6432
  if (-not $a) { $a = $env:PROCESSOR_ARCHITECTURE }
  switch ("$a".ToUpper()) {
    'AMD64' { 'x64' }
    'ARM64' { 'arm64' }
    'X86'   { 'x86' }
    'ARM'   { 'arm' }
    default { 'x64' }
  }
}

function Select-ByVersion($list, $want) {
  if ($want -and $want -ne 'latest') {
    $f = @($list | Where-Object { $_.Version -like "$want*" })
    if ($f.Count) { return $f }
    Write-Warning "No package matched version '$want'; using the latest instead."
  }
  $valid = @($list | Where-Object { $_.Version -as [version] })
  if ($valid.Count) {
    $max = ($valid | Sort-Object { [version]$_.Version } | Select-Object -Last 1).Version
    return @($list | Where-Object { $_.Version -eq $max })
  }
  return $list
}

function Select-ByArch($list, $arch) {
  $bundle = @($list | Where-Object { $_.IsBundle })
  if ($bundle.Count) { return ($bundle | Sort-Object Size -Descending | Select-Object -First 1) }
  $order = switch ($arch) {
    'x64'   { @('x64','x86','neutral') }
    'x86'   { @('x86','neutral') }
    'arm64' { @('arm64','arm','x86','x64','neutral') }
    'arm'   { @('arm','neutral') }
    default { @($arch,'neutral') }
  }
  foreach ($a in $order) {
    $c = @($list | Where-Object { $_.Arch -eq $a } | Sort-Object Size -Descending)
    if ($c.Count) { return $c[0] }
  }
  return ($list | Sort-Object Size -Descending | Select-Object -First 1)
}

function Save-Package($p, $dir) {
  $dest = Join-Path $dir $p.Name
  Write-Info "downloading $($p.Name)  ($([math]::Round($p.Size / 1MB, 1)) MB)"
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $done = $false
  # Prefer BITS: it shows a native progress bar and streams large bundles
  # efficiently. Fall back to Invoke-WebRequest where BITS isn't available.
  try {
    Import-Module BitsTransfer -ErrorAction Stop
    $pp = $ProgressPreference
    $ProgressPreference = 'Continue'
    try {
      Start-BitsTransfer -Source $p.Url -Destination $dest -Description $p.Name -ErrorAction Stop
      $done = $true
    } finally { $ProgressPreference = $pp }
  } catch { $done = $false }
  if (-not $done) {
    $pp = $ProgressPreference
    $ProgressPreference = 'SilentlyContinue'
    try { Invoke-WebRequest -Uri $p.Url -OutFile $dest -UseBasicParsing } finally { $ProgressPreference = $pp }
  }
  $sw.Stop()
  Write-Info ("  done: {0:n1} MB in {1:n1}s" -f ((Get-Item $dest).Length / 1MB), $sw.Elapsed.TotalSeconds)
  if ($Cfg.Verify -and $p.Sha256) {
    Write-Info "  verifying SHA-256 ..."
    $h = (Get-FileHash -Algorithm SHA256 -Path $dest).Hash
    if ($h -ne $p.Sha256.ToUpper()) { throw "SHA-256 mismatch for $($p.Name)" }
    Write-Info "  SHA-256 OK"
  }
  return $dest
}

# True when a package named $name (this arch or neutral) is installed at a
# version >= $minVer. Any probe failure returns $false.
function Test-Installed($name, $minVer, $arch) {
  try {
    $min = $minVer -as [version]
    $hit = Get-AppxPackage -Name $name -ErrorAction SilentlyContinue | Where-Object {
      ($_.Architecture -ieq $arch -or $_.Architecture -ieq 'neutral') -and
      (-not $min -or (($_.Version -as [version]) -ge $min))
    }
    return [bool]$hit
  } catch { return $false }
}

# Read the <PackageDependency> entries (Name + MinVersion) a downloaded package
# declares. For a bundle, drill into the app package matching $arch (else
# neutral). Returns @() on any failure so the caller falls back to a plain
# install. This is the authority on what to hand Add-AppxPackage: it rejects
# the whole install if given a framework the package does NOT depend on
# ("provided but not used"), so we must never supply extras.
function Get-PackageDeps($path, $arch) {
  try {
    Add-Type -AssemblyName System.IO.Compression.FileSystem -ErrorAction SilentlyContinue
    $zip = [System.IO.Compression.ZipFile]::OpenRead($path)
    try {
      $readXml = {
        param($entry)
        $sr = New-Object System.IO.StreamReader($entry.Open())
        try { [xml]$sr.ReadToEnd() } finally { $sr.Dispose() }
      }
      $bundleEntry = $zip.Entries | Where-Object { $_.FullName -ieq 'AppxMetadata/AppxBundleManifest.xml' } | Select-Object -First 1
      if ($bundleEntry) {
        $bx = & $readXml $bundleEntry
        $apps = @($bx.Bundle.Packages.Package | Where-Object { $_.Type -eq 'application' })
        $sel = @($apps | Where-Object { $_.Architecture -ieq $arch })[0]
        if (-not $sel) { $sel = @($apps | Where-Object { $_.Architecture -ieq 'neutral' })[0] }
        if (-not $sel) { $sel = $apps[0] }
        if (-not $sel) { return @() }
        $inner = $zip.Entries | Where-Object { $_.FullName -ieq $sel.FileName } | Select-Object -First 1
        if (-not $inner) { return @() }
        $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ([System.Guid]::NewGuid().ToString('N') + '.appx')
        [System.IO.Compression.ZipFileExtensions]::ExtractToFile($inner, $tmp, $true)
        try { return (Get-PackageDeps $tmp $arch) } finally { Remove-Item $tmp -Force -ErrorAction SilentlyContinue }
      }
      $manEntry = $zip.Entries | Where-Object { $_.FullName -ieq 'AppxManifest.xml' } | Select-Object -First 1
      if (-not $manEntry) { return @() }
      $mx = & $readXml $manEntry
      $out = @()
      foreach ($pd in @($mx.Package.Dependencies.PackageDependency)) {
        if ($pd -and $pd.Name) { $out += [pscustomobject]@{ Name = "$($pd.Name)"; MinVersion = "$($pd.MinVersion)" } }
      }
      return $out
    } finally { $zip.Dispose() }
  } catch { return @() }
}

function Invoke-Psi {
  Write-Host ""
  Write-Host "Query Store Links installer" -ForegroundColor Cyan

  $Packages = Get-PsiData
  Write-Host "$($Cfg.Name) [$($Cfg.Id)]" -ForegroundColor White

  $arch = if ($Cfg.Arch) { $Cfg.Arch } else { Get-HostArch }
  Write-Info "architecture: $arch$(if (-not $Cfg.Arch) { ' (auto-detected)' })"

  $appx = @($Packages | Where-Object { $_.Kind -eq 'appx' })
  $installers = @($Packages | Where-Object { $_.Kind -eq 'installer' })

  # Non-Appx (winget) product: download and run the installer.
  if ($appx.Count -eq 0 -and $installers.Count -gt 0) {
    $pick = Select-ByArch $installers $arch
    if ($Cfg.Ui) {
      Write-Host "Installers:" -ForegroundColor White
      for ($i = 0; $i -lt $installers.Count; $i++) {
        Write-Host ("  [{0}] {1} [{2}]" -f $i, $installers[$i].Name, $installers[$i].Arch)
      }
      $sel = Read-Host "Select index (Enter for $($pick.Name))"
      if ($sel -ne '') { $pick = $installers[[int]$sel] }
    }
    if ($Cfg.DryRun) {
      Write-Host "[dry-run] would download and run $($pick.Name)" -ForegroundColor Yellow
      return
    }
    $dir = if ($Cfg.Dir) { $Cfg.Dir } else { Join-Path ([System.IO.Path]::GetTempPath()) ("qsl_" + [System.Guid]::NewGuid().ToString('N')) }
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
    Write-Step "Downloading installer"
    $path = Save-Package $pick $dir
    if ($Cfg.DownloadOnly) { Write-Host "Saved to $path" -ForegroundColor Green; return }
    Write-Step "Running installer"
    Start-Process -FilePath $path -Wait
    Write-Host "Done." -ForegroundColor Green
    return
  }

  if ($appx.Count -eq 0) { throw "No installable packages were returned for this identifier." }

  $mains = @($appx | Where-Object { -not $_.IsFramework })
  $fws = @($appx | Where-Object { $_.IsFramework })
  if ($mains.Count -eq 0) { $mains = $appx }

  $mains = @(Select-ByVersion $mains $Cfg.Version)
  $pick = Select-ByArch $mains $arch

  if ($Cfg.Ui) {
    Write-Host "Packages:" -ForegroundColor White
    for ($i = 0; $i -lt $mains.Count; $i++) {
      $m = $mains[$i]
      Write-Host ("  [{0}] {1}  [{2}] v{3}  {4} MB" -f $i, $m.Name, $m.Arch, $m.Version, [math]::Round($m.Size / 1MB, 1))
    }
    $sel = Read-Host "Select index to install (Enter for $($pick.Name))"
    if ($sel -ne '') { $pick = $mains[[int]$sel] }
    $act = Read-Host "Action: [I]nstall / [D]ownload only / [C]ancel (default I)"
    switch ("$act".ToUpper()) {
      'C' { Write-Host "Cancelled." -ForegroundColor Yellow; return }
      'D' { $Cfg.DownloadOnly = $true }
      default { }
    }
  }

  Write-Info "selected: $($pick.Name)"
  Write-Info "  $($pick.Arch) | v$($pick.Version) | $([math]::Round($pick.Size / 1MB, 1)) MB"

  if ($Cfg.DryRun) {
    Write-Host "[dry-run] plan:" -ForegroundColor Yellow
    Write-Host "  install: $($pick.Name)"
    Write-Host "  dependencies: read from the package manifest after download; only the"
    Write-Host "                declared frameworks that aren't already installed are fetched."
    return
  }

  # Already up to date? Skip unless a reinstall is forced. In-box apps (the
  # Store itself, etc.) are preinstalled, so a same-version Add-AppxPackage
  # would just error — short-circuit with a clear message instead.
  $mainName = ($pick.Name -split '_')[0]
  $pv = $pick.Version -as [version]
  if ($pv -and -not $Cfg.Force -and -not $Cfg.DownloadOnly) {
    $have = Get-AppxPackage -Name $mainName -ErrorAction SilentlyContinue |
      Where-Object { ($_.Version -as [version]) -ge $pv } | Select-Object -First 1
    if ($have) {
      Write-Host "Already installed: $mainName v$($have.Version)  (pass ?force=1 to reinstall)." -ForegroundColor Green
      return
    }
  }

  $dir = if ($Cfg.Dir) { $Cfg.Dir } else { Join-Path ([System.IO.Path]::GetTempPath()) ("qsl_" + [System.Guid]::NewGuid().ToString('N')) }
  New-Item -ItemType Directory -Path $dir -Force | Out-Null

  Write-Step "Downloading package"
  $mainPath = Save-Package $pick $dir

  # Resolve dependencies from the package's OWN manifest — the only authority
  # on what it needs. DisplayCatalog/FE3 list legacy framework lines an app no
  # longer depends on (e.g. *.Native.*.1.7 next to 2.2, UI.Xaml.2.4 next to
  # 2.8); handing any of those to Add-AppxPackage fails the whole install with
  # "provided but not used". So we supply ONLY declared frameworks, and only
  # the ones not already present.
  Write-Step "Resolving dependencies"
  $needPaths = @()
  # NB: assign @(...) directly, never via "if (...) { @(...) }". PowerShell
  # unwraps a single-element array returned from an if-expression to a scalar,
  # so a package with exactly ONE dependency would arrive here as a bare object
  # whose .Count is $null — making us wrongly report "no dependencies" and skip
  # it (e.g. Windows Terminal, which depends only on Microsoft.UI.Xaml.2.8).
  $declared = @()
  if ($Cfg.Deps) { $declared = @(Get-PackageDeps $mainPath $arch) }
  if (-not $Cfg.Deps) {
    Write-Info "dependency handling disabled"
  } elseif (-not $declared.Count) {
    Write-Info "package manifest declares no framework dependencies (or could not be read)"
  } else {
    Write-Info "manifest declares $($declared.Count) framework dependency(ies)"
    foreach ($wd in $declared) {
      $present = Test-Installed $wd.Name $wd.MinVersion $arch
      $cand = @($fws | Where-Object {
          ((($_.Name -split '_')[0]) -ieq $wd.Name) -and ($_.Arch -ieq $arch -or $_.Arch -ieq 'neutral')
        } | Sort-Object { $_.Version -as [version] } | Select-Object -Last 1)
      if ($present -and -not $Cfg.DownloadOnly) {
        Write-Info "  present: $($wd.Name) (>= $($wd.MinVersion))"
      } elseif ($cand.Count) {
        Write-Info "  fetch:   $($wd.Name) (>= $($wd.MinVersion))"
        $needPaths += (Save-Package $cand[0] $dir)
      } else {
        Write-Warning "  required but unavailable for download: $($wd.Name) (>= $($wd.MinVersion))"
      }
    }
  }

  if ($Cfg.DownloadOnly) {
    Write-Host "Saved to $dir" -ForegroundColor Green
    return
  }

  Write-Step "Installing $($Cfg.Name)"
  $params = @{ Path = $mainPath }
  if ($needPaths.Count) {
    $params['DependencyPath'] = $needPaths
    Write-Info "registering with $($needPaths.Count) dependency package(s) ..."
  } else {
    Write-Info "registering package (all dependencies already present) ..."
  }
  if ($Cfg.Force) { $params['ForceApplicationShutdown'] = $true }
  Add-AppxPackage @params
  Write-Host "Installed $($Cfg.Name)." -ForegroundColor Green

  if ($Cfg.Launch) {
    try {
      $idName = ($pick.Name -split '_')[0]
      $installed = Get-AppxPackage -Name $idName | Select-Object -First 1
      if ($installed) {
        $manifest = Get-AppxPackageManifest $installed
        $appId = @($manifest.Package.Applications.Application.Id)[0]
        if ($appId) {
          Start-Process ("shell:appsFolder\\" + $installed.PackageFamilyName + "!" + $appId)
          Write-Info "launched"
        }
      }
    } catch { Write-Warning "Could not launch the app automatically: $_" }
  }
}

try { Invoke-Psi }
catch {
  Write-Host ""
  Write-Error "Install failed: $_"
  Write-Host "If this is a signing/sideloading error the package may need Developer Mode enabled, or its trust certificate installed." -ForegroundColor Yellow
}
`;
}

// Absolute URL of the `?format=json` data endpoint the bootstrap calls back
// to — same path/query as the incoming request, plus `format=json`.
function buildPsiDataUrl(url: URL): string {
  const params = new URLSearchParams(url.search);
  params.set("format", "json");
  return `${url.origin}${url.pathname}?${params.toString()}`;
}

async function handlePsi(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const id = parsePsiPath(url.pathname);
  // `?format=json` returns the resolved package data (consumed by the
  // bootstrap script); anything else returns the bootstrap script itself.
  const wantData = (url.searchParams.get("format") ?? "").toLowerCase() === "json";

  if (!id) {
    const msg = "No product id in the URL. Use /psi/<id>.";
    return wantData ? json({ ok: false, error: msg }) : psiResponse(psiErrorScript(msg));
  }
  if (isApiDisabled(env)) {
    const msg = "This deployment's built-in resolver is disabled.";
    return wantData ? json({ ok: false, error: msg }) : psiResponse(psiErrorScript(msg));
  }

  const q = parsePsiQuery(url);

  // Script path: emit the bootstrap instantly (no resolve). It fetches the
  // data endpoint at runtime, so the slow catalog/FE3 work happens *after*
  // `irm` returns — letting the script print a "Querying..." status.
  if (!wantData) {
    return psiResponse(generatePsiScript(id, q, buildPsiDataUrl(url)));
  }

  // Data path: resolve and return JSON for the bootstrap to install from.
  const idType = q.type ?? detectIdentifierType(id) ?? "ProductId";
  const body: ResolveAllRequest = {
    ProductInput: id,
    IdentifierType: idType as ResolveAllRequest["IdentifierType"],
    Market: q.market,
    LanguageTag: q.lang,
  };

  let result: ResolveAllResponse;
  try {
    const ac = new AbortController();
    request.signal?.addEventListener("abort", () => ac.abort(), { once: true });
    result = (await resolveProduct(id, body, ac.signal)).result;
  } catch (e) {
    return json({ ok: false, error: `Resolve failed: ${String(e)}` });
  }

  if (result.ErrorCodes?.length) {
    const msg = result.ErrorCodes.map((c) => renderApiCode(c)).join("; ");
    return json({ ok: false, error: msg || "Product not found." });
  }

  const pkgs = [
    ...buildPsiPackages(result.AppxPackages ?? [], "appx", q.match),
    ...buildPsiPackages(result.NonAppxPackages ?? [], "installer", q.match),
  ];
  if (pkgs.length === 0) {
    return json({ ok: false, error: `No installable packages were found for '${id}'.` });
  }

  const appName = result.AppInfo?.Name;
  const name = appName && appName !== "Unknown Name" ? appName : id;
  return json({
    ok: true,
    id,
    name,
    packages: pkgs.map((p) => ({
      Name: p.name,
      Url: p.url,
      Arch: p.arch,
      Version: p.version,
      Size: p.size,
      Sha256: p.sha256,
      IsBundle: p.isBundle,
      IsFramework: p.isFramework,
      Kind: p.kind,
    })),
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
    } else if (isPsiPermalink(url.pathname)) {
      // `irm <host>/psi/<id> | iex` — returns a PowerShell install script.
      // Errors are returned *as a script* (HTTP 200) so `irm` doesn't throw
      // before `iex` can surface the message to the user.
      if (request.method !== "GET" && request.method !== "HEAD") {
        response = psiResponse(psiErrorScript("Method not allowed. Use GET."));
      } else {
        response = await handlePsi(request, env);
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
