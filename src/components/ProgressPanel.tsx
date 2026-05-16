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

interface ProgressPanelProps {
  update: ProgressUpdate | null;
  query: string;
  onAbort: () => void;
}

// User-friendly labels for each storelib_rs stage. Kept in one place so the
// table reads top-to-bottom in the rough order they fire.
const STAGE_LABELS: Record<string, string> = {
  "dcat.request": "Querying Microsoft Store catalog",
  "dcat.response": "Receiving catalog response",
  "dcat.parse": "Parsing catalog data",
  "dcat.done": "Product found",
  "dcat.notFound": "Product not found",
  "fe3.start": "Starting package resolution",
  "fe3.getCookie": "Authenticating with FE3",
  "fe3.syncUpdates": "Requesting package updates",
  "fe3.parseUpdateIds": "Reading update IDs",
  "fe3.parseUpdateIds.done": "Found update IDs",
  "fe3.parsePackages": "Reading package metadata",
  "fe3.parsePackages.done": "Parsed packages",
  "fe3.resolveUrls": "Resolving download URLs",
  "fe3.resolveUrls.done": "Resolved download URLs",
  "fe3.done": "Package resolution complete",
  "search.request": "Sending search query",
  "search.response": "Receiving search response",
  "search.parse": "Parsing search response",
  "search.done": "Search complete",
  "retry.wait": "Waiting before retry",
  "retry.attempt": "Retrying request",
};

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
  const label = update ? (STAGE_LABELS[update.stage] ?? update.stage) : "Starting";
  const counter =
    update && update.current != null && update.total != null
      ? `${update.current} of ${update.total}`
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
            <Caption1>Connecting to the worker…</Caption1>
          )}
          {query && (
            <Text className={styles.query} title={query}>
              {query}
            </Text>
          )}
        </div>
        <Tooltip content="Cancel" relationship="label">
          <Button
            appearance="subtle"
            icon={<DismissRegular />}
            onClick={onAbort}
            aria-label="Cancel"
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
