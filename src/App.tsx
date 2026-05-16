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
import { callBackend, mockResults, type BackendError, type ProgressUpdate } from "./api";
import type { AppInfo, IdentifierType, NormalizedItem, Ring, SearchFormData } from "./shared";

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

interface ErrorState {
  err: BackendError | Error;
  warnings: string[];
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
  const [warnings, setWarnings] = useState<string[]>([]);
  const [debug, setDebug] = useState<Record<string, unknown> | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
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
      const result = await callBackend(
        settings.backend,
        settings.customMarket,
        current,
        abortRef.current.signal,
        (e) => setProgress(e),
      );
      const filtered = result.items.filter(
        (it) =>
          (current.includeAppx || it.type !== "APPX") &&
          (current.includeNonAppx || it.type === "APPX"),
      );
      if (filtered.length === 0) {
        throw new Error("No download links returned for this identifier.");
      }
      setResults(filtered);
      setAppInfo(result.raw.AppInfo ?? null);
      setWarnings(result.warnings);
      setDebug(result.debug);
      pushHistory(current, filtered.length);
      push("success", `${filtered.length} files resolved`);
    } catch (err) {
      if ((err as { name?: string })?.name === "AbortError") {
        setLoading(false);
        return;
      }
      const backendErr = err as BackendError;
      const debug = backendErr.response?.Debug ?? null;
      const respWarnings = backendErr.response?.Warnings ?? [];
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
        setNotice("Showing sample data so you can preview the UI — see Diagnostics above.");
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
      push("success", "Shareable link copied");
    } catch {
      push("error", "Couldn't copy", "Clipboard access denied.");
    }
  };

  const onCopy = async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text);
      push("success", "Copied", what);
    } catch {
      push("error", "Couldn't copy");
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
      />

      <main className={styles.main}>
        <div className={`qsl-fade-up ${styles.hero}`}>
          <Title2 as="h1" block className={styles.heroTitle}>
            Resolve Microsoft Store{" "}
            <Text as="span" className={styles.heroGradient}>
              download links
            </Text>
          </Title2>
          <Body1 className={styles.heroSub}>
            Look up direct MSIX, APPX, and bundle URLs for any package on the Microsoft Store.
            Supports all identifier types — modern and legacy.
          </Body1>
        </div>

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
            title="Resolution failed"
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
                {warnings.length} note{warnings.length === 1 ? "" : "s"} from the worker
              </MessageBarTitle>
              {warnings.map((w, i) => (
                <Body1 key={i} block>
                  {w}
                </Body1>
              ))}
            </MessageBarBody>
            <MessageBarActions
              containerAction={
                <Tooltip content="Dismiss" relationship="label">
                  <Button
                    aria-label="Dismiss"
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
              <MessageBarTitle>Offline preview</MessageBarTitle>
              {notice}
            </MessageBarBody>
            <MessageBarActions
              containerAction={
                <Tooltip content="Dismiss" relationship="label">
                  <Button
                    aria-label="Dismiss"
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
            title="Resolved"
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
          <Text size={200}>Query Store Links · MSIX bundle resolver</Text>
          <Text size={200}>
            <Link
              href="https://github.com/query-store-links/qsl-worker"
              target="_blank"
              rel="noreferrer"
            >
              GitHub
            </Link>{" "}
            · © 2026 QSL
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
