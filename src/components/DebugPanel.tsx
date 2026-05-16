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
import type { BackendError } from "../api";

interface DebugPanelProps {
  title: string;
  error: BackendError | Error | null;
  warnings: string[];
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

  // Info-mode layout: a quiet inline disclosure rather than a MessageBar +
  // Card + Accordion stack. One header row (chevron · label · meta · actions),
  // optional body underneath only when expanded.
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
    padding: "10px 12px 12px",
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
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
  const dump = buildDump(error, warnings, debug);

  if (intent === "info") {
    return (
      <InfoDebug
        title={title}
        debug={debug}
        dump={dump}
        startOpen={startOpen ?? false}
        onDismiss={onDismiss}
        onCopy={onCopy}
      />
    );
  }

  return (
    <ErrorDebug
      title={title}
      error={error}
      warnings={warnings}
      subtitle={subtitle}
      dump={dump}
      startOpen={startOpen ?? true}
      onDismiss={onDismiss}
      onCopy={onCopy}
    />
  );
}

// ── error variant (loud MessageBar with accordion) ─────────────────────────

interface ErrorDebugProps {
  title: string;
  error: BackendError | Error | null;
  warnings: string[];
  subtitle?: ReactNode;
  dump: string;
  startOpen: boolean;
  onDismiss: () => void;
  onCopy: (text: string, label: string) => void;
}

function ErrorDebug({
  title,
  error,
  warnings,
  subtitle,
  dump,
  startOpen,
  onDismiss,
  onCopy,
}: ErrorDebugProps) {
  const styles = useStyles();
  const [openIds, setOpenIds] = useState<string[]>(startOpen ? ["summary"] : []);

  return (
    <MessageBar intent="error" politeness="assertive">
      <MessageBarBody>
        <MessageBarTitle>{title}</MessageBarTitle>
        <Body1 block>{error?.message ?? "An unknown error occurred."}</Body1>
        {subtitle ?? (
          <Caption1 block>
            Showing sample data below so you can keep working. Expand{" "}
            <Text weight="semibold">Diagnostics</Text> for what the worker tried.
          </Caption1>
        )}

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
                      {warnings.length} warning{warnings.length === 1 ? "" : "s"}
                    </Body1Strong>
                  </div>
                </AccordionHeader>
                <AccordionPanel>
                  <div className={styles.warnRow}>
                    {warnings.map((w, i) => (
                      <Body1 key={i}>{w}</Body1>
                    ))}
                  </div>
                </AccordionPanel>
              </AccordionItem>
            )}

            <AccordionItem value="summary">
              <AccordionHeader expandIconPosition="end">
                <Body1Strong>Diagnostics</Body1Strong>
              </AccordionHeader>
              <AccordionPanel>
                <div className={styles.details}>
                  <div className={styles.row}>
                    <Caption1>
                      Copy this to a bug report — it includes the request, the raw response, and the
                      storelib_rs debug fields.
                    </Caption1>
                    <Tooltip content="Copy to clipboard" relationship="label">
                      <Button
                        size="small"
                        appearance="subtle"
                        icon={<CopyRegular />}
                        onClick={() => onCopy(dump, "diagnostic bundle")}
                      >
                        Copy
                      </Button>
                    </Tooltip>
                  </div>
                  <div className={styles.block}>
                    <pre className={styles.pre}>{dump}</pre>
                  </div>
                  {isBackendError(error) && (
                    <Body1>
                      Endpoint:{" "}
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
          <Tooltip content="Dismiss" relationship="label">
            <Button
              aria-label="Dismiss"
              appearance="transparent"
              icon={<DismissRegular />}
              onClick={onDismiss}
            />
          </Tooltip>
        }
      >
        <Tooltip content="Copy diagnostics" relationship="label">
          <Button
            aria-label="Copy diagnostics"
            appearance="transparent"
            icon={<ClipboardRegular />}
            onClick={() => onCopy(dump, "diagnostic bundle")}
          />
        </Tooltip>
      </MessageBarActions>
    </MessageBar>
  );
}

// ── info variant (quiet inline disclosure) ─────────────────────────────────

interface InfoDebugProps {
  title: string;
  debug: Record<string, unknown> | null;
  dump: string;
  startOpen: boolean;
  onDismiss: () => void;
  onCopy: (text: string, label: string) => void;
}

function InfoDebug({ title, debug, dump, startOpen, onDismiss, onCopy }: InfoDebugProps) {
  const styles = useStyles();
  const [open, setOpen] = useState(startOpen);
  const meta = summariseDebug(debug);

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
        <Tooltip content="Copy diagnostics" relationship="label">
          <Button
            appearance="subtle"
            size="small"
            icon={<ClipboardRegular />}
            aria-label="Copy diagnostics"
            onClick={() => onCopy(dump, "diagnostic bundle")}
          />
        </Tooltip>
        <Tooltip content="Hide" relationship="label">
          <Button
            appearance="subtle"
            size="small"
            icon={<DismissRegular />}
            aria-label="Hide diagnostics"
            onClick={onDismiss}
          />
        </Tooltip>
      </div>
      {open && (
        <div className={styles.infoBody}>
          <div className={styles.block}>
            <pre className={styles.pre}>{dump}</pre>
          </div>
        </div>
      )}
    </div>
  );
}

// ── helpers ────────────────────────────────────────────────────────────────

function buildDump(
  error: BackendError | Error | null,
  warnings: string[],
  debug: Record<string, unknown> | null,
): string {
  const parts: Record<string, unknown> = {};
  if (error) {
    parts.error = {
      name: error.name,
      message: error.message,
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
  if (debug) parts.debug = debug;
  return JSON.stringify(parts, null, 2);
}

// Pull a few high-signal fields out of the debug bag so the collapsed
// header carries information instead of just the word "Diagnostics".
function summariseDebug(debug: Record<string, unknown> | null): string | null {
  if (!debug) return null;
  const bits: string[] = [];
  const get = (k: string): string | null => {
    const v = debug[k];
    return typeof v === "string" && v ? v : null;
  };
  const tag = get("tag");
  const market = get("market");
  const idType = get("idType");
  if (idType) bits.push(idType);
  if (tag) bits.push(tag);
  else if (market) bits.push(market);
  return bits.length ? bits.join(" · ") : null;
}

function isBackendError(e: unknown): e is BackendError {
  return e != null && typeof e === "object" && (e as { name?: string }).name === "BackendError";
}
