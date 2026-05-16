import {
  extractProductInput,
  formatBytes,
  inferArch,
  inferVersion,
  parseSizeStr,
  type ApiCode,
  type NormalizedItem,
  type PackageType,
  type ResolveAllResponse,
  type SearchFormData,
} from "./shared";

export interface BackendResult {
  items: NormalizedItem[];
  warnings: ApiCode[];
  debug: Record<string, unknown> | null;
  raw: ResolveAllResponse;
}

// One progress update mirrored from storelib_rs's ProgressEvent.
export interface ProgressUpdate {
  stage: string;
  message: string;
  current: number | null;
  total: number | null;
}

// One streaming-package row, emitted by the worker as each package's
// download URL resolves. The UI surfaces these in real time; the final
// `result` event still arrives with the canonical list (including SHA-256
// joined from DCat) and replaces the streamed rows.
export interface StreamedPackage {
  fileName: string;
  fileLink: string;
  fileSize: string;
  moniker: string;
  updateId: string;
}

/** Frontend-side coded error used when a client-side check fails after a
 *  successful response (e.g. zero usable items). UI surfaces translate via
 *  the `errors` field, just like {@link BackendError}. */
export class CodedClientError extends Error {
  readonly errors: ApiCode[];
  constructor(errors: ApiCode[]) {
    super(errors.map((e) => e.code).join(", ") || "CodedClientError");
    this.name = "CodedClientError";
    this.errors = errors;
  }
}

export class BackendError extends Error {
  readonly status: number;
  readonly errors: ApiCode[];
  readonly response: ResolveAllResponse | null;
  readonly endpoint: string;
  readonly requestBody: Record<string, unknown>;
  constructor(opts: {
    errors: ApiCode[];
    status: number;
    response: ResolveAllResponse | null;
    endpoint: string;
    requestBody: Record<string, unknown>;
  }) {
    // `message` is filled with the raw code strings (e.g. "product.notFound")
    // so unhandled-rejection logs still carry something searchable. UI surfaces
    // localize via `errors`.
    super(opts.errors.map((e) => e.code).join(", ") || "BackendError");
    this.name = "BackendError";
    this.errors = opts.errors;
    this.status = opts.status;
    this.response = opts.response;
    this.endpoint = opts.endpoint;
    this.requestBody = opts.requestBody;
  }
}

export async function callBackend(
  backend: string,
  customMarket: string,
  form: SearchFormData,
  signal: AbortSignal,
  onProgress?: (e: ProgressUpdate) => void,
  onPackage?: (item: NormalizedItem) => void,
): Promise<BackendResult> {
  const url = `${backend.replace(/\/$/, "")}/api/links/resolve-all`;
  const finalInput = extractProductInput(form.productInput, form.identifierType);
  // The market override lives in app settings; when present it wins over the
  // form's market. We send `Locale` (BCP-47) and, when the locale carries its
  // own region, also break it apart so the worker can fall back gracefully.
  const market = customMarket || form.market;
  const [langPart] = form.locale.split("-");
  const payload = {
    ProductInput: finalInput,
    IdentifierType: form.identifierType,
    Market: market,
    Locale: form.locale,
    Language: langPart,
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // Opt into the streaming NDJSON variant — the worker emits one event
      // per line (progress + final result) and the legacy single-JSON path
      // is preserved for non-streaming clients.
      Accept: "application/x-ndjson",
    },
    body: JSON.stringify(payload),
    signal,
  });

  const ctype = res.headers.get("content-type") ?? "";
  let raw: ResolveAllResponse | null;
  if (ctype.includes("application/x-ndjson") && res.body) {
    // Adapt the raw streamed package into a NormalizedItem the table can
    // render. Type is always APPX here — `fe3.linkReceived` only fires for
    // FE3-resolved packages, never the non-Appx winget path or BlockMap.
    const onPackageRaw = onPackage
      ? (raw: StreamedPackage) => {
          onPackage({
            name: raw.fileName,
            size: raw.fileSize,
            sizeBytes: parseSizeStr(raw.fileSize),
            url: raw.fileLink,
            type: "APPX",
            arch: inferArch(raw.fileName),
            version: inferVersion(raw.fileName),
          });
        }
      : undefined;
    raw = await readNdjsonStream(res.body, onProgress, onPackageRaw);
  } else {
    // Worker fell back to single-JSON (older deployment, or an upstream
    // proxy stripped the body). Parse it as one shot.
    try {
      raw = (await res.json()) as ResolveAllResponse;
    } catch {
      raw = null;
    }
  }

  // Prefer the structured `ErrorCodes` form (lets us localize). Fall back to
  // the legacy `Errors: string[]` shape when consuming an older worker — we
  // wrap each raw string under the `legacy` code so the UI still renders it
  // verbatim instead of dropping the message.
  const codedErrors = raw?.ErrorCodes?.length
    ? raw.ErrorCodes
    : raw?.Errors?.length
      ? raw.Errors.map<ApiCode>((message) => ({ code: "legacy", params: { message } }))
      : null;

  if (!res.ok || codedErrors) {
    const errors: ApiCode[] = codedErrors ?? [
      { code: "client.httpError", params: { status: res.status } },
    ];
    throw new BackendError({
      errors,
      status: res.status,
      response: raw,
      endpoint: url,
      requestBody: payload,
    });
  }
  if (!raw) {
    throw new BackendError({
      errors: [{ code: "client.emptyBody" }],
      status: res.status,
      response: null,
      endpoint: url,
      requestBody: payload,
    });
  }

  const flatten = (arr: ResolveAllResponse["AppxPackages"], type: PackageType): NormalizedItem[] =>
    (arr ?? []).map((item) => {
      const sizeStr = item.FileSize ?? "0 B";
      return {
        name: item.FileName ?? "Unknown",
        size: sizeStr,
        sizeBytes: parseSizeStr(sizeStr),
        url: item.FileLink ?? "#",
        type,
        arch: inferArch(item.FileName ?? ""),
        version: inferVersion(item.FileName ?? ""),
        sha256: item.Sha256 ?? undefined,
      };
    });

  // Same `*Codes`-first / legacy-strings-fallback logic as for errors.
  const warnings: ApiCode[] = raw.WarningCodes?.length
    ? raw.WarningCodes
    : raw.Warnings?.length
      ? raw.Warnings.map((message) => ({ code: "legacy", params: { message } }))
      : [];

  return {
    items: [...flatten(raw.AppxPackages, "APPX"), ...flatten(raw.NonAppxPackages, "Other")],
    warnings,
    debug: raw.Debug ?? null,
    raw,
  };
}

async function readNdjsonStream(
  body: ReadableStream<Uint8Array>,
  onProgress?: (e: ProgressUpdate) => void,
  onPackage?: (p: StreamedPackage) => void,
): Promise<ResolveAllResponse | null> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result: ResolveAllResponse | null = null;

  const toPackage = (evt: Record<string, unknown>): StreamedPackage => ({
    fileName: String(evt.FileName ?? evt.fileName ?? ""),
    fileLink: String(evt.FileLink ?? evt.fileLink ?? ""),
    fileSize: String(evt.FileSize ?? evt.fileSize ?? "Unknown"),
    moniker: String(evt.Moniker ?? evt.moniker ?? ""),
    updateId: String(evt.UpdateId ?? evt.updateId ?? ""),
  });

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (value) buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let evt: Record<string, unknown>;
        try {
          evt = JSON.parse(trimmed) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (evt.type === "progress" && onProgress) {
          onProgress({
            stage: String(evt.stage ?? ""),
            message: String(evt.message ?? ""),
            current: typeof evt.current === "number" ? evt.current : null,
            total: typeof evt.total === "number" ? evt.total : null,
          });
        } else if (evt.type === "package" && onPackage) {
          onPackage(toPackage(evt));
        } else if (evt.type === "result") {
          // Strip the `type` discriminator; the rest matches ResolveAllResponse.
          const { type: _t, ...rest } = evt;
          void _t;
          result = rest as ResolveAllResponse;
        }
      }
      if (done) break;
    }
  } finally {
    reader.releaseLock();
  }

  // Drain any trailing partial line (shouldn't happen for well-formed NDJSON).
  const tail = buffer.trim();
  if (tail) {
    try {
      const evt = JSON.parse(tail) as Record<string, unknown>;
      if (evt.type === "result") {
        const { type: _t, ...rest } = evt;
        void _t;
        result = rest as ResolveAllResponse;
      }
    } catch {
      /* ignore */
    }
  }

  return result;
}

export interface WorkerMeta {
  apiDisabled: boolean;
  /** Worker package.json version. `null` when the backend predates the
   *  /api/_meta endpoint and was detected via a resolve-endpoint fallback. */
  version: string | null;
  /** Installed `@query-store-links/storelib_rs` version on the worker —
   *  the actual resolver running, not whatever range was declared. `null`
   *  on older deployments. */
  storelibVersion: string | null;
}

/** Probe the same-origin worker's status. Tries `/api/_meta` first; if the
 *  endpoint is absent (older deployment) falls back to GET `/api/links/resolve-all`,
 *  which always returns 405 on the working worker — a "proper rejection" still
 *  proves the API is up. Returns `null` on network failure. */
export async function fetchMeta(signal?: AbortSignal): Promise<WorkerMeta | null> {
  try {
    const res = await fetch("/api/_meta", { signal });
    if (res.ok) {
      const body = (await res.json()) as Partial<WorkerMeta>;
      return {
        apiDisabled: body.apiDisabled === true,
        version: typeof body.version === "string" ? body.version : null,
        storelibVersion: typeof body.storelibVersion === "string" ? body.storelibVersion : null,
      };
    }
    // Anything other than 2xx is treated as "no _meta here" — fall through.
  } catch {
    return null;
  }

  // Older deployment fallback: ask the actual resolve endpoint. A GET on the
  // POST-only handler returns 405 with a JSON body — that's the "proper
  // rejection" we want. Any HTTP response (even 5xx) means the worker is up.
  try {
    const res = await fetch("/api/links/resolve-all", { signal, method: "GET" });
    if (res.status > 0) return { apiDisabled: false, version: null, storelibVersion: null };
    return null;
  } catch {
    return null;
  }
}

/** Read a *custom* backend's `/api/_meta` over CORS. Returns the parsed meta
 *  on success, or `null` when the backend is unreachable, doesn't ship the
 *  endpoint, or refuses CORS preflight. The caller should fall back to
 *  `probeBackend` for plain liveness when this returns `null`. */
export async function fetchBackendMeta(
  backend: string,
  signal?: AbortSignal,
): Promise<WorkerMeta | null> {
  if (!backend) return null;
  const url = `${backend.replace(/\/$/, "")}/api/_meta`;
  try {
    const res = await fetch(url, { signal, cache: "no-store" });
    if (!res.ok) return null;
    const body = (await res.json()) as Partial<WorkerMeta>;
    return {
      apiDisabled: body.apiDisabled === true,
      version: typeof body.version === "string" ? body.version : null,
      storelibVersion: typeof body.storelibVersion === "string" ? body.storelibVersion : null,
    };
  } catch {
    return null;
  }
}

/** Liveness probe for a custom backend. Uses `no-cors` mode so a server that
 *  doesn't set CORS headers (or returns 4xx/5xx) still counts as reachable —
 *  the goal is only to differentiate "host responded" from "host unreachable
 *  / DNS dead / refused / TLS broken". Tries `/api/_meta` first; if the first
 *  attempt throws (DNS/TLS/refused), retries against `/api/links/resolve-all`
 *  to support older deployments that don't expose the meta endpoint. */
export async function probeBackend(backend: string, signal?: AbortSignal): Promise<boolean> {
  if (!backend) return false;
  const base = backend.replace(/\/$/, "");
  try {
    await fetch(`${base}/api/_meta`, { signal, mode: "no-cors", cache: "no-store" });
    return true;
  } catch {
    // First call threw — but with no-cors a real network failure is the only
    // way to get here, so the retry will almost always fail too. We still do
    // it for paranoia: some proxies / WAFs may reject specific paths but pass
    // others.
  }
  try {
    await fetch(`${base}/api/links/resolve-all`, {
      signal,
      method: "GET",
      mode: "no-cors",
      cache: "no-store",
    });
    return true;
  } catch {
    return false;
  }
}

export function mockResults(input: string): NormalizedItem[] {
  const seed = input.length || 5;
  const base = [
    {
      name: "Microsoft.WindowsCalculator_11.2403.1.0_x64__8wekyb3d8bbwe.appxbundle",
      type: "APPX",
      bytes: 88212000,
      arch: "x64",
      v: "11.2403.1.0",
    },
    {
      name: "Microsoft.WindowsCalculator_11.2403.1.0_arm64__8wekyb3d8bbwe.appxbundle",
      type: "APPX",
      bytes: 84140000,
      arch: "arm64",
      v: "11.2403.1.0",
    },
    {
      name: "Microsoft.WindowsCalculator_11.2403.1.0_x86__8wekyb3d8bbwe.appxbundle",
      type: "APPX",
      bytes: 79110000,
      arch: "x86",
      v: "11.2403.1.0",
    },
    {
      name: "Microsoft.VCLibs.140.00_14.0.33728.0_x64__8wekyb3d8bbwe.appx",
      type: "APPX",
      bytes: 3120000,
      arch: "x64",
      v: "14.0.33728.0",
    },
    {
      name: "Microsoft.VCLibs.140.00.UWPDesktop_14.0.33728.0_x64__8wekyb3d8bbwe.appx",
      type: "APPX",
      bytes: 5860000,
      arch: "x64",
      v: "14.0.33728.0",
    },
    {
      name: "Microsoft.UI.Xaml.2.8_8.2310.30001.0_x64__8wekyb3d8bbwe.appx",
      type: "APPX",
      bytes: 14290000,
      arch: "x64",
      v: "8.2310.30001.0",
    },
    {
      name: "Microsoft.NET.Native.Framework.2.2_2.2.29512.0_x64__8wekyb3d8bbwe.appx",
      type: "APPX",
      bytes: 2120000,
      arch: "x64",
      v: "2.2.29512.0",
    },
    {
      name: "Microsoft.NET.Native.Runtime.2.2_2.2.28604.0_x64__8wekyb3d8bbwe.appx",
      type: "APPX",
      bytes: 1230000,
      arch: "x64",
      v: "2.2.28604.0",
    },
    {
      name: "Microsoft.WindowsCalculator_11.2403.1.0_neutral_~_8wekyb3d8bbwe.appxsym",
      type: "Other",
      bytes: 4810000,
      arch: "neutral",
      v: "11.2403.1.0",
    },
    { name: "AppxBlockMap.xml", type: "BlockMap", bytes: 28000, arch: "neutral", v: "" },
  ] as const;
  return base.map((b, i) => ({
    name: b.name,
    size: formatBytes(b.bytes + seed * 137 * (i + 1)),
    sizeBytes: b.bytes + seed * 137 * (i + 1),
    url: `https://tlu.dl.delivery.mp.microsoft.com/filestreamingservice/files/${(seed * 31 + i).toString(16)}-mock-${i.toString(16).padStart(4, "0")}`,
    type: b.type as PackageType,
    arch: b.arch as NormalizedItem["arch"],
    version: b.v,
    sha256:
      b.type === "BlockMap"
        ? undefined
        : Array.from({ length: 64 }, (_, j) =>
            ((seed * 31 + i * 17 + j * 7) & 0xf).toString(16),
          ).join(""),
  }));
}
