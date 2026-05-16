import {
  Badge,
  Body1,
  Body1Strong,
  Button,
  Caption1,
  Drawer,
  DrawerBody,
  DrawerHeader,
  DrawerHeaderTitle,
  Text,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import {
  ArrowRightRegular,
  DeleteRegular,
  DismissRegular,
  HistoryRegular,
} from "@fluentui/react-icons";
import { ID_TYPE_BY_VALUE, type SearchFormData } from "../shared";
import { relativeTime } from "../hooks";

export interface HistoryItem extends SearchFormData {
  id: string;
  ts: number;
  resultCount?: number;
}

interface HistoryDrawerProps {
  open: boolean;
  onDismiss: () => void;
  items: HistoryItem[];
  onRun: (item: HistoryItem) => void;
  onClear: () => void;
  onRemove: (id: string) => void;
}

const useStyles = makeStyles({
  drawer: { width: "380px", maxWidth: "92vw" },
  meta: { fontSize: "12px", color: tokens.colorNeutralForeground3 },
  list: { display: "flex", flexDirection: "column", rowGap: "8px" },
  card: {
    padding: "12px",
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    display: "flex",
    flexDirection: "column",
    rowGap: "8px",
  },
  cardTop: { display: "flex", alignItems: "flex-start", columnGap: "8px" },
  cardMain: { flex: 1, minWidth: 0 },
  monoName: {
    fontSize: "12px",
    fontWeight: 600,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    display: "block",
  },
  cardMeta: {
    fontSize: "11px",
    color: tokens.colorNeutralForeground3,
    marginTop: "2px",
  },
  badgeRow: { display: "flex", flexWrap: "wrap", columnGap: "4px", rowGap: "4px" },
  actions: { display: "flex", columnGap: "6px" },
  empty: {
    textAlign: "center",
    color: tokens.colorNeutralForeground3,
    fontSize: "13px",
    padding: "48px 16px",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    rowGap: "8px",
  },
  emptyTitle: { color: tokens.colorNeutralForeground2 },
  footer: { paddingTop: "12px", borderTop: `1px solid ${tokens.colorNeutralStroke2}` },
});

export function HistoryDrawer({
  open,
  onDismiss,
  items,
  onRun,
  onClear,
  onRemove,
}: HistoryDrawerProps) {
  const styles = useStyles();
  return (
    <Drawer
      open={open}
      onOpenChange={(_, d) => !d.open && onDismiss()}
      position="end"
      className={styles.drawer}
    >
      <DrawerHeader>
        <DrawerHeaderTitle
          action={
            <Button
              appearance="subtle"
              icon={<DismissRegular />}
              aria-label="Close"
              onClick={onDismiss}
            />
          }
        >
          Recent searches
          <div className={styles.meta}>{items.length} saved · stored locally</div>
        </DrawerHeaderTitle>
      </DrawerHeader>

      <DrawerBody>
        {items.length === 0 ? (
          <div className={styles.empty}>
            <HistoryRegular fontSize={28} />
            <Body1Strong className={styles.emptyTitle}>No searches yet</Body1Strong>
            <Body1>Your resolved identifiers will appear here.</Body1>
          </div>
        ) : (
          <div className={styles.list}>
            {items.map((it) => {
              const meta = ID_TYPE_BY_VALUE[it.identifierType];
              return (
                <div key={it.id} className={styles.card}>
                  <div className={styles.cardTop}>
                    <div className={styles.cardMain}>
                      <Text className={`qsl-mono ${styles.monoName}`} title={it.productInput}>
                        {it.productInput}
                      </Text>
                      <Caption1 className={styles.cardMeta}>
                        {relativeTime(it.ts)}
                        {it.resultCount != null && <> · {it.resultCount} files</>}
                      </Caption1>
                    </div>
                    <Button
                      size="small"
                      appearance="transparent"
                      icon={<DismissRegular />}
                      aria-label="Remove"
                      onClick={() => onRemove(it.id)}
                    />
                  </div>
                  <div className={styles.badgeRow}>
                    <Badge appearance="tint" color="brand">
                      {meta.short}
                    </Badge>
                    <Badge appearance="outline">{it.ring}</Badge>
                    <Badge appearance="outline">{it.market}</Badge>
                  </div>
                  <div className={styles.actions}>
                    <Button
                      appearance="primary"
                      size="small"
                      icon={<ArrowRightRegular />}
                      iconPosition="after"
                      onClick={() => onRun(it)}
                    >
                      Re-run
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {items.length > 0 && (
          <div className={styles.footer}>
            <Button appearance="subtle" icon={<DeleteRegular />} onClick={onClear}>
              Clear all
            </Button>
          </div>
        )}
      </DrawerBody>
    </Drawer>
  );
}
