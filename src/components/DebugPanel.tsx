import { useState, type ReactNode } from "react";
import {
  Accordion,
  AccordionHeader,
  AccordionItem,
  AccordionPanel,
  Body1,
  Body1Strong,
  Button,
  Caption1,
  Card,
  Link,
  MessageBar,
  MessageBarActions,
  MessageBarBody,
  MessageBarTitle,
  Text,
  Tooltip,
  makeStyles,
  mergeClasses,
  tokens,
} from "@fluentui/react-components";
import {
  ChevronDownRegular,
  ChevronRightRegular,
  ClipboardRegular,
  CopyRegular,
  DismissRegular,
  ErrorCircleRegular,
  InfoRegular,
} from "@fluentui/react-icons";
import type { BackendError, CodedClientError } from "../api";
import { translateApiCode, useT, type TFn } from "../i18n";
import type { ApiCode } from "../shared";

interface DebugPanelProps {
  title: string;
  error: BackendError | CodedClientError | Error | null;
  warnings: ApiCode[];
  debug: Record<string, unknown> | null;
  onDismiss: () => void;
  onCopy: (text: string, label: string) => void;
  /** Visual treatment. `error` is the loud red MessageBar; `info` is a quiet
   * inline disclosure used to surface successful-response diagnostics next to
   * results. */
  intent?: "error" | "info";
  /** Override the caption under the title. Only used in `error` mode. */
  subtitle?: ReactNode;
  /** Whether the body starts expanded. Defaults to expanded for `error`,
   * collapsed for `info`. */
  startOpen?: boolean;
}

const useStyles = makeStyles({
  warnRow: { display: "flex", flexDirection: "column", rowGap: "6px" },
  details: { padding: "16px", display: "flex", flexDirection: "column", rowGap: "12px" },
  block: {
    fontFamily: '"Cascadia Mono", "JetBrains Mono", Menlo, Consolas, monospace',
    fontSize: "12px",
    lineHeight: "18px",
    backgroundColor: tokens.colorNeutralBackground3,
    color: tokens.colorNeutralForeground1,
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRight: `1px solid ${tokens.colorNeutralStroke2}`,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    borderLeft: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    padding: "10px 12px",
    overflowX: "auto",
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
  },
  row: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    columnGap: "8px",
  },
  panelHeader: { display: "flex", alignItems: "center", columnGap: "8px" },
  pre: {
    margin: 0,
    fontFamily: "inherit",
    fontSize: "inherit",
    lineHeight: "inherit",
  },

  // Two-column key/value table used by both intents to surface the
  // most-useful diagnostic fields without making the user parse JSON.
  factsGrid: {
    display: "grid",
    gridTemplateColumns: "minmax(110px, max-content) minmax(0, 1fr)",
    columnGap: "12px",
    rowGap: "6px",
    alignItems: "baseline",
  },
  factKey: {
    color: tokens.colorNeutralForeground3,
    fontSize: "12px",
    textTransform: "uppercase",
    letterSpacing: "0.04em",
  },
  factValue: {
    fontSize: "12px",
    color: tokens.colorNeutralForeground1,
    overflowWrap: "anywhere",
  },
  factValueMono: {
    fontSize: "12px",
    color: tokens.colorNeutralForeground1,
    overflowWrap: "anywhere",
    fontFamily: '"Cascadia Mono", "JetBrains Mono", Menlo, Consolas, monospace',
  },
  statusOk: { color: tokens.colorPaletteGreenForeground1, fontWeight: 600 },
  statusBad: { color: tokens.colorPaletteDarkOrangeForeground1, fontWeight: 600 },

  // Disclosure for the raw JSON inside the diagnostic body.
  dumpToggle: {
    alignSelf: "flex-start",
    paddingLeft: "4px",
    paddingRight: "4px",
    color: tokens.colorNeutralForeground2,
  },

  // Info-mode layout: a quiet inline disclosure rather than a MessageBar +
  // Card + Accordion stack.
  infoCard: {
    paddingTop: 0,
    paddingRight: 0,
    paddingBottom: 0,
    paddingLeft: 0,
    backgroundColor: tokens.colorNeutralBackground2,
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRight: `1px solid ${tokens.colorNeutralStroke2}`,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    borderLeft: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    boxShadow: "none",
    overflow: "hidden",
  },
  infoHeader: {
    display: "flex",
    alignItems: "center",
    columnGap: "8px",
    padding: "6px 8px 6px 10px",
  },
  infoToggle: {
    flex: 1,
    minWidth: 0,
    justifyContent: "flex-start",
    columnGap: "8px",
    fontWeight: 600,
    color: tokens.colorNeutralForeground2,
    paddingLeft: "4px",
    paddingRight: "4px",
  },
  infoMeta: {
    color: tokens.colorNeutralForeground3,
    fontSize: "12px",
    marginRight: "4px",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    maxWidth: "320px",
  },
  infoBody: {
    padding: "12px 14px 14px",
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
    display: "flex",
    flexDirection: "column",
    rowGap: "12px",
  },
});

export function DebugPanel({
  title,
  error,
  warnings,
  debug,
  onDismiss,
  onCopy,
  intent = "error",
  subtitle,
  startOpen,
}: DebugPanelProps) {
  const t = useT();
  const facts = collectFacts(error, debug, t);
  const dump = buildDump(error, warnings, debug);

  if (intent === "info") {
    return (
      <InfoDebug
        title={title}
        facts={facts}
        dump={dump}
        startOpen={startOpen ?? false}
        onDismiss={onDismiss}
        onCopy={onCopy}
        t={t}
      />
    );
  }

  return (
    <ErrorDebug
      title={title}
      error={error}
      warnings={warnings}
      subtitle={subtitle}
      facts={facts}
      dump={dump}
      startOpen={startOpen ?? true}
      onDismiss={onDismiss}
      onCopy={onCopy}
      t={t}
    />
  );
}

// ── error variant (loud MessageBar with accordion) ─────────────────────────

interface ErrorDebugProps {
  title: string;
  error: BackendError | CodedClientError | Error | null;
  warnings: ApiCode[];
  subtitle?: ReactNode;
  facts: Fact[];
  dump: string;
  startOpen: boolean;
  onDismiss: () => void;
  onCopy: (text: string, label: string) => void;
  t: TFn;
}

function ErrorDebug({
  title,
  error,
  warnings,
  subtitle,
  facts,
  dump,
  startOpen,
  onDismiss,
  onCopy,
  t,
}: ErrorDebugProps) {
  const styles = useStyles();
  const [openIds, setOpenIds] = useState<string[]>(startOpen ? ["summary"] : []);
  const message = renderErrorMessage(error, t);
  const bundleLabel = t("debug.bundleLabel");

  return (
    <MessageBar intent="error" politeness="assertive">
      <MessageBarBody>
        <MessageBarTitle>{title}</MessageBarTitle>
        <Body1 block>{message ?? t("debug.unknownError")}</Body1>
        {subtitle}

        <Card appearance="subtle">
          <Accordion
            multiple
            collapsible
            openItems={openIds}
            onToggle={(_, d) => setOpenIds(d.openItems as string[])}
          >
            {warnings.length > 0 && (
              <AccordionItem value="warnings">
                <AccordionHeader expandIconPosition="end">
                  <div className={styles.panelHeader}>
                    <ErrorCircleRegular />
                    <Body1Strong>
                      {t(
                        warnings.length === 1
                          ? "debug.warnings.count"
                          : "debug.warnings.count.plural",
                        { count: warnings.length },
                      )}
                    </Body1Strong>
                  </div>
                </AccordionHeader>
                <AccordionPanel>
                  <div className={styles.warnRow}>
                    {warnings.map((w, i) => (
                      <Body1 key={i}>{translateApiCode(t, w)}</Body1>
                    ))}
                  </div>
                </AccordionPanel>
              </AccordionItem>
            )}

            <AccordionItem value="summary">
              <AccordionHeader expandIconPosition="end">
                <Body1Strong>{t("debug.diagnostics")}</Body1Strong>
              </AccordionHeader>
              <AccordionPanel>
                <div className={styles.details}>
                  {facts.length > 0 && <FactGrid facts={facts} />}
                  <RawDump
                    dump={dump}
                    onCopy={() => onCopy(dump, bundleLabel)}
                    initiallyOpen
                    t={t}
                  />
                  {isBackendError(error) && (
                    <Body1>
                      {t("debug.endpoint")}{" "}
                      <Link href={error.endpoint} target="_blank" rel="noreferrer">
                        {error.endpoint}
                      </Link>
                    </Body1>
                  )}
                </div>
              </AccordionPanel>
            </AccordionItem>
          </Accordion>
        </Card>
      </MessageBarBody>
      <MessageBarActions
        containerAction={
          <Tooltip content={t("common.dismiss")} relationship="label">
            <Button
              aria-label={t("common.dismiss")}
              appearance="transparent"
              icon={<DismissRegular />}
              onClick={onDismiss}
            />
          </Tooltip>
        }
      >
        <Tooltip content={t("debug.copyDiagnostics")} relationship="label">
          <Button
            aria-label={t("debug.copyDiagnostics")}
            appearance="transparent"
            icon={<ClipboardRegular />}
            onClick={() => onCopy(dump, bundleLabel)}
          />
        </Tooltip>
      </MessageBarActions>
    </MessageBar>
  );
}

// ── info variant (quiet inline disclosure) ─────────────────────────────────

interface InfoDebugProps {
  title: string;
  facts: Fact[];
  dump: string;
  startOpen: boolean;
  onDismiss: () => void;
  onCopy: (text: string, label: string) => void;
  t: TFn;
}

function InfoDebug({ title, facts, dump, startOpen, onDismiss, onCopy, t }: InfoDebugProps) {
  const styles = useStyles();
  const [open, setOpen] = useState(startOpen);
  const meta = facts
    .filter((f) => f.key === "idType" || f.key === "tag" || f.key === "market")
    .map((f) => f.value)
    .join(" · ");
  const bundleLabel = t("debug.bundleLabel");

  return (
    <div className={styles.infoCard} role="group" aria-label={title}>
      <div className={styles.infoHeader}>
        <Button
          appearance="subtle"
          size="small"
          icon={open ? <ChevronDownRegular /> : <ChevronRightRegular />}
          className={styles.infoToggle}
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
        >
          <InfoRegular fontSize={14} />
          <Text size={200} weight="semibold">
            {title}
          </Text>
        </Button>
        {meta && (
          <Text className={mergeClasses("qsl-mono", styles.infoMeta)} title={meta}>
            {meta}
          </Text>
        )}
        <Tooltip content={t("debug.copyDiagnostics")} relationship="label">
          <Button
            appearance="subtle"
            size="small"
            icon={<ClipboardRegular />}
            aria-label={t("debug.copyDiagnostics")}
            onClick={() => onCopy(dump, bundleLabel)}
          />
        </Tooltip>
        <Tooltip content={t("debug.hide")} relationship="label">
          <Button
            appearance="subtle"
            size="small"
            icon={<DismissRegular />}
            aria-label={t("debug.hideDiagnostics")}
            onClick={onDismiss}
          />
        </Tooltip>
      </div>
      {open && (
        <div className={styles.infoBody}>
          {facts.length > 0 && <FactGrid facts={facts} />}
          <RawDump dump={dump} onCopy={() => onCopy(dump, bundleLabel)} t={t} />
        </div>
      )}
    </div>
  );
}

// ── shared sub-components ──────────────────────────────────────────────────

function FactGrid({ facts }: { facts: Fact[] }) {
  const styles = useStyles();
  return (
    <div className={styles.factsGrid}>
      {facts.map((f) => (
        <FactRow key={f.key} fact={f} />
      ))}
    </div>
  );
}

function FactRow({ fact }: { fact: Fact }) {
  const styles = useStyles();
  return (
    <>
      <Caption1 className={styles.factKey}>{fact.label}</Caption1>
      <Text
        className={
          fact.tone === "ok"
            ? mergeClasses(styles.factValue, styles.statusOk)
            : fact.tone === "bad"
              ? mergeClasses(styles.factValue, styles.statusBad)
              : fact.mono
                ? styles.factValueMono
                : styles.factValue
        }
        title={typeof fact.value === "string" ? fact.value : undefined}
      >
        {fact.value}
      </Text>
    </>
  );
}

function RawDump({
  dump,
  onCopy,
  initiallyOpen = false,
  t,
}: {
  dump: string;
  onCopy: () => void;
  initiallyOpen?: boolean;
  t: TFn;
}) {
  const styles = useStyles();
  const [open, setOpen] = useState(initiallyOpen);
  return (
    <>
      <div className={styles.row}>
        <Button
          appearance="subtle"
          size="small"
          icon={open ? <ChevronDownRegular /> : <ChevronRightRegular />}
          className={styles.dumpToggle}
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
        >
          {t("debug.rawJson")}
        </Button>
        <Tooltip content={t("common.copyClipboard")} relationship="label">
          <Button size="small" appearance="subtle" icon={<CopyRegular />} onClick={onCopy}>
            {t("common.copy")}
          </Button>
        </Tooltip>
      </div>
      {open && (
        <div className={styles.block}>
          <pre className={styles.pre}>{dump}</pre>
        </div>
      )}
    </>
  );
}

// ── helpers ────────────────────────────────────────────────────────────────

interface Fact {
  key: string;
  label: string;
  value: string;
  mono?: boolean;
  tone?: "ok" | "bad";
}

function collectFacts(
  error: BackendError | CodedClientError | Error | null,
  debug: Record<string, unknown> | null,
  t: TFn,
): Fact[] {
  const out: Fact[] = [];
  const seen = new Set<string>();
  const push = (key: string, label: string, value: unknown, opts: Partial<Fact> = {}) => {
    if (value == null || value === "" || seen.has(key)) return;
    out.push({ key, label, value: String(value), ...opts });
    seen.add(key);
  };

  if (isBackendError(error)) {
    push("endpoint", t("debug.fact.endpoint"), error.endpoint, { mono: true });
    if (typeof error.status === "number") {
      push("status", t("debug.fact.http"), error.status, {
        tone: error.status >= 400 || error.status === 0 ? "bad" : "ok",
      });
    }
    const req = error.requestBody as Record<string, unknown> | null | undefined;
    if (req) {
      push("productInput", t("debug.fact.input"), req.ProductInput, { mono: true });
      push("idType", t("debug.fact.type"), req.IdentifierType);
      push("market", t("debug.fact.market"), req.Market);
      push("tag", t("debug.fact.locale"), req.Locale ?? req.Language);
    }
  }

  if (debug) {
    push("productInput", t("debug.fact.input"), debug.productInput, { mono: true });
    push("idType", t("debug.fact.type"), debug.idType);
    push("market", t("debug.fact.market"), debug.market);
    push("tag", t("debug.fact.locale"), debug.tag);
    push("kind", t("debug.fact.kind"), debug.kind);
    push("handlerError", t("debug.fact.handler"), debug.handlerError);
  }

  return out;
}

function buildDump(
  error: BackendError | CodedClientError | Error | null,
  warnings: ApiCode[],
  debug: Record<string, unknown> | null,
): string {
  const parts: Record<string, unknown> = {};
  if (error) {
    parts.error = {
      name: error.name,
      message: cleanErrorMessage(error.message) ?? error.message,
      ...(hasErrorCodes(error) ? { errors: error.errors } : {}),
      ...(isBackendError(error)
        ? {
            status: error.status,
            endpoint: error.endpoint,
            requestBody: error.requestBody,
            response: error.response,
          }
        : {}),
    };
  }
  if (warnings.length) parts.warnings = warnings;
  // Drop `debug` from the dump when the same payload is already nested
  // under `error.response.Debug`. Otherwise the same object appears twice
  // and bloats the diagnostic bundle.
  if (debug && !debugMatchesResponse(debug, error)) {
    parts.debug = debug;
  }
  return JSON.stringify(parts, null, 2);
}

function debugMatchesResponse(
  debug: Record<string, unknown>,
  error: BackendError | CodedClientError | Error | null,
): boolean {
  if (!isBackendError(error)) return false;
  const respDebug = (error.response as { Debug?: unknown } | null)?.Debug;
  if (!respDebug || typeof respDebug !== "object") return false;
  try {
    return JSON.stringify(respDebug) === JSON.stringify(debug);
  } catch {
    return false;
  }
}

// Backend errors are sometimes wrapped through several layers and arrive
// looking like `Product lookup failed: Error: Error: <message>`. Collapse the
// runs so the user-facing line reads naturally.
function cleanErrorMessage(msg: string | undefined): string | undefined {
  if (!msg) return msg;
  return msg.replace(/(?:\bError:\s*){2,}/g, "");
}

function isBackendError(e: unknown): e is BackendError {
  return e != null && typeof e === "object" && (e as { name?: string }).name === "BackendError";
}

function hasErrorCodes(e: unknown): e is { errors: ApiCode[] } {
  return e != null && typeof e === "object" && Array.isArray((e as { errors?: unknown }).errors);
}

/** Resolve an error to a user-facing message. Coded errors get translated to
 *  the active locale; raw `Error`s (network failures, unexpected throws) fall
 *  back to their `.message`. */
function renderErrorMessage(
  error: BackendError | CodedClientError | Error | null,
  t: TFn,
): string | undefined {
  if (!error) return undefined;
  if (hasErrorCodes(error) && error.errors.length > 0) {
    return error.errors.map((c) => translateApiCode(t, c)).join(" · ");
  }
  return cleanErrorMessage(error.message);
}
