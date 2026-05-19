// Types and constants shared between the worker and the UI.

export type IdentifierType =
  | "ProductId"
  | "XboxTitleId"
  | "PackageFamilyName"
  | "ContentId"
  | "WuCategoryId"
  | "LegacyWindowsPhoneProductId"
  | "LegacyWindowsStoreProductId"
  | "LegacyXboxProductId";

export type Ring = "Retail" | "RP" | "WIF" | "WIS";
export type PackageType = "APPX" | "Other" | "BlockMap";

export interface ResolveAllRequest {
  ProductInput: string;
  /** BCP-47 language tag, e.g. "en-US". Alias: `LanguageTag`. */
  Locale?: string;
  /** Same as `Locale` — explicit BCP-47 tag. */
  LanguageTag?: string;
  /** Bare ISO 639-1 language code (e.g. "en"). Combined with `Market` when no tag is supplied. */
  Language?: string;
  /** ISO 3166-1 alpha-2 market code, e.g. "US". */
  Market?: string;
  IdentifierType?: IdentifierType;
}

export interface AppInfo {
  Name: string;
  Publisher: string;
  Description: string;
  CategoryId: string | null;
  ProductId: string | null;
}

export interface DownloadItem {
  FileName: string;
  FileLink: string;
  FileSize: string;
  /** Lowercase hex SHA-256 of the package, from DisplayCatalog when available. */
  Sha256?: string | null;
}

/** Structured, localizable message emitted by the worker. The frontend
 *  resolves `code` against its i18n dictionary and interpolates `params`. */
export interface ApiCode {
  code: string;
  params?: Record<string, string | number> | null;
}

export interface ResolveAllResponse {
  ProductId?: string;
  AppInfo?: AppInfo;
  AppxPackages?: DownloadItem[] | null;
  NonAppxPackages?: DownloadItem[] | null;
  /** Legacy: English-rendered error strings. Kept so non-localizing API
   *  consumers (curl, scripts, older clients) keep working unchanged. New
   *  consumers should prefer {@link ErrorCodes} so they can localize. */
  Errors?: string[] | null;
  /** Structured error codes — the same payload as {@link Errors}, but
   *  preserved as `{ code, params }` so the frontend can translate them. */
  ErrorCodes?: ApiCode[] | null;
  /** Legacy: English-rendered, non-fatal validator hints. */
  Warnings?: string[] | null;
  /** Structured warnings — localizable form of {@link Warnings}. */
  WarningCodes?: ApiCode[] | null;
  /** Diagnostic info — request shape, parser output, store handler state. */
  Debug?: Record<string, unknown> | null;
  /** HTTP status when the worker returns an error. */
  Code?: number | null;
}

// ── Server-side English message templates ─────────────────────────────────
// The worker renders these to populate the legacy `Errors`/`Warnings` string
// arrays. The frontend's i18n module merges this same dict into its English
// translations so there's one source of truth.

export const API_CODE_MESSAGES_EN: Record<string, string> = {
  "product.notFound": "Product not found.",
  "product.lookupFailed": "Product lookup failed: {detail}",
  "packages.fetchFailed": "Failed to fetch packages: {detail}",
  "nonAppx.notFound": "Non-Appx product not found.",
  "method.notAllowed": "Method not allowed. POST a JSON body.",
  "request.invalidJson": "Could not parse request body as JSON: {detail}",
  "productInput.required": "ProductInput is required.",
  "internal.error": "Internal error: {detail}",
  apiDisabled:
    "This deployment's built-in resolver is disabled. Configure a third-party API Backend in Settings to use this UI.",
  "route.notFound": "No such API route: {path}",
  "locale.unknownMarket": 'Unknown market "{raw}", defaulting to "{fallback}". ({detail})',
  "locale.unknownLanguageTag": 'Unknown language tag "{raw}". ({detail})',
  "locale.unknownLanguage": 'Unknown language "{raw}". ({detail})',
  "locale.tagFailed": 'Locale.fromTag("{tag}") failed: {detail} — falling back to en-US.',
  "client.noDownloadLinks": "No download links returned for this identifier.",
  "client.httpError": "Backend returned HTTP {status}",
  "client.emptyBody": "Backend returned an empty body.",
  "download.badArch": 'Unknown architecture "{raw}". Use x64, arm64, x86, or neutral.',
  "download.badRegex": 'Invalid match regex "{raw}": {detail}',
  "download.badN": 'Invalid index "{raw}". Must be a non-negative integer.',
  "download.badFormat": 'Unknown format "{raw}". Use auto, redirect, or json.',
  "download.noLinks": "No download links found for this identifier.",
  "download.noMatch":
    "No package matched the filters (arch={arch}, match={match}). Try removing constraints.",
  "download.indexOutOfRange":
    "Requested index n={n} but only {total} candidate(s) remain after filtering.",
  "download.proxyFailed": "Proxy fetch failed: {detail}",
  "download.proxyUpstream": "Upstream returned HTTP {status} while proxying the download.",
  // Fallback used when a frontend reads an older worker that only emits the
  // legacy `Errors: string[]`. The message itself is the param.
  legacy: "{message}",
};

/** Render an {@link ApiCode} against a template dictionary. Defaults to the
 *  shared English templates — the worker uses this to fill the legacy
 *  `Errors`/`Warnings` string fields. */
export function renderApiCode(
  c: ApiCode,
  dict: Record<string, string> = API_CODE_MESSAGES_EN,
): string {
  const template = dict[c.code] ?? c.code;
  if (!c.params) return template;
  return template.replace(/\{(\w+)\}/g, (_, k: string) => {
    const v = c.params![k];
    return v == null ? `{${k}}` : String(v);
  });
}

// ── UI-only types / metadata ──────────────────────────────────────────

export interface SearchFormData {
  productInput: string;
  market: string;
  locale: string;
  ring: Ring;
  identifierType: IdentifierType;
  includeAppx: boolean;
  includeNonAppx: boolean;
}

export interface NormalizedItem {
  name: string;
  size: string;
  sizeBytes: number;
  url: string;
  expire?: string;
  type: PackageType;
  arch?: "x64" | "arm64" | "x86" | "neutral";
  version?: string;
  sha256?: string;
}

export interface IdTypeMeta {
  value: IdentifierType;
  label: string;
  short: string;
  hint: string;
  example: string;
  pattern: RegExp;
  group: "modern" | "legacy";
}

export const ID_TYPES: IdTypeMeta[] = [
  {
    value: "ProductId",
    label: "Product ID",
    short: "Product",
    hint: "12-character alphanumeric ID, or apps.microsoft.com URL",
    example: "9WZDNCRFJBMP",
    pattern: /^[A-Z0-9]{12}$/i,
    group: "modern",
  },
  {
    value: "PackageFamilyName",
    label: "Package Family Name",
    short: "PFN",
    hint: "Identity.Name_publisherhash",
    example: "Microsoft.WindowsCalculator_8wekyb3d8bbwe",
    pattern: /^[\w.-]+_[a-z0-9]+$/i,
    group: "modern",
  },
  {
    value: "XboxTitleId",
    label: "Xbox Title ID",
    short: "Xbox Title",
    hint: "Decimal Xbox title identifier (4–10 digits)",
    example: "1916283164",
    pattern: /^\d{4,10}$/,
    group: "modern",
  },
  {
    value: "ContentId",
    label: "Content ID",
    short: "Content",
    hint: "GUID-form content identifier",
    example: "8f3e3a1c-2a4e-4f3a-9c1b-8a4f2e3d5c6b",
    pattern: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    group: "modern",
  },
  {
    value: "WuCategoryId",
    label: "WU Category ID",
    short: "WU Category",
    hint: "GUID consumed by Windows Update (FE3) — skips DisplayCatalog",
    example: "8b3e3a1c-2a4e-4f3a-9c1b-8a4f2e3d5c6b",
    pattern: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    group: "modern",
  },
  {
    value: "LegacyWindowsStoreProductId",
    label: "Legacy Store Product ID",
    short: "Legacy Store",
    hint: "Older Windows 8/10 store identifier",
    example: "BWMM6Q9JFK6V",
    pattern: /^[A-Z0-9]{12}$/i,
    group: "legacy",
  },
  {
    value: "LegacyWindowsPhoneProductId",
    label: "Legacy Phone Product ID",
    short: "Legacy Phone",
    hint: "Windows Phone 7/8 product GUID",
    example: "a40100a4-9f1e-4f44-92b9-3f7c4a4b18e3",
    pattern: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    group: "legacy",
  },
  {
    value: "LegacyXboxProductId",
    label: "Legacy Xbox Product ID",
    short: "Legacy Xbox",
    hint: "Xbox 360-era title GUID",
    example: "584111ff-c4a8-4f3a-9c1b-8a4f2e3d5c6b",
    pattern: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    group: "legacy",
  },
];

export const ID_TYPE_BY_VALUE: Record<IdentifierType, IdTypeMeta> = Object.fromEntries(
  ID_TYPES.map((t) => [t.value, t]),
) as Record<IdentifierType, IdTypeMeta>;

export const RINGS: { value: Ring; label: string; sub: string }[] = [
  { value: "Retail", label: "Retail", sub: "Stable" },
  { value: "RP", label: "Release Preview", sub: "RP channel" },
  { value: "WIF", label: "Insider Dev", sub: "Fast (WIF)" },
  { value: "WIS", label: "Insider Beta", sub: "Slow (WIS)" },
];

export const MARKETS: { value: string; label: string }[] = [
  { value: "US", label: "United States" },
  { value: "GB", label: "United Kingdom" },
  { value: "DE", label: "Germany" },
  { value: "FR", label: "France" },
  { value: "JP", label: "Japan" },
  { value: "CN", label: "China" },
  { value: "BR", label: "Brazil" },
  { value: "IN", label: "India" },
  { value: "RU", label: "Russia" },
  { value: "KR", label: "Korea" },
];

export const LOCALES: string[] = [
  "en-US",
  "en-GB",
  "de-DE",
  "fr-FR",
  "ja-JP",
  "zh-CN",
  "pt-BR",
  "ko-KR",
  "ru-RU",
  "es-ES",
];

/** Worker package.json version that first added the FE3-only WuCategoryId
 *  resolver. Older deployments reject the identifier type. */
export const MIN_WU_CATEGORY_ID_WORKER_VERSION = "0.1.1";

/** True when `version` is `>= target` under a strict three-component
 *  `MAJOR.MINOR.PATCH` compare. `null` is treated as older (the worker's
 *  `/api/_meta` only emits `version` since 0.1.0, so absence means a build
 *  predating this feature). Non-numeric components clamp to 0. */
export function versionAtLeast(version: string | null | undefined, target: string): boolean {
  if (!version) return false;
  const parse = (s: string) =>
    s.split(".").map((n) => {
      const v = parseInt(n, 10);
      return Number.isFinite(v) ? v : 0;
    });
  const v = parse(version);
  const t = parse(target);
  for (let i = 0; i < Math.max(v.length, t.length); i++) {
    const a = v[i] ?? 0;
    const b = t[i] ?? 0;
    if (a !== b) return a > b;
  }
  return true;
}

export function supportsWuCategoryId(workerVersion: string | null | undefined): boolean {
  return versionAtLeast(workerVersion, MIN_WU_CATEGORY_ID_WORKER_VERSION);
}

/** Worker package.json version that first added the `/download/<id>`
 *  (and `/d/<id>`, `/installer/download/<id>`) permalink endpoint. */
export const MIN_DOWNLOAD_PERMALINK_WORKER_VERSION = "0.1.2";

export function supportsDownloadPermalink(workerVersion: string | null | undefined): boolean {
  return versionAtLeast(workerVersion, MIN_DOWNLOAD_PERMALINK_WORKER_VERSION);
}

/** Path styles the worker accepts for the download permalink. */
export type PermalinkPathStyle = "d" | "download" | "installerDownload";

export interface PermalinkOptions {
  pathStyle: PermalinkPathStyle;
  /** Architecture filter. Empty string = any (omitted from URL). */
  arch: "" | "x64" | "arm64" | "x86" | "neutral";
  /** Regex applied case-insensitively to the FileName. */
  match: string;
  /** Index into the filtered+sorted candidate list. */
  n: number;
  includeFramework: boolean;
  /** Include `.BlockMap`, `.eappx*`, `.emsix*` files in the candidate pool.
   *  Default false — these aren't end-user installable. */
  includeAuxiliary: boolean;
  format: "auto" | "redirect" | "json";
  proxy: boolean;
  /** When true, append `?market=` and `?lang=` to the URL. */
  overrideLocale: boolean;
  market: string;
  lang: string;
}

export const DEFAULT_PERMALINK_OPTIONS: PermalinkOptions = {
  pathStyle: "download",
  arch: "",
  match: "",
  n: 0,
  includeFramework: false,
  includeAuxiliary: false,
  format: "auto",
  proxy: false,
  overrideLocale: false,
  market: "US",
  lang: "en-US",
};

/** Build a download-permalink URL from the search id + builder options.
 *  Returns an empty string when `id` is empty (no link to share yet). */
export function buildPermalink(
  origin: string,
  id: string,
  identifierType: IdentifierType,
  opts: PermalinkOptions,
): string {
  if (!id) return "";
  const path =
    opts.pathStyle === "d"
      ? "/d/"
      : opts.pathStyle === "installerDownload"
        ? "/installer/download/"
        : "/download/";
  const sp = new URLSearchParams();
  if (identifierType !== "ProductId") sp.set("type", identifierType);
  if (opts.arch) sp.set("arch", opts.arch);
  if (opts.match) sp.set("match", opts.match);
  if (opts.n > 0) sp.set("n", String(opts.n));
  const includes: string[] = [];
  if (opts.includeFramework) includes.push("framework");
  if (opts.includeAuxiliary) includes.push("auxiliary");
  if (includes.length > 0) sp.set("include", includes.join(","));
  if (opts.format !== "auto") sp.set("format", opts.format);
  if (opts.proxy) sp.set("proxy", "true");
  if (opts.overrideLocale) {
    if (opts.market) sp.set("market", opts.market);
    if (opts.lang) sp.set("lang", opts.lang);
  }
  const q = sp.toString();
  // The id needs URI encoding so PFNs and GUIDs survive intermediate
  // proxies, but `/` and other reserved chars don't appear in any
  // Microsoft Store identifier so a single encodeURIComponent is sufficient.
  return `${origin}${path}${encodeURIComponent(id)}${q ? `?${q}` : ""}`;
}

export function detectIdentifierType(raw: string): IdentifierType | null {
  const s = raw.trim();
  if (!s) return null;
  if (/apps\.microsoft\.com/i.test(s) || /microsoft\.com\/store/i.test(s)) {
    if (/\/(?:detail|productId)\/([A-Z0-9]{12})/i.test(s)) return "ProductId";
  }
  if (/^[\w.-]+_[a-z0-9]+$/i.test(s)) return "PackageFamilyName";
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) return "ContentId";
  if (/^[A-Z0-9]{12}$/i.test(s)) return "ProductId";
  if (/^\d{4,10}$/.test(s)) return "XboxTitleId";
  return null;
}

export function extractProductInput(input: string, type: IdentifierType): string {
  const t = input.trim();
  if (type === "ProductId") {
    const m = t.match(/apps\.microsoft\.com\/(?:.*\/)?(?:detail|productId)\/([A-Z0-9]+)/i);
    if (m?.[1]) return m[1].toUpperCase();
    if (/^[A-Z0-9]{12}$/i.test(t)) return t.toUpperCase();
  }
  return t;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let n = bytes;
  let u = -1;
  do {
    n /= 1024;
    u++;
  } while (n >= 1024 && u < units.length - 1);
  return `${n.toFixed(n < 10 ? 2 : 1)} ${units[u]}`;
}

export function parseSizeStr(s: string): number {
  const m = s.trim().match(/^([\d.]+)\s*(B|KB|MB|GB|TB)?/i);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  const u = (m[2] ?? "B").toUpperCase();
  const factor: Record<string, number> = {
    B: 1,
    KB: 1024,
    MB: 1024 ** 2,
    GB: 1024 ** 3,
    TB: 1024 ** 4,
  };
  return n * (factor[u] ?? 1);
}

export function inferArch(name: string): NormalizedItem["arch"] {
  if (/_x64[._]/i.test(name)) return "x64";
  if (/_arm64[._]/i.test(name)) return "arm64";
  if (/_x86[._]/i.test(name)) return "x86";
  if (/_neutral[._]/i.test(name)) return "neutral";
  return undefined;
}

export function inferVersion(name: string): string | undefined {
  const m = name.match(/_(\d+\.\d+\.\d+\.\d+)_/);
  return m?.[1];
}
