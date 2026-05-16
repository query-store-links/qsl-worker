// Types and constants shared between the worker and the UI.

export type IdentifierType =
  | "ProductId"
  | "XboxTitleId"
  | "PackageFamilyName"
  | "ContentId"
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

export interface ResolveAllResponse {
  ProductId?: string;
  AppInfo?: AppInfo;
  AppxPackages?: DownloadItem[] | null;
  NonAppxPackages?: DownloadItem[] | null;
  Errors?: string[] | null;
  /** Non-fatal validator hints (unknown locale → fell back, etc). */
  Warnings?: string[] | null;
  /** Diagnostic info — request shape, parser output, store handler state. */
  Debug?: Record<string, unknown> | null;
  /** HTTP status when the worker returns an error. */
  Code?: number | null;
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
