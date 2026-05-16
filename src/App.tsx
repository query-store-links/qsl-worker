import { useEffect, useMemo, useRef, useState } from "react";
import {
  Body1,
  Button,
  FluentProvider,
  Link,
  MessageBar,
  MessageBarActions,
  MessageBarBody,
  MessageBarTitle,
  Text,
  Title2,
  Toast,
  ToastBody,
  ToastTitle,
  Toaster,
  Tooltip,
  makeStyles,
  tokens,
  useId,
  useToastController,
  webDarkTheme,
  webLightTheme,
} from "@fluentui/react-components";
import { DismissRegular } from "@fluentui/react-icons";

import { TopBar, DEFAULT_BACKEND, type AppSettings } from "./components/TopBar";
import { SearchCard } from "./components/SearchCard";
import { ResultsView } from "./components/ResultsView";
import { HistoryDrawer, type HistoryItem } from "./components/HistoryDrawer";
import { DebugPanel } from "./components/DebugPanel";
import { NotFoundPage } from "./components/NotFoundPage";
import { ProgressPanel } from "./components/ProgressPanel";
import { useLocalState } from "./hooks";
import { translateApiCode, useT } from "./i18n";
import {
  callBackend,
  CodedClientError,
  fetchBackendMeta,
  fetchMeta,
  mockResults,
  probeBackend,
  type BackendError,
  type ProgressUpdate,
  type WorkerMeta,
} from "./api";
import type {
  ApiCode,
  AppInfo,
  IdentifierType,
  NormalizedItem,
  Ring,
  SearchFormData,
} from "./shared";

const DEFAULT_FORM: SearchFormData = {
  productInput: "",
  market: "US",
  locale: "en-US",
  ring: "Retail",
  identifierType: "ProductId",
  includeAppx: true,
  includeNonAppx: true,
};

const KNOWN_PATHS = new Set(["/", "/index.html"]);

/** Hosts on the project's own apex domain — the resolver deployment lives
 *  here (see wrangler.jsonc routes), so a user pointing at any subdomain of
 *  it is effectively still using the first-party backend. Suppress the
 *  third-party warning for these. */
function isTrustedBackendHost(backend: string): boolean {
  try {
    const host = new URL(backend).hostname.toLowerCase();
    return host === "krnl64.win" || host.endsWith(".krnl64.win");
  } catch {
    return false;
  }
}

/** Same `*.krnl64.win` check applied to the *UI's* hostname. True for the
 *  official deployment and any subdomain on the project's apex. Localhost /
 *  loopback are treated as official since they're obviously dev — a warning
 *  there is noise. */
function isOfficialUiHost(): boolean {
  if (typeof window === "undefined") return true;
  const host = window.location.hostname.toLowerCase();
  if (host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1") {
    return true;
  }
  return host === "krnl64.win" || host.endsWith(".krnl64.win");
}

interface ErrorState {
  err: BackendError | CodedClientError | Error;
  warnings: ApiCode[];
  debug: Record<string, unknown> | null;
}

const useStyles = makeStyles({
  shell: {
    minHeight: "100vh",
    display: "flex",
    flexDirection: "column",
    backgroundColor: tokens.colorNeutralBackground2,
  },
  main: {
    flex: 1,
    width: "100%",
    maxWidth: "1100px",
    margin: "0 auto",
    padding: "32px 24px 64px",
    display: "flex",
    flexDirection: "column",
    rowGap: "20px",
  },
  hero: { marginBottom: "4px" },
  heroTitle: {
    fontSize: "32px",
    fontWeight: 700,
    letterSpacing: "-0.5px",
    lineHeight: 1.15,
    marginTop: 0,
    marginBottom: 0,
  },
  heroSub: {
    marginTop: "8px",
    color: tokens.colorNeutralForeground3,
    fontSize: "15px",
    maxWidth: "720px",
    display: "block",
  },
  heroGradient: {
    backgroundImage: `linear-gradient(90deg, ${tokens.colorBrandForeground1}, #8d4ad9)`,
    WebkitBackgroundClip: "text",
    backgroundClip: "text",
    color: "transparent",
    // Inherit type from the surrounding Title2 so the gradient run stays at
    // 32px / bold instead of dropping down to Text's default body scale.
    fontFamily: "inherit",
    fontSize: "inherit",
    fontWeight: "inherit",
    lineHeight: "inherit",
    letterSpacing: "inherit",
  },
  delay60: { animationDelay: "60ms" },
  footer: {
    marginTop: "32px",
    paddingTop: "16px",
    paddingBottom: "16px",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    columnGap: "16px",
    rowGap: "8px",
    flexWrap: "wrap",
    color: tokens.colorNeutralForeground3,
    fontSize: "12px",
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
  },
});

export default function App() {
  const styles = useStyles();
  const toasterId = useId("qsl-toaster");
  const { dispatchToast } = useToastController(toasterId);

  const [isDark, setIsDark] = useLocalState<boolean>(
    "qsl_theme_dark",
    () =>
      typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches,
  );

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", isDark ? "dark" : "light");
  }, [isDark]);

  const initialPath = typeof window !== "undefined" ? window.location.pathname : "/";
  const [path, setPath] = useState(initialPath);
  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  if (!KNOWN_PATHS.has(path) && !path.startsWith("/?")) {
    return (
      <FluentProvider theme={isDark ? webDarkTheme : webLightTheme}>
        <NotFoundPage
          path={path}
          onHome={() => {
            window.history.pushState({}, "", "/");
            setPath("/");
          }}
        />
      </FluentProvider>
    );
  }

  return (
    <FluentProvider theme={isDark ? webDarkTheme : webLightTheme}>
      <Resolver
        styles={styles}
        isDark={isDark}
        setIsDark={setIsDark}
        toasterId={toasterId}
        push={(intent, title, body) =>
          dispatchToast(
            <Toast>
              <ToastTitle>{title}</ToastTitle>
              {body ? <ToastBody>{body}</ToastBody> : null}
            </Toast>,
            { intent, timeout: 2800 },
          )
        }
      />
    </FluentProvider>
  );
}

interface ResolverProps {
  styles: ReturnType<typeof useStyles>;
  isDark: boolean;
  setIsDark: (v: boolean) => void;
  toasterId: string;
  push: (intent: "success" | "error" | "warning" | "info", title: string, body?: string) => void;
}

function Resolver({ styles, isDark, setIsDark, toasterId, push }: ResolverProps) {
  const t = useT();
  const [settings, setSettings] = useLocalState<AppSettings>("qsl_settings", {
    backend: DEFAULT_BACKEND,
    customMarket: "",
    locale: "en-US",
  });
  const [form, setForm] = useLocalState<SearchFormData>("qsl_form", DEFAULT_FORM);
  const [history, setHistory] = useLocalState<HistoryItem[]>("qsl_history", []);
  const [results, setResults] = useState<NormalizedItem[]>([]);
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [resolvedQuery, setResolvedQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<ProgressUpdate | null>(null);
  const [errorState, setErrorState] = useState<ErrorState | null>(null);
  const [warnings, setWarnings] = useState<ApiCode[]>([]);
  const [debug, setDebug] = useState<Record<string, unknown> | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [apiDisabled, setApiDisabled] = useState(false);
  const [backendMeta, setBackendMeta] = useState<WorkerMeta | null>(null);
  const [thirdPartyAck, setThirdPartyAck] = useLocalState<string[]>("qsl_trusted_backends", []);
  const [unofficialAck, setUnofficialAck] = useLocalState<string[]>("qsl_unofficial_ui_ack", []);
  const [backendHealth, setBackendHealth] = useState<"unknown" | "checking" | "ok" | "down">(
    "unknown",
  );
  const abortRef = useRef<AbortController | null>(null);

  const pushHistory = (f: SearchFormData, count: number) => {
    const id = `${f.identifierType}:${f.productInput}:${f.ring}:${f.market}:${Date.now()}`;
    setHistory((p) => {
      const filtered = p.filter(
        (h) =>
          !(
            h.productInput === f.productInput &&
            h.identifierType === f.identifierType &&
            h.ring === f.ring
          ),
      );
      return [{ ...f, id, ts: Date.now(), resultCount: count }, ...filtered].slice(0, 20);
    });
  };

  const doResolve = async (overrideForm?: SearchFormData) => {
    const current = overrideForm ?? form;
    if (!current.productInput) return;
    abortRef.current?.abort();
    abortRef.current = new AbortController();
    setLoading(true);
    setProgress(null);
    setErrorState(null);
    setWarnings([]);
    setDebug(null);
    setNotice(null);
    setResults([]);
    setAppInfo(null);
    setResolvedQuery(current.productInput);

    try {
      // Per-resolve dedup: the worker emits one `fe3.linkReceived` per
      // package, but a retry inside storelib could in principle fire twice
      // for the same URL — keep the first arrival.
      const streamedUrls = new Set<string>();
      const result = await callBackend(
        settings.backend,
        settings.customMarket,
        current,
        abortRef.current.signal,
        (e) => setProgress(e),
        (item) => {
          if (streamedUrls.has(item.url)) return;
          streamedUrls.add(item.url);
          // Honour the user's include filters as rows stream in. Streamed
          // rows are always APPX (FE3 path), so the NonAppx-only case
          // simply shows nothing until the final result lands.
          if (!current.includeAppx) return;
          setResults((p) => [...p, item]);
        },
      );
      const filtered = result.items.filter(
        (it) =>
          (current.includeAppx || it.type !== "APPX") &&
          (current.includeNonAppx || it.type === "APPX"),
      );
      if (filtered.length === 0) {
        throw new CodedClientError([{ code: "client.noDownloadLinks" }]);
      }
      // Final swap: replace the hashless streamed rows with the canonical
      // list (sorted as the worker returned them, with SHA-256 attached).
      setResults(filtered);
      setAppInfo(result.raw.AppInfo ?? null);
      setWarnings(result.warnings);
      setDebug(result.debug);
      setBackendHealth("ok");
      pushHistory(current, filtered.length);
      push("success", t("toast.resolved", { count: filtered.length }));
    } catch (err) {
      if ((err as { name?: string })?.name === "AbortError") {
        setLoading(false);
        return;
      }
      const backendErr = err as BackendError;
      const debug = backendErr.response?.Debug ?? null;
      // Same `*Codes`-first / legacy-strings-fallback as `callBackend` uses
      // for the success path, applied to whatever warnings rode along on the
      // failed response.
      const resp = backendErr.response;
      const respWarnings: ApiCode[] = resp?.WarningCodes?.length
        ? resp.WarningCodes
        : resp?.Warnings?.length
          ? resp.Warnings.map((message) => ({ code: "legacy", params: { message } }))
          : [];
      // `BackendError` only fires after we received a response, so we know
      // the host is alive even if it errored. A bare Error (no .status) is
      // typically a network failure — mark the backend down so the pill dot
      // turns red.
      if (typeof backendErr?.status === "number") setBackendHealth("ok");
      else setBackendHealth("down");
      setErrorState({
        err: err as Error,
        warnings: respWarnings,
        debug,
      });
      // The mock-data fallback is a dev affordance for previewing the UI
      // against an unreachable backend. In production it would actively
      // mislead by showing fake download links next to a real error, so
      // skip it and just surface the diagnostics.
      if (import.meta.env.DEV) {
        const mock = mockResults(current.productInput).filter(
          (it) =>
            (current.includeAppx || it.type !== "APPX") &&
            (current.includeNonAppx || it.type === "APPX"),
        );
        setResults(mock);
        setNotice(t("banner.offlinePreview.body"));
        pushHistory(current, mock.length);
      }
    } finally {
      setLoading(false);
      setProgress(null);
    }
  };

  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    const id = sp.get("id");
    if (!id) return;
    const incoming: SearchFormData = {
      ...form,
      productInput: id,
      identifierType: (sp.get("idType") as IdentifierType) || form.identifierType,
      market: sp.get("market") || form.market,
      ring: (sp.get("ring") as Ring) || form.ring,
      locale: sp.get("locale") || form.locale,
    };
    setForm(incoming);
    setTimeout(() => doResolve(incoming), 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    setBackendHealth("checking");
    setBackendMeta(null);
    if (settings.backend) {
      // Try a CORS-enabled meta read first so we can surface the version.
      // If the backend doesn't expose CORS (or _meta is absent), fall back
      // to the lenient no-cors liveness probe.
      fetchBackendMeta(settings.backend, ac.signal).then((meta) => {
        if (ac.signal.aborted) return;
        if (meta) {
          setBackendMeta(meta);
          setBackendHealth("ok");
          return;
        }
        probeBackend(settings.backend, ac.signal).then((alive) => {
          if (!ac.signal.aborted) setBackendHealth(alive ? "ok" : "down");
        });
      });
    } else {
      // Same-origin: reuse the meta call. Reachable + not disabled → green;
      // reachable + disabled → still "down" from the user's POV (the API
      // refuses to resolve), so they need to point Settings at a backend.
      fetchMeta(ac.signal).then((m) => {
        if (ac.signal.aborted) return;
        if (!m) {
          setBackendHealth("down");
          return;
        }
        setBackendMeta(m);
        if (m.apiDisabled) {
          setApiDisabled(true);
          setBackendHealth("down");
        } else {
          setBackendHealth("ok");
        }
      });
    }
    return () => ac.abort();
  }, [settings.backend]);

  const shareUrl = useMemo(() => {
    if (!form.productInput) return "";
    const sp = new URLSearchParams();
    sp.set("id", form.productInput);
    if (form.identifierType !== "ProductId") sp.set("idType", form.identifierType);
    if (form.market !== "US") sp.set("market", form.market);
    if (form.ring !== "Retail") sp.set("ring", form.ring);
    if (form.locale !== "en-US") sp.set("locale", form.locale);
    return `${window.location.origin}${window.location.pathname}?${sp.toString()}`;
  }, [form]);

  const copyShare = async () => {
    if (!shareUrl) return;
    try {
      await navigator.clipboard.writeText(shareUrl);
      push("success", t("toast.shareCopied"));
    } catch {
      push("error", t("toast.couldntCopy"), t("toast.clipboardDenied"));
    }
  };

  const onCopy = async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text);
      push("success", t("toast.copied"), what);
    } catch {
      push("error", t("toast.couldntCopy"));
    }
  };

  return (
    <div className={styles.shell}>
      <TopBar
        isDark={isDark}
        setIsDark={setIsDark}
        settings={settings}
        setSettings={setSettings}
        onOpenHistory={() => setShowHistory(true)}
        historyCount={history.length}
        backendHealth={backendHealth}
      />

      <main className={styles.main}>
        <div className={`qsl-fade-up ${styles.hero}`}>
          <Title2 as="h1" block className={styles.heroTitle}>
            {t("app.hero.titleLead")}{" "}
            <Text as="span" className={styles.heroGradient}>
              {t("app.hero.titleHighlight")}
            </Text>
          </Title2>
          <Body1 className={styles.heroSub}>{t("app.hero.sub")}</Body1>
        </div>

        {!isOfficialUiHost() &&
          typeof window !== "undefined" &&
          !unofficialAck.includes(window.location.hostname) && (
            <MessageBar intent="warning" layout="multiline">
              <MessageBarBody>
                <MessageBarTitle>{t("banner.unofficial.title")}</MessageBarTitle>
                <Body1 block>{t("banner.unofficial.body", { host: window.location.host })}</Body1>
              </MessageBarBody>
              <MessageBarActions
                containerAction={
                  <Tooltip content={t("banner.unofficial.dismiss")} relationship="label">
                    <Button
                      aria-label={t("banner.unofficial.ack")}
                      appearance="transparent"
                      icon={<DismissRegular />}
                      onClick={() =>
                        setUnofficialAck((p) =>
                          p.includes(window.location.hostname)
                            ? p
                            : [...p, window.location.hostname],
                        )
                      }
                    />
                  </Tooltip>
                }
              />
            </MessageBar>
          )}

        {apiDisabled && !settings.backend && (
          <MessageBar intent="error" layout="multiline">
            <MessageBarBody>
              <MessageBarTitle>{t("banner.apiDisabled.title")}</MessageBarTitle>
              <Body1 block>
                {t("banner.apiDisabled.body", { apiBackend: t("topbar.config.backend.label") })}
              </Body1>
              <Body1 block>
                <Text weight="semibold">{t("banner.apiDisabled.heads")}</Text>{" "}
                {t("banner.apiDisabled.warn")}
              </Body1>
            </MessageBarBody>
          </MessageBar>
        )}

        {settings.backend &&
          !isTrustedBackendHost(settings.backend) &&
          !thirdPartyAck.includes(settings.backend) && (
            <MessageBar intent="warning" layout="multiline">
              <MessageBarBody>
                <MessageBarTitle>{t("banner.thirdParty.title")}</MessageBarTitle>
                <Body1 block>
                  {t("banner.thirdParty.body", {
                    host: settings.backend.replace(/^https?:\/\//, ""),
                  })}
                </Body1>
              </MessageBarBody>
              <MessageBarActions
                containerAction={
                  <Tooltip content={t("banner.thirdParty.dismiss")} relationship="label">
                    <Button
                      aria-label={t("banner.thirdParty.ack")}
                      appearance="transparent"
                      icon={<DismissRegular />}
                      onClick={() =>
                        setThirdPartyAck((p) =>
                          p.includes(settings.backend) ? p : [...p, settings.backend],
                        )
                      }
                    />
                  </Tooltip>
                }
              />
            </MessageBar>
          )}

        <div className={`qsl-fade-up ${styles.delay60}`}>
          <SearchCard
            form={form}
            setForm={setForm}
            onResolve={() => doResolve()}
            loading={loading}
            onAbort={() => abortRef.current?.abort()}
            shareUrl={shareUrl}
            onCopyShare={copyShare}
          />
        </div>

        {loading && (
          <div className="qsl-fade-up">
            <ProgressPanel
              update={progress}
              query={resolvedQuery}
              onAbort={() => abortRef.current?.abort()}
            />
          </div>
        )}

        {errorState && (
          <DebugPanel
            title={t("banner.debug.failed")}
            error={errorState.err}
            warnings={errorState.warnings}
            debug={errorState.debug}
            onDismiss={() => setErrorState(null)}
            onCopy={onCopy}
          />
        )}

        {warnings.length > 0 && !errorState && (
          <MessageBar intent="warning">
            <MessageBarBody>
              <MessageBarTitle>
                {t(
                  warnings.length === 1
                    ? "banner.workerNotes.title"
                    : "banner.workerNotes.title.plural",
                  { count: warnings.length },
                )}
              </MessageBarTitle>
              {warnings.map((w, i) => (
                <Body1 key={i} block>
                  {translateApiCode(t, w)}
                </Body1>
              ))}
            </MessageBarBody>
            <MessageBarActions
              containerAction={
                <Tooltip content={t("common.dismiss")} relationship="label">
                  <Button
                    aria-label={t("common.dismiss")}
                    appearance="transparent"
                    icon={<DismissRegular />}
                    onClick={() => setWarnings([])}
                  />
                </Tooltip>
              }
            />
          </MessageBar>
        )}

        {notice && (
          <MessageBar intent="warning">
            <MessageBarBody>
              <MessageBarTitle>{t("banner.offlinePreview.title")}</MessageBarTitle>
              {notice}
            </MessageBarBody>
            <MessageBarActions
              containerAction={
                <Tooltip content={t("common.dismiss")} relationship="label">
                  <Button
                    aria-label={t("common.dismiss")}
                    appearance="transparent"
                    icon={<DismissRegular />}
                    onClick={() => setNotice(null)}
                  />
                </Tooltip>
              }
            />
          </MessageBar>
        )}

        {debug && !errorState && (
          <DebugPanel
            intent="info"
            title={t("banner.debug.resolved")}
            error={null}
            warnings={[]}
            debug={debug}
            onDismiss={() => setDebug(null)}
            onCopy={onCopy}
          />
        )}

        {results.length > 0 && (
          <div className="qsl-fade-up">
            <ResultsView
              results={results}
              query={resolvedQuery}
              appInfo={appInfo}
              onCopy={onCopy}
            />
          </div>
        )}

        <footer className={styles.footer}>
          <Text size={200}>
            {t("app.brand")} · {t("app.tagline")}
            {(() => {
              const host = settings.backend
                ? (() => {
                    try {
                      return new URL(settings.backend).host;
                    } catch {
                      return settings.backend;
                    }
                  })()
                : typeof window !== "undefined"
                  ? window.location.host
                  : "same-origin";
              const ver = backendMeta?.version
                ? `v${backendMeta.version}`
                : t("app.footer.versionUnknown");
              const slibPart = backendMeta?.storelibVersion
                ? t("app.footer.storelib", { version: backendMeta.storelibVersion })
                : "";
              return ` · ${t("app.footer.via", { host, version: ver, storelib: slibPart })}`;
            })()}
          </Text>
          <Text size={200}>
            <Link
              href="https://github.com/query-store-links/qsl-worker"
              target="_blank"
              rel="noreferrer"
            >
              {t("app.footer.github")}
            </Link>{" "}
            · {t("app.footer.copy")}
          </Text>
        </footer>
      </main>

      <HistoryDrawer
        open={showHistory}
        onDismiss={() => setShowHistory(false)}
        items={history}
        onRun={(it) => {
          setShowHistory(false);
          setForm(it);
          doResolve(it);
        }}
        onClear={() => setHistory([])}
        onRemove={(id) => setHistory((p) => p.filter((h) => h.id !== id))}
      />

      <Toaster toasterId={toasterId} position="bottom-end" />
    </div>
  );
}
