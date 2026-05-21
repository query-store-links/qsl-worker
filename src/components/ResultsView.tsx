import { useMemo, useState } from "react";
import {
  Badge,
  Body1Strong,
  Button,
  Card,
  Caption1,
  Checkbox,
  CounterBadge,
  Input,
  Menu,
  MenuItem,
  MenuList,
  MenuPopover,
  MenuTrigger,
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
  WindowConsoleRegular,
} from "@fluentui/react-icons";
import { formatBytes, type AppInfo, type NormalizedItem, type PackageType } from "../shared";
import { useT, type TFn } from "../i18n";

type FilterKey = "all" | PackageType;
type SortKey = "name" | "size" | "type" | "arch";

type Shell = "powershell" | "cmd" | "bash";
type HashAlgo = "sha256" | "sha1";

function buildVerifyCommand(
  shell: Shell,
  algo: HashAlgo,
  file: string,
  hash: string,
): string {
  // Get-FileHash / certutil want the wire-style label (SHA256 / SHA1);
  // sha*sum is two separate binaries.
  const psAlgo = algo === "sha256" ? "SHA256" : "SHA1";
  const certutilAlgo = psAlgo;
  const sumBin = algo === "sha256" ? "sha256sum" : "sha1sum";
  switch (shell) {
    case "powershell": {
      // Single-quoted PS strings escape an embedded quote by doubling it.
      const f = file.replace(/'/g, "''");
      return `if ((Get-FileHash -Algorithm ${psAlgo} '${f}').Hash -ieq '${hash}') { 'OK' } else { 'MISMATCH' }`;
    }
    case "cmd": {
      // CMD has no general escape for `"` inside quoted args; doubling works
      // for most consumers and is the convention certutil accepts.
      const f = file.replace(/"/g, '""');
      return `certutil -hashfile "${f}" ${certutilAlgo} | find /i "${hash}" >NUL && echo OK || echo MISMATCH`;
    }
    case "bash": {
      // sha*sum -c expects "<hash><space><space><file>"; close the single
      // quote, insert an escaped literal, and re-open for any `'` in the name.
      const f = file.replace(/'/g, "'\\''");
      return `echo '${hash}  ${f}' | ${sumBin} -c -`;
    }
  }
}

interface ResultsViewProps {
  results: NormalizedItem[];
  query: string;
  appInfo: AppInfo | null;
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
    "@media (max-width: 600px)": {
      padding: "12px 16px",
    },
  },
  // On narrow viewports force `headLeft` onto its own row so the 220px filter
  // input drops below the title block instead of squeezing the Category chip
  // into a 4-line ID stack.
  headLeft: {
    minWidth: 0,
    flex: 1,
    "@media (max-width: 600px)": {
      flexBasis: "100%",
    },
  },
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
    "@media (max-width: 600px)": {
      padding: "0 12px",
    },
  },
  tabLabel: { display: "inline-flex", alignItems: "center", columnGap: "6px" },
  bulkBar: {
    padding: "8px 20px",
    backgroundColor: tokens.colorBrandBackground2,
    borderBottom: `1px solid ${tokens.colorBrandStroke2}`,
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    columnGap: "12px",
    rowGap: "8px",
    // Sticks under TopBar (56) + tab strip (~42) so Copy / Download stays
    // reachable when many rows are selected.
    position: "sticky",
    top: "98px",
    zIndex: 2,
    "@media (max-width: 600px)": {
      padding: "8px 12px",
    },
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
  nameStack: { display: "flex", flexDirection: "column", minWidth: 0 },
  hashLine: {
    display: "inline-flex",
    alignItems: "center",
    columnGap: "6px",
    marginTop: "2px",
    alignSelf: "flex-start",
  },
  hashRow: {
    display: "inline-flex",
    alignItems: "center",
    columnGap: "4px",
    fontSize: "11px",
    color: tokens.colorNeutralForeground3,
    cursor: "pointer",
    border: "none",
    background: "transparent",
    padding: 0,
    fontFamily: "inherit",
    "&:hover": { color: tokens.colorNeutralForeground2 },
  },
  hashLabel: { color: tokens.colorNeutralForeground4 },
  metaChip: {
    display: "inline-flex",
    alignItems: "center",
    columnGap: "6px",
    marginTop: "4px",
    fontSize: "11px",
    color: tokens.colorNeutralForeground3,
    cursor: "pointer",
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusSmall,
    padding: "1px 6px",
    backgroundColor: "transparent",
    fontFamily: "inherit",
    // Cap the chip at its container so a long GUID truncates instead of
    // wrapping the value across multiple lines on narrow viewports.
    maxWidth: "100%",
    minWidth: 0,
    overflow: "hidden",
    "&:hover": {
      backgroundColor: tokens.colorNeutralBackground1Hover,
      color: tokens.colorNeutralForeground2,
    },
  },
  metaLabel: { color: tokens.colorNeutralForeground4, flexShrink: 0 },
  metaValue: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    minWidth: 0,
  },
  verifyBtn: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: "18px",
    height: "18px",
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusSmall,
    backgroundColor: "transparent",
    color: tokens.colorNeutralForeground3,
    cursor: "pointer",
    padding: 0,
    "&:hover": {
      backgroundColor: tokens.colorNeutralBackground1Hover,
      color: tokens.colorNeutralForeground2,
    },
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
  filterInputWrap: {
    width: "220px",
    "@media (max-width: 600px)": {
      width: "100%",
    },
  },
  ckShellLeft: {
    paddingLeft: "20px",
    "@media (max-width: 600px)": {
      paddingLeft: "12px",
    },
  },
  ckShellRight: {
    paddingRight: "20px",
    "@media (max-width: 600px)": {
      paddingRight: "12px",
    },
  },
  // Column-width classes — kept here (rather than inline `style`) so the
  // media queries below can actually override them on phones.
  colCheck: {
    width: "56px",
    "@media (max-width: 600px)": { width: "44px" },
  },
  colName: {
    minWidth: "280px",
    "@media (max-width: 600px)": { minWidth: 0, width: "auto" },
  },
  colType: {
    width: "110px",
    "@media (max-width: 600px)": { display: "none" },
  },
  colArch: {
    width: "90px",
    "@media (max-width: 600px)": { display: "none" },
  },
  colSize: {
    width: "110px",
    "@media (max-width: 600px)": { width: "72px" },
  },
  colActions: {
    width: "130px",
    "@media (max-width: 600px)": { width: "96px" },
  },
  // Inline Type+Arch meta shown under the file name on mobile only, since
  // those columns are hidden to free space for the name.
  mobileMeta: {
    display: "none",
    "@media (max-width: 600px)": {
      display: "flex",
      flexWrap: "wrap",
      alignItems: "center",
      columnGap: "6px",
      rowGap: "4px",
      marginTop: "4px",
    },
  },
  mobileArchText: {
    fontSize: "11px",
    color: tokens.colorNeutralForeground3,
  },
});

export function ResultsView({ results, query, appInfo, onCopy }: ResultsViewProps) {
  const styles = useStyles();
  const t = useT();
  const [filter, setFilter] = useState<FilterKey>("all");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [sortKey, setSortKey] = useState<SortKey>("size");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  // Reset selection in-render when `results` identity changes
  // (https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes).
  const [prevResults, setPrevResults] = useState(results);
  if (prevResults !== results) {
    setPrevResults(results);
    setSelected(new Set());
  }

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
    onCopy(
      urls,
      t(selected.size === 1 ? "results.copy.urls" : "results.copy.urls.plural", {
        count: selected.size,
      }),
    );
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
    { v: "all", l: t("results.tab.all") },
    { v: "APPX", l: t("results.tab.appx") },
    { v: "Other", l: t("results.tab.other") },
    { v: "BlockMap", l: t("results.tab.blockMap") },
  ];

  return (
    <Card className={styles.card}>
      <div className={styles.header}>
        <div className={styles.headLeft}>
          <div className={styles.headTitle}>
            <Body1Strong>
              {t(results.length === 1 ? "results.fileCount" : "results.fileCount.plural", {
                count: results.length,
              })}
            </Body1Strong>
            <Caption1>·</Caption1>
            <Caption1>{t("results.totalSize", { size: formatBytes(totalBytes) })}</Caption1>
          </div>
          {query && (
            <Text className={`qsl-mono ${styles.query}`} title={query}>
              {query}
            </Text>
          )}
          {appInfo?.CategoryId && (
            <Tooltip
              content={t("results.category.tooltip", { id: appInfo.CategoryId })}
              relationship="label"
            >
              <button
                type="button"
                className={`qsl-mono ${styles.metaChip}`}
                onClick={() => onCopy(appInfo.CategoryId!, t("results.category.copy"))}
                aria-label={t("results.category.copy")}
              >
                <span className={styles.metaLabel}>{t("results.category.label")}</span>
                <span className={styles.metaValue}>{appInfo.CategoryId}</span>
                <CopyRegular fontSize={11} />
              </button>
            </Tooltip>
          )}
        </div>
        <div className={styles.filterInputWrap}>
          <Input
            size="small"
            placeholder={t("results.filter.placeholder")}
            value={search}
            onChange={(_, d) => setSearch(d.value)}
            contentBefore={<FilterRegular />}
            contentAfter={
              search ? (
                <Button
                  size="small"
                  appearance="transparent"
                  icon={<DismissRegular />}
                  aria-label={t("search.identifier.clear")}
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
            {t("results.bulk.selected", {
              count: selected.size,
              size: formatBytes(selBytes),
            })}
          </Text>
          <div className={styles.bulkRight}>
            <Button appearance="subtle" size="small" icon={<CopyRegular />} onClick={copySelected}>
              {t("results.bulk.copyUrls")}
            </Button>
            <Button
              appearance="primary"
              size="small"
              icon={<ArrowDownloadRegular />}
              onClick={downloadSelected}
            >
              {t("results.bulk.downloadAll")}
            </Button>
            <Button appearance="subtle" size="small" onClick={() => setSelected(new Set())}>
              {t("results.bulk.clear")}
            </Button>
          </div>
        </div>
      )}

      <div className={styles.tableWrap}>
        <Table size="small" aria-label={t("results.table.aria")}>
          <TableHeader>
            <TableRow>
              <TableHeaderCell
                className={mergeClasses(
                  styles.ckShellLeft,
                  styles.stickyHeaderCell,
                  styles.colCheck,
                )}
              >
                <Checkbox
                  checked={allSelected}
                  onChange={toggleAll}
                  aria-label={t("results.table.selectAll")}
                />
              </TableHeaderCell>
              <TableHeaderCell
                {...sortableProps("name")}
                className={mergeClasses(styles.stickyHeaderCell, styles.colName)}
              >
                {t("results.table.fileName")}
              </TableHeaderCell>
              <TableHeaderCell
                {...sortableProps("type")}
                className={mergeClasses(styles.stickyHeaderCell, styles.colType)}
              >
                {t("results.table.type")}
              </TableHeaderCell>
              <TableHeaderCell
                {...sortableProps("arch")}
                className={mergeClasses(styles.stickyHeaderCell, styles.colArch)}
              >
                {t("results.table.arch")}
              </TableHeaderCell>
              <TableHeaderCell
                {...sortableProps("size")}
                className={mergeClasses(styles.stickyHeaderCell, styles.colSize)}
              >
                <Text className={styles.numCell} block>
                  {t("results.table.size")}
                </Text>
              </TableHeaderCell>
              <TableHeaderCell
                className={mergeClasses(
                  styles.ckShellRight,
                  styles.stickyHeaderCell,
                  styles.colActions,
                )}
              >
                <Text className={styles.actionsCell} block>
                  {t("results.table.actions")}
                </Text>
              </TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6}>
                  <Text className={styles.empty} block>
                    {t("results.empty")}
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
                  t={t}
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
  t,
}: {
  item: NormalizedItem;
  selected: boolean;
  onToggle: () => void;
  onCopy: (text: string, what: string) => void;
  t: TFn;
}) {
  const styles = useStyles();
  const badgeColor: "brand" | "warning" | "informative" =
    item.type === "APPX" ? "brand" : item.type === "BlockMap" ? "informative" : "warning";

  return (
    <TableRow className={selected ? styles.rowSelected : undefined}>
      <TableCell className={mergeClasses(styles.ckShellLeft, styles.colCheck)}>
        <Checkbox
          checked={selected}
          onChange={onToggle}
          aria-label={t("results.table.selectOne", { name: item.name })}
        />
      </TableCell>
      <TableCell className={styles.colName} style={{ minWidth: 0 }}>
        <TableCellLayout
          truncate
          media={
            <DocumentRegular fontSize={16} style={{ color: tokens.colorNeutralForeground3 }} />
          }
        >
          <div className={styles.nameStack}>
            <Text className={`qsl-mono ${styles.nameText}`} title={item.name}>
              {item.name}
            </Text>
            <div className={styles.mobileMeta}>
              <Badge appearance="tint" color={badgeColor} size="small">
                {item.type}
              </Badge>
              <Text className={`qsl-mono ${styles.mobileArchText}`}>{item.arch ?? "—"}</Text>
            </div>
            {item.sha256 && (
              <HashChip
                algo="sha256"
                value={item.sha256}
                fileName={item.name}
                onCopy={onCopy}
                t={t}
              />
            )}
            {item.sha1 && (
              <HashChip
                algo="sha1"
                value={item.sha1}
                fileName={item.name}
                onCopy={onCopy}
                t={t}
              />
            )}
          </div>
        </TableCellLayout>
      </TableCell>
      <TableCell className={styles.colType}>
        <Badge appearance="tint" color={badgeColor}>
          {item.type}
        </Badge>
      </TableCell>
      <TableCell className={styles.colArch}>
        <Text className={`qsl-mono ${styles.archCell}`}>{item.arch ?? "—"}</Text>
      </TableCell>
      <TableCell className={styles.colSize}>
        <Text className={styles.numCell} block>
          {item.size}
        </Text>
      </TableCell>
      <TableCell className={mergeClasses(styles.ckShellRight, styles.colActions)}>
        <span className={styles.actionGroup}>
          <Tooltip content={t("results.row.copyUrl")} relationship="label">
            <Button
              appearance="subtle"
              size="small"
              icon={<CopyRegular />}
              aria-label={t("results.row.copyUrl")}
              onClick={() => onCopy(item.url, item.name)}
            />
          </Tooltip>
          <Tooltip content={t("results.row.download")} relationship="label">
            <Button
              appearance="subtle"
              size="small"
              icon={<ArrowDownloadRegular />}
              aria-label={t("results.row.download")}
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
          <Tooltip content={t("results.row.open")} relationship="label">
            <Button
              appearance="subtle"
              size="small"
              icon={<OpenRegular />}
              aria-label={t("results.row.open")}
              onClick={() => window.open(item.url, "_blank")}
            />
          </Tooltip>
        </span>
      </TableCell>
    </TableRow>
  );
}

function HashChip({
  algo,
  value,
  fileName,
  onCopy,
  t,
}: {
  algo: HashAlgo;
  value: string;
  fileName: string;
  onCopy: (text: string, what: string) => void;
  t: TFn;
}) {
  const styles = useStyles();
  const label = t(
    algo === "sha256" ? "results.hash.copyLabel.sha256" : "results.hash.copyLabel.sha1",
  );
  return (
    <div className={styles.hashLine}>
      <Tooltip content={t("results.hash.tooltip", { hash: value })} relationship="label">
        <button
          type="button"
          className={`qsl-mono ${styles.hashRow}`}
          onClick={() => onCopy(value, label)}
          aria-label={t("results.hash.copyAria", { algo: label })}
        >
          <span className={styles.hashLabel}>{label}</span>
          <span>{value.slice(0, 16)}…</span>
          <CopyRegular fontSize={11} />
        </button>
      </Tooltip>
      <Menu positioning="below-start">
        <MenuTrigger disableButtonEnhancement>
          <Tooltip
            content={t("results.hash.verifyTooltip", { algo: label })}
            relationship="label"
          >
            <button
              type="button"
              className={styles.verifyBtn}
              aria-label={t("results.hash.verifyAria", { algo: label })}
            >
              <WindowConsoleRegular fontSize={12} />
            </button>
          </Tooltip>
        </MenuTrigger>
        <MenuPopover>
          <MenuList>
            <MenuItem
              onClick={() =>
                onCopy(
                  buildVerifyCommand("powershell", algo, fileName, value),
                  t("results.hash.shell.powershellLabel", { algo: label }),
                )
              }
            >
              {t("results.hash.shell.powershell")}
            </MenuItem>
            <MenuItem
              onClick={() =>
                onCopy(
                  buildVerifyCommand("cmd", algo, fileName, value),
                  t("results.hash.shell.cmdLabel", { algo: label }),
                )
              }
            >
              {t("results.hash.shell.cmd")}
            </MenuItem>
            <MenuItem
              onClick={() =>
                onCopy(
                  buildVerifyCommand("bash", algo, fileName, value),
                  t("results.hash.shell.bashLabel", { algo: label }),
                )
              }
            >
              {t("results.hash.shell.bash")}
            </MenuItem>
          </MenuList>
        </MenuPopover>
      </Menu>
    </div>
  );
}
