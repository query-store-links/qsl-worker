import {
  extractProductInput,
  formatBytes,
  inferArch,
  inferVersion,
  parseSizeStr,
  type NormalizedItem,
  type PackageType,
  type ResolveAllResponse,
  type SearchFormData,
} from "./shared";

export interface BackendResult {
  items: NormalizedItem[];
  warnings: string[];
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

export class BackendError extends Error {
  readonly status: number;
  readonly response: ResolveAllResponse | null;
  readonly endpoint: string;
  readonly requestBody: Record<string, unknown>;
  constructor(
    message: string,
    opts: {
      status: number;
      response: ResolveAllResponse | null;
      endpoint: string;
      requestBody: Record<string, unknown>;
    },
  ) {
    super(message);
    this.name = "BackendError";
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
    raw = await readNdjsonStream(res.body, onProgress);
  } else {
    // Worker fell back to single-JSON (older deployment, or an upstream
    // proxy stripped the body). Parse it as one shot.
    try {
      raw = (await res.json()) as ResolveAllResponse;
    } catch {
      raw = null;
    }
  }

  if (!res.ok || raw?.Errors?.length) {
    const msg = raw?.Errors?.[0] ?? `Backend returned HTTP ${res.status}`;
    throw new BackendError(msg, {
      status: res.status,
      response: raw,
      endpoint: url,
      requestBody: payload,
    });
  }
  if (!raw) {
    throw new BackendError("Backend returned an empty body.", {
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
      };
    });

  return {
    items: [...flatten(raw.AppxPackages, "APPX"), ...flatten(raw.NonAppxPackages, "Other")],
    warnings: raw.Warnings ?? [],
    debug: raw.Debug ?? null,
    raw,
  };
}

async function readNdjsonStream(
  body: ReadableStream<Uint8Array>,
  onProgress?: (e: ProgressUpdate) => void,
): Promise<ResolveAllResponse | null> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result: ResolveAllResponse | null = null;

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
  }));
}
