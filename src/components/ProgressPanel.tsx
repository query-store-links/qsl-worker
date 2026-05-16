import {
  Body1,
  Body1Strong,
  Button,
  Caption1,
  Card,
  ProgressBar,
  Spinner,
  Text,
  Tooltip,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { DismissRegular } from "@fluentui/react-icons";
import type { ProgressUpdate } from "../api";
import { useT } from "../i18n";

interface ProgressPanelProps {
  update: ProgressUpdate | null;
  query: string;
  onAbort: () => void;
}

// Known storelib_rs stage codes — used to decide whether to look up a
// translated label (`stage.<code>`) or fall back to the raw stage string.
const KNOWN_STAGES = new Set<string>([
  "dcat.request",
  "dcat.response",
  "dcat.parse",
  "dcat.done",
  "dcat.notFound",
  "fe3.start",
  "fe3.getCookie",
  "fe3.syncUpdates",
  "fe3.parseUpdateIds",
  "fe3.parseUpdateIds.done",
  "fe3.parsePackages",
  "fe3.parsePackages.done",
  "fe3.resolveUrls",
  "fe3.resolveUrls.done",
  "fe3.done",
  "search.request",
  "search.response",
  "search.parse",
  "search.done",
  "retry.wait",
  "retry.attempt",
]);

const useStyles = makeStyles({
  card: { padding: "16px 20px" },
  row: { display: "flex", alignItems: "center", columnGap: "12px" },
  spinnerWrap: { flexShrink: 0 },
  center: { flex: 1, minWidth: 0, display: "flex", flexDirection: "column", rowGap: "2px" },
  stageRow: { display: "flex", alignItems: "center", columnGap: "8px" },
  stageCode: {
    fontFamily: '"Cascadia Mono", "JetBrains Mono", Menlo, Consolas, monospace',
    fontSize: "10px",
    padding: "1px 6px",
    borderRadius: tokens.borderRadiusSmall,
    backgroundColor: tokens.colorNeutralBackground3,
    color: tokens.colorNeutralForeground3,
  },
  message: {
    color: tokens.colorNeutralForeground2,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  bar: { marginTop: "10px" },
  query: {
    marginTop: "2px",
    color: tokens.colorNeutralForeground3,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    display: "block",
    fontFamily: '"Cascadia Mono", "JetBrains Mono", Menlo, Consolas, monospace',
  },
});

export function ProgressPanel({ update, query, onAbort }: ProgressPanelProps) {
  const styles = useStyles();
  const t = useT();
  const label = update
    ? KNOWN_STAGES.has(update.stage)
      ? t(`stage.${update.stage}`)
      : update.stage
    : t("progress.starting");
  const counter =
    update && update.current != null && update.total != null
      ? t("progress.counter", { current: update.current, total: update.total })
      : null;

  const ratio =
    update && update.current != null && update.total != null && update.total > 0
      ? Math.min(1, update.current / update.total)
      : undefined;

  return (
    <Card className={styles.card}>
      <div className={styles.row}>
        <div className={styles.spinnerWrap}>
          <Spinner size="tiny" />
        </div>
        <div className={styles.center}>
          <div className={styles.stageRow}>
            <Body1Strong>{label}</Body1Strong>
            {update?.stage && <Text className={styles.stageCode}>{update.stage}</Text>}
            {counter && <Caption1>· {counter}</Caption1>}
          </div>
          {update?.message ? (
            <Body1 className={styles.message} title={update.message}>
              {update.message}
            </Body1>
          ) : (
            <Caption1>{t("progress.connecting")}</Caption1>
          )}
          {query && (
            <Text className={styles.query} title={query}>
              {query}
            </Text>
          )}
        </div>
        <Tooltip content={t("common.cancel")} relationship="label">
          <Button
            appearance="subtle"
            icon={<DismissRegular />}
            onClick={onAbort}
            aria-label={t("common.cancel")}
          />
        </Tooltip>
      </div>
      <ProgressBar
        className={styles.bar}
        value={ratio}
        max={1}
        thickness="medium"
        shape="rounded"
      />
    </Card>
  );
}
