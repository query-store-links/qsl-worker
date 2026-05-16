import { useEffect, useMemo, useState } from "react";
import {
  Badge,
  Body1Strong,
  Button,
  Card,
  Caption1,
  Checkbox,
  CounterBadge,
  Input,
  Tab,
  TabList,
  Table,
  TableBody,
  TableCell,
  TableCellLayout,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Text,
  Tooltip,
  makeStyles,
  mergeClasses,
  tokens,
} from "@fluentui/react-components";
import {
  ArrowDownloadRegular,
  CopyRegular,
  DismissRegular,
  DocumentRegular,
  FilterRegular,
  OpenRegular,
} from "@fluentui/react-icons";
import { formatBytes, type NormalizedItem, type PackageType } from "../shared";

type FilterKey = "all" | PackageType;
type SortKey = "name" | "size" | "type" | "arch";

interface ResultsViewProps {
  results: NormalizedItem[];
  query: string;
  onCopy: (text: string, what: string) => void;
}

const useStyles = makeStyles({
  card: {
    paddingTop: 0,
    paddingRight: 0,
    paddingBottom: 0,
    paddingLeft: 0,
    overflow: "hidden",
  },
  header: {
    padding: "16px 20px",
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    columnGap: "12px",
    rowGap: "12px",
  },
  headLeft: { minWidth: 0, flex: 1 },
  headTitle: { display: "flex", alignItems: "center", columnGap: "8px" },
  query: {
    fontSize: "12px",
    color: tokens.colorNeutralForeground3,
    marginTop: "2px",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    display: "block",
  },
  tabsWrap: {
    padding: "0 20px",
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    // Stick under the 56px TopBar so the filter tabs stay reachable while
    // scrolling a long results table.
    position: "sticky",
    top: "56px",
    zIndex: 3,
  },
  tabLabel: { display: "inline-flex", alignItems: "center", columnGap: "6px" },
  bulkBar: {
    padding: "8px 20px",
    backgroundColor: tokens.colorBrandBackground2,
    borderBottom: `1px solid ${tokens.colorBrandStroke2}`,
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    columnGap: "12px",
    // Sticks under TopBar (56) + tab strip (~42) so Copy / Download stays
    // reachable when many rows are selected.
    position: "sticky",
    top: "98px",
    zIndex: 2,
  },
  bulkLeft: {
    fontSize: "13px",
    color: tokens.colorBrandForeground1,
    fontWeight: 600,
  },
  bulkRight: { display: "flex", columnGap: "8px" },
  tableWrap: { overflowX: "auto" },
  // Sticky offset is relative to the nearest scroll container — `tableWrap`
  // becomes one because of `overflow-x: auto` (browsers promote the other
  // axis to `auto` as well). A non-zero `top` would push the header that
  // many pixels below the table's top before any scrolling occurs, which is
  // why the column titles drifted away from the top of the table. `top: 0`
  // keeps them flush with the first row.
  stickyHeaderCell: {
    position: "sticky",
    top: 0,
    zIndex: 1,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  rowSelected: { backgroundColor: tokens.colorBrandBackground2 },
  nameText: {
    fontSize: "12px",
    color: tokens.colorNeutralForeground1,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    display: "inline-block",
    maxWidth: "100%",
  },
  numCell: {
    textAlign: "right",
    color: tokens.colorNeutralForeground2,
    fontVariantNumeric: "tabular-nums",
  },
  archCell: { color: tokens.colorNeutralForeground2, fontSize: "12px" },
  actionsCell: { textAlign: "right" },
  actionGroup: {
    display: "inline-flex",
    columnGap: "4px",
    justifyContent: "flex-end",
    width: "100%",
  },
  empty: {
    padding: "32px",
    textAlign: "center",
    color: tokens.colorNeutralForeground3,
    display: "block",
  },
  filterInputWrap: { width: "220px" },
  ckShellLeft: { paddingLeft: "20px" },
  ckShellRight: { paddingRight: "20px" },
});

export function ResultsView({ results, query, onCopy }: ResultsViewProps) {
  const styles = useStyles();
  const [filter, setFilter] = useState<FilterKey>("all");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [sortKey, setSortKey] = useState<SortKey>("size");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  useEffect(() => setSelected(new Set()), [results]);

  const filtered = useMemo(() => {
    let out = results;
    if (filter !== "all") out = out.filter((r) => r.type === filter);
    if (search) {
      const q = search.toLowerCase();
      out = out.filter((r) => r.name.toLowerCase().includes(q));
    }
    out = [...out].sort((a, b) => {
      let cmp = 0;
      switch (sortKey) {
        case "name":
          cmp = a.name.localeCompare(b.name);
          break;
        case "size":
          cmp = a.sizeBytes - b.sizeBytes;
          break;
        case "type":
          cmp = a.type.localeCompare(b.type);
          break;
        case "arch":
          cmp = (a.arch ?? "").localeCompare(b.arch ?? "");
          break;
      }
      return sortDir === "asc" ? cmp : -cmp;
    });
    return out;
  }, [results, filter, search, sortKey, sortDir]);

  const totalBytes = filtered.reduce((s, r) => s + r.sizeBytes, 0);
  const selBytes = filtered.filter((r) => selected.has(r.url)).reduce((s, r) => s + r.sizeBytes, 0);

  const counts: Record<FilterKey, number> = {
    all: results.length,
    APPX: results.filter((r) => r.type === "APPX").length,
    Other: results.filter((r) => r.type === "Other").length,
    BlockMap: results.filter((r) => r.type === "BlockMap").length,
  };

  const allSelected = filtered.length > 0 && filtered.every((r) => selected.has(r.url));
  const toggleAll = () =>
    setSelected(allSelected ? new Set() : new Set(filtered.map((r) => r.url)));

  const sortableProps = (col: SortKey) => ({
    sortable: true,
    sortDirection:
      sortKey === col
        ? sortDir === "asc"
          ? ("ascending" as const)
          : ("descending" as const)
        : undefined,
    onClick: () => {
      if (sortKey === col) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
      else {
        setSortKey(col);
        setSortDir(col === "size" ? "desc" : "asc");
      }
    },
  });

  const copySelected = () => {
    const urls = filtered
      .filter((r) => selected.has(r.url))
      .map((r) => r.url)
      .join("\n");
    if (!urls) return;
    onCopy(urls, `${selected.size} URL${selected.size === 1 ? "" : "s"}`);
  };
  const downloadSelected = () => {
    filtered
      .filter((r) => selected.has(r.url))
      .forEach((r, i) => {
        setTimeout(() => {
          const a = document.createElement("a");
          a.href = r.url;
          a.download = r.name;
          a.target = "_blank";
          a.rel = "noreferrer";
          document.body.appendChild(a);
          a.click();
          a.remove();
        }, i * 80);
      });
  };

  const tabs: { v: FilterKey; l: string }[] = [
    { v: "all", l: "All" },
    { v: "APPX", l: "APPX" },
    { v: "Other", l: "Other" },
    { v: "BlockMap", l: "BlockMap" },
  ];

  return (
    <Card className={styles.card}>
      <div className={styles.header}>
        <div className={styles.headLeft}>
          <div className={styles.headTitle}>
            <Body1Strong>
              {results.length} file{results.length === 1 ? "" : "s"}
            </Body1Strong>
            <Caption1>·</Caption1>
            <Caption1>{formatBytes(totalBytes)} total</Caption1>
          </div>
          {query && (
            <Text className={`qsl-mono ${styles.query}`} title={query}>
              {query}
            </Text>
          )}
        </div>
        <div className={styles.filterInputWrap}>
          <Input
            size="small"
            placeholder="Filter file names"
            value={search}
            onChange={(_, d) => setSearch(d.value)}
            contentBefore={<FilterRegular />}
            contentAfter={
              search ? (
                <Button
                  size="small"
                  appearance="transparent"
                  icon={<DismissRegular />}
                  aria-label="Clear"
                  onClick={() => setSearch("")}
                />
              ) : null
            }
          />
        </div>
      </div>

      <div className={styles.tabsWrap}>
        <TabList
          selectedValue={filter}
          onTabSelect={(_, d) => setFilter(d.value as FilterKey)}
          appearance="transparent"
        >
          {tabs.map(({ v, l }) => {
            const c = counts[v];
            if (c === 0 && v !== "all") return null;
            return (
              <Tab key={v} value={v}>
                <span className={styles.tabLabel}>
                  <Text>{l}</Text>
                  <CounterBadge
                    count={c}
                    appearance={filter === v ? "filled" : "ghost"}
                    color={filter === v ? "brand" : "informative"}
                    size="small"
                  />
                </span>
              </Tab>
            );
          })}
        </TabList>
      </div>

      {selected.size > 0 && (
        <div className={styles.bulkBar}>
          <Text className={styles.bulkLeft}>
            {selected.size} selected · {formatBytes(selBytes)}
          </Text>
          <div className={styles.bulkRight}>
            <Button appearance="subtle" size="small" icon={<CopyRegular />} onClick={copySelected}>
              Copy URLs
            </Button>
            <Button
              appearance="primary"
              size="small"
              icon={<ArrowDownloadRegular />}
              onClick={downloadSelected}
            >
              Download all
            </Button>
            <Button appearance="subtle" size="small" onClick={() => setSelected(new Set())}>
              Clear
            </Button>
          </div>
        </div>
      )}

      <div className={styles.tableWrap}>
        <Table size="small" aria-label="Resolved packages">
          <TableHeader>
            <TableRow>
              <TableHeaderCell
                className={mergeClasses(styles.ckShellLeft, styles.stickyHeaderCell)}
                style={{ width: 56 }}
              >
                <Checkbox checked={allSelected} onChange={toggleAll} aria-label="Select all" />
              </TableHeaderCell>
              <TableHeaderCell
                {...sortableProps("name")}
                className={styles.stickyHeaderCell}
                style={{ minWidth: 280 }}
              >
                File name
              </TableHeaderCell>
              <TableHeaderCell
                {...sortableProps("type")}
                className={styles.stickyHeaderCell}
                style={{ width: 110 }}
              >
                Type
              </TableHeaderCell>
              <TableHeaderCell
                {...sortableProps("arch")}
                className={styles.stickyHeaderCell}
                style={{ width: 90 }}
              >
                Arch
              </TableHeaderCell>
              <TableHeaderCell
                {...sortableProps("size")}
                className={styles.stickyHeaderCell}
                style={{ width: 110 }}
              >
                <Text className={styles.numCell} block>
                  Size
                </Text>
              </TableHeaderCell>
              <TableHeaderCell
                className={mergeClasses(styles.ckShellRight, styles.stickyHeaderCell)}
                style={{ width: 130 }}
              >
                <Text className={styles.actionsCell} block>
                  Actions
                </Text>
              </TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6}>
                  <Text className={styles.empty} block>
                    No files match this filter.
                  </Text>
                </TableCell>
              </TableRow>
            ) : (
              filtered.map((r) => (
                <ResultRow
                  key={r.url}
                  item={r}
                  selected={selected.has(r.url)}
                  onToggle={() =>
                    setSelected((p) => {
                      const n = new Set(p);
                      if (n.has(r.url)) n.delete(r.url);
                      else n.add(r.url);
                      return n;
                    })
                  }
                  onCopy={onCopy}
                />
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </Card>
  );
}

function ResultRow({
  item,
  selected,
  onToggle,
  onCopy,
}: {
  item: NormalizedItem;
  selected: boolean;
  onToggle: () => void;
  onCopy: (text: string, what: string) => void;
}) {
  const styles = useStyles();
  const badgeColor: "brand" | "warning" | "informative" =
    item.type === "APPX" ? "brand" : item.type === "BlockMap" ? "informative" : "warning";

  return (
    <TableRow className={selected ? styles.rowSelected : undefined}>
      <TableCell className={styles.ckShellLeft}>
        <Checkbox checked={selected} onChange={onToggle} aria-label={`Select ${item.name}`} />
      </TableCell>
      <TableCell style={{ minWidth: 0 }}>
        <TableCellLayout
          truncate
          media={
            <DocumentRegular fontSize={16} style={{ color: tokens.colorNeutralForeground3 }} />
          }
        >
          <Text className={`qsl-mono ${styles.nameText}`} title={item.name}>
            {item.name}
          </Text>
        </TableCellLayout>
      </TableCell>
      <TableCell>
        <Badge appearance="tint" color={badgeColor}>
          {item.type}
        </Badge>
      </TableCell>
      <TableCell>
        <Text className={`qsl-mono ${styles.archCell}`}>{item.arch ?? "—"}</Text>
      </TableCell>
      <TableCell>
        <Text className={styles.numCell} block>
          {item.size}
        </Text>
      </TableCell>
      <TableCell className={styles.ckShellRight}>
        <span className={styles.actionGroup}>
          <Tooltip content="Copy URL" relationship="label">
            <Button
              appearance="subtle"
              size="small"
              icon={<CopyRegular />}
              aria-label="Copy URL"
              onClick={() => onCopy(item.url, item.name)}
            />
          </Tooltip>
          <Tooltip content="Download" relationship="label">
            <Button
              appearance="subtle"
              size="small"
              icon={<ArrowDownloadRegular />}
              aria-label="Download"
              onClick={() => {
                const a = document.createElement("a");
                a.href = item.url;
                a.download = item.name;
                a.target = "_blank";
                a.rel = "noreferrer";
                document.body.appendChild(a);
                a.click();
                a.remove();
              }}
            />
          </Tooltip>
          <Tooltip content="Open in new tab" relationship="label">
            <Button
              appearance="subtle"
              size="small"
              icon={<OpenRegular />}
              aria-label="Open"
              onClick={() => window.open(item.url, "_blank")}
            />
          </Tooltip>
        </span>
      </TableCell>
    </TableRow>
  );
}
