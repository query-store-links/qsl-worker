import { Fragment, useMemo, useState } from "react";
import {
  Badge,
  Body1Strong,
  Button,
  Card,
  Caption1,
  Checkbox,
  CounterBadge,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  DialogTrigger,
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
  ChevronDownRegular,
  ChevronRightRegular,
  ChevronUpRegular,
  CopyRegular,
  CubeTreeRegular,
  DismissRegular,
  DocumentRegular,
  FilterRegular,
  FingerprintRegular,
  FolderRegular,
  OpenRegular,
  WindowConsoleRegular,
} from "@fluentui/react-icons";
import {
  formatBytes,
  type AppInfo,
  type DependencyGraph,
  type DependencyMap,
  type DependencyNode,
  type NormalizedItem,
  type PackageType,
} from "../shared";
import { useMediaQuery } from "../hooks";
import { useT, type TFn } from "../i18n";

// Kick off a browser download for a resolved URL without leaving the page.
function startDownload(url: string, name: string): void {
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.target = "_blank";
  a.rel = "noreferrer";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

type FilterKey = "all" | PackageType;
type SortKey = "name" | "size" | "type" | "arch";

type Shell = "powershell" | "cmd" | "bash";
type HashAlgo = "sha256" | "sha1";

interface ResultGroup {
  identity: string;
  items: NormalizedItem[];
  totalBytes: number;
}

// `Name_Version_Arch_ResId_Pub.ext` → `Name` (the PFN identity base). All the
// arch/version variants of one package share this, so it's the folder key.
function packageIdentity(name: string): string {
  const us = name.indexOf("_");
  if (us > 0) return name.slice(0, us);
  return name.replace(/\.[^.]+$/, "") || name;
}

// The bit that actually differs within an identity — version · arch, plus the
// extension when it's a bundle / symbols / blockmap so those don't collapse
// into an identical-looking sibling. Falls back to the full name when the
// filename doesn't parse (rare).
function variantLabel(item: NormalizedItem): string {
  const ext = item.name.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase() ?? "";
  const bits: string[] = [];
  if (item.version) bits.push(item.version);
  if (item.arch) bits.push(item.arch);
  if (ext && /(bundle|sym|blockmap|cab|xml)$/.test(ext)) bits.push(ext);
  return bits.length ? bits.join(" · ") : item.name;
}

// Group filtered items by identity, preserving the (already-sorted)
// first-appearance order of each group.
function groupByIdentity(items: NormalizedItem[]): ResultGroup[] {
  const map = new Map<string, NormalizedItem[]>();
  for (const it of items) {
    const id = packageIdentity(it.name);
    const arr = map.get(id);
    if (arr) arr.push(it);
    else map.set(id, [it]);
  }
  return [...map.entries()].map(([identity, groupItems]) => ({
    identity,
    items: groupItems,
    totalBytes: groupItems.reduce((s, i) => s + i.sizeBytes, 0),
  }));
}

function buildVerifyCommand(shell: Shell, algo: HashAlgo, file: string, hash: string): string {
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
  dependencies: DependencyMap | null;
  dependencyGraph: DependencyGraph | null;
  onCopy: (text: string, what: string) => void;
}

/** Depth-first flatten of the dependency graph into render rows. Each root is
 *  expanded into its subtree; an ancestor set guards against cycles (a node
 *  already on the current path is shown but not re-expanded). A framework
 *  shared by several parents legitimately appears under each. */
function flattenGraph(graph: DependencyGraph): { node: DependencyNode; depth: number }[] {
  const byId = new Map(graph.Nodes.map((n) => [n.Id, n]));
  const out: { node: DependencyNode; depth: number }[] = [];
  const visit = (id: string, depth: number, ancestors: Set<string>) => {
    const node = byId.get(id);
    if (!node) return;
    out.push({ node, depth });
    if (ancestors.has(id)) return;
    const next = new Set(ancestors);
    next.add(id);
    for (const dep of node.DependsOn) visit(dep, depth + 1, next);
  };
  for (const root of graph.Roots) visit(root, 0, new Set());
  // Defensive: surface any node unreachable from a declared root.
  const seen = new Set(out.map((r) => r.node.Id));
  for (const n of graph.Nodes) if (!seen.has(n.Id)) out.push({ node: n, depth: 0 });
  return out;
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
    "@media (max-width: 600px)": { padding: "12px 16px" },
  },
  // On narrow viewports take the full row so the 220px filter input below
  // drops to its own line instead of squeezing the Category chip into a
  // multi-line GUID stack.
  headLeft: {
    minWidth: 0,
    flex: 1,
    "@media (max-width: 600px)": { flexBasis: "100%" },
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
    "@media (max-width: 600px)": { padding: "0 12px" },
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
    "@media (max-width: 600px)": { padding: "8px 12px" },
  },
  bulkLeft: {
    fontSize: "13px",
    color: tokens.colorBrandForeground1,
    fontWeight: 600,
  },
  bulkRight: { display: "flex", flexWrap: "wrap", columnGap: "8px", rowGap: "4px" },
  // Desktop only — phones render the flex `mList` instead.
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
    // Inline hash chips don't fit on phones — the details dialog surfaces
    // the full hash + verify menus there instead.
    "@media (max-width: 600px)": { display: "none" },
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
    // Cap the chip at its container so long GUIDs truncate instead of
    // wrapping the value across multiple lines.
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
  // ── Dependency map ────────────────────────────────────────────────────
  // Full-width strip between the header and the filter tabs. Holds the named
  // framework / platform dependencies DisplayCatalog declares for the
  // product (storelib_rs 0.1.11+).
  depsBar: {
    padding: "10px 20px",
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    columnGap: "8px",
    rowGap: "6px",
    "@media (max-width: 600px)": { padding: "10px 16px" },
  },
  depsLabel: {
    fontSize: "11px",
    fontWeight: 600,
    textTransform: "uppercase",
    letterSpacing: "0.04em",
    color: tokens.colorNeutralForeground3,
    marginRight: "2px",
    display: "inline-flex",
    alignItems: "center",
    columnGap: "6px",
  },
  depChip: {
    display: "inline-flex",
    alignItems: "center",
    columnGap: "6px",
    fontSize: "11px",
    color: tokens.colorNeutralForeground2,
    cursor: "pointer",
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusSmall,
    padding: "2px 8px",
    backgroundColor: "transparent",
    fontFamily: "inherit",
    maxWidth: "100%",
    minWidth: 0,
    "&:hover": {
      backgroundColor: tokens.colorNeutralBackground1Hover,
      color: tokens.colorNeutralForeground1,
    },
  },
  // Platform deps (Windows.Universal, …) are tinted so they read apart from
  // the runtime framework chips at a glance.
  depChipPlatform: {
    border: `1px solid ${tokens.colorBrandStroke2}`,
    color: tokens.colorBrandForeground2,
    "&:hover": {
      backgroundColor: tokens.colorBrandBackground2Hover,
      color: tokens.colorBrandForeground1,
    },
  },
  depChipName: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    minWidth: 0,
  },
  depChipVersion: {
    color: tokens.colorNeutralForeground4,
    flexShrink: 0,
    fontVariantNumeric: "tabular-nums",
  },
  // Toggle that expands the chips summary into the full dependency tree.
  depsToggle: {
    display: "inline-flex",
    alignItems: "center",
    columnGap: "6px",
    border: "none",
    background: "transparent",
    padding: "2px 4px",
    margin: "-2px -4px",
    borderRadius: tokens.borderRadiusSmall,
    cursor: "pointer",
    color: "inherit",
    fontFamily: "inherit",
    "&:hover": { backgroundColor: tokens.colorNeutralBackground1Hover },
  },
  depsChevron: {
    transition: "transform 120ms ease",
    color: tokens.colorNeutralForeground3,
    flexShrink: 0,
  },
  depsChevronOpen: { transform: "rotate(90deg)" },
  // Tree container shown when expanded.
  depsTree: {
    padding: "4px 20px 12px",
    display: "flex",
    flexDirection: "column",
    rowGap: "2px",
    "@media (max-width: 600px)": { padding: "4px 16px 12px" },
  },
  depRow: {
    display: "flex",
    alignItems: "center",
    columnGap: "8px",
    minHeight: "26px",
    minWidth: 0,
  },
  depConnector: {
    color: tokens.colorNeutralForeground4,
    flexShrink: 0,
    fontSize: "12px",
  },
  depName: {
    display: "inline-flex",
    alignItems: "center",
    columnGap: "6px",
    fontSize: "12px",
    color: tokens.colorNeutralForeground1,
    cursor: "pointer",
    border: "none",
    background: "transparent",
    padding: 0,
    fontFamily: "inherit",
    minWidth: 0,
    "&:hover": { color: tokens.colorBrandForeground1 },
  },
  depNameText: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    minWidth: 0,
  },
  depMeta: {
    fontSize: "11px",
    color: tokens.colorNeutralForeground3,
    flexShrink: 0,
    fontVariantNumeric: "tabular-nums",
  },
  depDeclared: {
    fontSize: "10px",
    color: tokens.colorNeutralForeground4,
    fontStyle: "italic",
    flexShrink: 0,
  },
  depsTargets: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    columnGap: "6px",
    rowGap: "4px",
    marginTop: "8px",
    paddingTop: "8px",
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
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
  // Row-action buttons that are duplicated in the Details dialog — hide
  // them on phones so the actions column doesn't push the file name off
  // screen. The Details button covers the same surface area.
  actionDesktopOnly: {
    "@media (max-width: 600px)": { display: "none" },
  },
  empty: {
    padding: "32px",
    textAlign: "center",
    color: tokens.colorNeutralForeground3,
    display: "block",
  },
  filterInputWrap: {
    width: "220px",
    "@media (max-width: 600px)": { width: "100%" },
  },
  ckShellLeft: {
    paddingLeft: "20px",
    "@media (max-width: 600px)": { paddingLeft: "12px" },
  },
  ckShellRight: {
    paddingRight: "20px",
    "@media (max-width: 600px)": { paddingRight: "12px" },
  },
  // Column-width classes — set here (rather than inline `style`) so the
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
  // Size moves into the inline meta on phones so the file name reclaims the
  // column's width.
  colSize: {
    width: "110px",
    "@media (max-width: 600px)": { display: "none" },
  },
  colActions: {
    width: "160px",
    "@media (max-width: 600px)": { width: "84px" },
  },
  // Inline Type + Arch + Size shown under the file name when their dedicated
  // columns are hidden on mobile.
  mobileMeta: {
    display: "none",
    "@media (max-width: 600px)": {
      display: "flex",
      flexWrap: "wrap",
      alignItems: "center",
      columnGap: "8px",
      rowGap: "4px",
      marginTop: "5px",
    },
  },
  mobileArchText: {
    fontSize: "11px",
    color: tokens.colorNeutralForeground3,
    fontVariantNumeric: "tabular-nums",
  },
  mobileMetaSep: {
    color: tokens.colorNeutralForeground4,
    fontSize: "11px",
  },
  // ── Package folders ───────────────────────────────────────────────────
  groupRow: {
    backgroundColor: tokens.colorNeutralBackground2,
    "&:hover": { backgroundColor: tokens.colorNeutralBackground2Hover },
  },
  groupCell: { padding: 0 },
  groupToggle: {
    display: "flex",
    alignItems: "center",
    columnGap: "8px",
    width: "100%",
    minWidth: 0,
    border: "none",
    background: "transparent",
    padding: "9px 12px 9px 0",
    cursor: "pointer",
    fontFamily: "inherit",
    color: tokens.colorNeutralForeground1,
    textAlign: "left",
    // `groupName` inherits this colour (it sets none of its own), so the
    // label brightens on hover while the icons keep their muted tones.
    "&:hover": { color: tokens.colorBrandForeground1 },
  },
  groupIcon: { color: tokens.colorNeutralForeground3, flexShrink: 0 },
  groupName: {
    fontSize: "13px",
    fontWeight: 600,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    minWidth: 0,
  },
  groupSize: {
    marginLeft: "auto",
    paddingLeft: "8px",
    fontSize: "12px",
    color: tokens.colorNeutralForeground3,
    fontVariantNumeric: "tabular-nums",
    flexShrink: 0,
  },
  // Children of a folder are indented so the nesting reads at a glance.
  nameIndent: {
    paddingLeft: "22px",
    "@media (max-width: 600px)": { paddingLeft: "12px" },
  },
  headRight: {
    display: "flex",
    alignItems: "center",
    columnGap: "8px",
    "@media (max-width: 600px)": { flexBasis: "100%", flexWrap: "wrap" },
  },
  expandAllBtn: { flexShrink: 0, whiteSpace: "nowrap" },
  // ── Mobile card list ──────────────────────────────────────────────────
  mList: { display: "flex", flexDirection: "column" },
  mCard: {
    display: "flex",
    alignItems: "flex-start",
    columnGap: "10px",
    padding: "10px 16px",
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  mCardSel: { backgroundColor: tokens.colorBrandBackground2 },
  mCardIndent: { paddingLeft: "32px" },
  mCardBody: {
    flex: 1,
    minWidth: 0,
    display: "flex",
    flexDirection: "column",
    rowGap: "5px",
    paddingTop: "3px",
  },
  mCardName: {
    fontSize: "13px",
    color: tokens.colorNeutralForeground1,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    display: "block",
  },
  mCardMeta: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    columnGap: "8px",
    rowGap: "4px",
    fontSize: "11px",
    color: tokens.colorNeutralForeground3,
    fontVariantNumeric: "tabular-nums",
  },
  mCardActions: {
    display: "flex",
    alignItems: "center",
    columnGap: "2px",
    flexShrink: 0,
    paddingTop: "2px",
  },
  mFolder: {
    display: "flex",
    alignItems: "center",
    columnGap: "8px",
    padding: "8px 16px",
    backgroundColor: tokens.colorNeutralBackground2,
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  mFolderToggle: {
    flex: 1,
    minWidth: 0,
    display: "flex",
    alignItems: "center",
    columnGap: "8px",
    border: "none",
    background: "transparent",
    padding: "4px 0",
    cursor: "pointer",
    fontFamily: "inherit",
    color: tokens.colorNeutralForeground1,
  },
  mFolderName: {
    fontSize: "13px",
    fontWeight: 600,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    minWidth: 0,
  },
  mFolderSize: {
    marginLeft: "auto",
    paddingLeft: "8px",
    fontSize: "12px",
    color: tokens.colorNeutralForeground3,
    fontVariantNumeric: "tabular-nums",
    flexShrink: 0,
  },
  // ── Details dialog ────────────────────────────────────────────────────
  dialogSurface: {
    "@media (max-width: 600px)": {
      width: "calc(100vw - 24px)",
      maxWidth: "100%",
      // Default DialogSurface min-width can push content off-screen on
      // narrow phones.
      minWidth: 0,
    },
  },
  dialogTitle: {
    wordBreak: "break-all",
    fontSize: "14px",
    lineHeight: 1.4,
  },
  dialogBody: {
    display: "flex",
    flexDirection: "column",
    rowGap: "16px",
  },
  dialogSectionLabel: {
    fontSize: "11px",
    fontWeight: 600,
    textTransform: "uppercase",
    letterSpacing: "0.04em",
    color: tokens.colorNeutralForeground3,
    marginBottom: "6px",
  },
  fieldGrid: {
    display: "grid",
    gridTemplateColumns: "auto 1fr",
    columnGap: "12px",
    rowGap: "6px",
    fontSize: "12px",
  },
  fieldLabel: { color: tokens.colorNeutralForeground3 },
  fieldValue: {
    color: tokens.colorNeutralForeground1,
    minWidth: 0,
    overflowWrap: "anywhere",
  },
  hashSection: {
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    padding: "10px 12px",
    backgroundColor: tokens.colorNeutralBackground2,
  },
  hashHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: "6px",
    columnGap: "8px",
  },
  hashHeaderName: {
    fontSize: "12px",
    fontWeight: 600,
    color: tokens.colorNeutralForeground1,
  },
  hashBlock: {
    fontSize: "12px",
    color: tokens.colorNeutralForeground2,
    backgroundColor: tokens.colorNeutralBackground3,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusSmall,
    padding: "8px 10px",
    // Hashes are continuous hex strings — let them break per-character so
    // they always fit the dialog width on phones without a horizontal
    // scrollbar.
    wordBreak: "break-all",
    overflowWrap: "anywhere",
    userSelect: "all",
  },
  verifyRow: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    columnGap: "6px",
    rowGap: "6px",
    marginTop: "8px",
  },
  verifyLabel: {
    fontSize: "11px",
    color: tokens.colorNeutralForeground3,
  },
  hashEmpty: {
    fontSize: "12px",
    color: tokens.colorNeutralForeground3,
    fontStyle: "italic",
  },
  // Fluent's DialogActions lays its children out in a content-width,
  // responsive grid that squeezes 4 buttons into a narrow centered column.
  // Force the actions area full width and lay the buttons out ourselves as a
  // right-aligned wrapping row.
  dialogActions: { width: "100%", maxWidth: "100%", justifyContent: "flex-end" },
  dialogActionsGroup: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "flex-end",
    columnGap: "8px",
    rowGap: "8px",
    width: "100%",
  },
});

export function ResultsView({
  results,
  query,
  appInfo,
  dependencies,
  dependencyGraph,
  onCopy,
}: ResultsViewProps) {
  const styles = useStyles();
  const t = useT();
  // Below 600px the Fluent Table's column model can't lay the rows out
  // sensibly, so we swap it for a flex card list. Matches the column-hiding
  // breakpoint used in the styles.
  const isMobile = useMediaQuery("(max-width: 600px)");
  const [filter, setFilter] = useState<FilterKey>("all");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [sortKey, setSortKey] = useState<SortKey>("size");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  // Identities of the package folders the user has opened. Default empty =
  // every multi-variant package collapsed, so the list reads as a tidy set of
  // folders rather than dozens of near-identical filenames.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // Reset selection + folder state in-render when `results` identity changes
  // (https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes).
  const [prevResults, setPrevResults] = useState(results);
  if (prevResults !== results) {
    setPrevResults(results);
    setSelected(new Set());
    setExpanded(new Set());
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

  // Group the filtered rows by package identity. Single-variant identities
  // render as plain rows (nothing to fold); multi-variant ones become folders.
  const groups = useMemo(() => groupByIdentity(filtered), [filtered]);
  const multiGroups = groups.filter((g) => g.items.length > 1);
  const allExpanded = multiGroups.length > 0 && multiGroups.every((g) => expanded.has(g.identity));

  const toggleOne = (url: string) =>
    setSelected((p) => {
      const n = new Set(p);
      if (n.has(url)) n.delete(url);
      else n.add(url);
      return n;
    });
  const toggleGroup = (identity: string) =>
    setExpanded((p) => {
      const n = new Set(p);
      if (n.has(identity)) n.delete(identity);
      else n.add(identity);
      return n;
    });
  const toggleAllGroups = () =>
    setExpanded(allExpanded ? new Set() : new Set(multiGroups.map((g) => g.identity)));
  const selectGroup = (items: NormalizedItem[], on: boolean) =>
    setSelected((p) => {
      const n = new Set(p);
      for (const it of items) {
        if (on) n.add(it.url);
        else n.delete(it.url);
      }
      return n;
    });

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
        <div className={styles.headRight}>
          {multiGroups.length > 0 && (
            <Button
              size="small"
              appearance="subtle"
              className={styles.expandAllBtn}
              icon={allExpanded ? <ChevronUpRegular /> : <ChevronDownRegular />}
              onClick={toggleAllGroups}
            >
              {allExpanded ? t("results.group.collapseAll") : t("results.group.expandAll")}
            </Button>
          )}
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
      </div>

      <DependencySection
        dependencies={dependencies}
        graph={dependencyGraph}
        onCopy={onCopy}
        t={t}
      />

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

      {isMobile ? (
        <div className={styles.mList}>
          {filtered.length === 0 ? (
            <Text className={styles.empty} block>
              {t("results.empty")}
            </Text>
          ) : (
            groups.map((group) => {
              if (group.items.length === 1) {
                const r = group.items[0];
                return (
                  <MobileCard
                    key={r.url}
                    item={r}
                    selected={selected.has(r.url)}
                    onToggle={() => toggleOne(r.url)}
                    onCopy={onCopy}
                    t={t}
                  />
                );
              }
              const isOpen = expanded.has(group.identity);
              const allSel = group.items.every((i) => selected.has(i.url));
              const someSel = !allSel && group.items.some((i) => selected.has(i.url));
              return (
                <Fragment key={group.identity}>
                  <MobileFolderHeader
                    identity={group.identity}
                    count={group.items.length}
                    totalBytes={group.totalBytes}
                    isOpen={isOpen}
                    checkState={allSel ? true : someSel ? "mixed" : false}
                    onToggle={() => toggleGroup(group.identity)}
                    onSelect={() => selectGroup(group.items, !allSel)}
                    t={t}
                  />
                  {isOpen &&
                    group.items.map((r) => (
                      <MobileCard
                        key={r.url}
                        item={r}
                        label={variantLabel(r)}
                        indent
                        selected={selected.has(r.url)}
                        onToggle={() => toggleOne(r.url)}
                        onCopy={onCopy}
                        t={t}
                      />
                    ))}
                </Fragment>
              );
            })
          )}
        </div>
      ) : (
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
                groups.map((group) => {
                  // Single-variant identity: a plain row with the full name —
                  // there's nothing to deduplicate.
                  if (group.items.length === 1) {
                    const r = group.items[0];
                    return (
                      <ResultRow
                        key={r.url}
                        item={r}
                        selected={selected.has(r.url)}
                        onToggle={() => toggleOne(r.url)}
                        onCopy={onCopy}
                        t={t}
                      />
                    );
                  }
                  // Multi-variant identity: a collapsible folder whose children
                  // show only the differing version · arch.
                  const isOpen = expanded.has(group.identity);
                  const allSel = group.items.every((i) => selected.has(i.url));
                  const someSel = !allSel && group.items.some((i) => selected.has(i.url));
                  return (
                    <Fragment key={group.identity}>
                      <GroupHeaderRow
                        identity={group.identity}
                        count={group.items.length}
                        totalBytes={group.totalBytes}
                        isOpen={isOpen}
                        checkState={allSel ? true : someSel ? "mixed" : false}
                        onToggle={() => toggleGroup(group.identity)}
                        onSelect={() => selectGroup(group.items, !allSel)}
                        styles={styles}
                        t={t}
                      />
                      {isOpen &&
                        group.items.map((r) => (
                          <ResultRow
                            key={r.url}
                            item={r}
                            label={variantLabel(r)}
                            indent
                            selected={selected.has(r.url)}
                            onToggle={() => toggleOne(r.url)}
                            onCopy={onCopy}
                            t={t}
                          />
                        ))}
                    </Fragment>
                  );
                })
              )}
            </TableBody>
          </Table>
        </div>
      )}
    </Card>
  );
}

// Dependency surface for the resolved product (DisplayCatalog, via
// storelib_rs 0.1.11+). The collapsed state is a flat chip summary of the
// named framework + platform dependencies; expanding reveals the directed
// graph — `app needs [frameworks]` — when the worker supplied edges. Renders
// nothing when there's no dependency data (older deployment, FE3-only /
// non-Appx path).
function DependencySection({
  dependencies,
  graph,
  onCopy,
  t,
}: {
  dependencies: DependencyMap | null;
  graph: DependencyGraph | null;
  onCopy: (text: string, what: string) => void;
  t: TFn;
}) {
  const styles = useStyles();
  const [open, setOpen] = useState(false);

  const frameworks = (dependencies?.Frameworks ?? []).filter((d) => d.PackageIdentity);
  const platforms = (dependencies?.Platforms ?? []).filter((d) => d.PlatformName);
  const rows = useMemo(() => (graph ? flattenGraph(graph) : []), [graph]);
  const hasGraph = rows.length > 0;

  if (frameworks.length === 0 && platforms.length === 0 && !hasGraph) return null;

  const total = frameworks.length + platforms.length;
  const versionHint = (min: string | null, max: string | null): string => {
    if (min && max) return t("results.deps.versionRange", { min, max });
    if (min) return t("results.deps.minVersion", { version: min });
    if (max) return t("results.deps.maxTested", { version: max });
    return "";
  };

  const label = (
    <span className={styles.depsLabel}>
      {t("results.deps.label")}
      <CounterBadge count={total} appearance="ghost" color="informative" size="small" />
    </span>
  );

  return (
    <>
      <div className={styles.depsBar}>
        {hasGraph ? (
          <button
            type="button"
            className={styles.depsToggle}
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            aria-label={t(open ? "results.deps.collapse" : "results.deps.expand")}
          >
            <ChevronRightRegular
              fontSize={14}
              className={mergeClasses(styles.depsChevron, open && styles.depsChevronOpen)}
            />
            {label}
          </button>
        ) : (
          label
        )}
        {frameworks.map((d) => {
          const name = d.PackageIdentity!;
          const ver = versionHint(d.MinVersion, d.MaxTested);
          return (
            <Tooltip
              key={`fw:${name}`}
              content={t("results.deps.framework.tooltip", { name, version: ver || "—" })}
              relationship="label"
            >
              <button
                type="button"
                className={`qsl-mono ${styles.depChip}`}
                onClick={() => onCopy(name, t("results.deps.copy", { name }))}
                aria-label={t("results.deps.copy", { name })}
              >
                <span className={styles.depChipName}>{name}</span>
                {d.MinVersion && <span className={styles.depChipVersion}>{d.MinVersion}</span>}
              </button>
            </Tooltip>
          );
        })}
        {platforms.map((d) => {
          const name = d.PlatformName!;
          const ver = versionHint(d.MinVersion, d.MaxTested);
          return (
            <Tooltip
              key={`plat:${name}`}
              content={t("results.deps.platform.tooltip", { name, version: ver || "—" })}
              relationship="label"
            >
              <button
                type="button"
                className={`qsl-mono ${mergeClasses(styles.depChip, styles.depChipPlatform)}`}
                onClick={() => onCopy(name, t("results.deps.copy", { name }))}
                aria-label={t("results.deps.copy", { name })}
              >
                <span className={styles.depChipName}>{name}</span>
              </button>
            </Tooltip>
          );
        })}
      </div>

      {open && hasGraph && (
        <div className={styles.depsTree}>
          {rows.map(({ node, depth }, i) => (
            <DependencyTreeRow
              key={`${node.Id}:${depth}:${i}`}
              node={node}
              depth={depth}
              onCopy={onCopy}
              t={t}
            />
          ))}
        </div>
      )}
    </>
  );
}

function DependencyTreeRow({
  node,
  depth,
  onCopy,
  t,
}: {
  node: DependencyNode;
  depth: number;
  onCopy: (text: string, what: string) => void;
  t: TFn;
}) {
  const styles = useStyles();
  const versions = node.Versions.join(", ");
  const archs = node.Architectures.join(" · ");
  return (
    <div className={styles.depRow} style={{ paddingLeft: `${depth * 18}px` }}>
      {depth > 0 && <span className={styles.depConnector}>└─</span>}
      <Tooltip
        content={t(node.IsFramework ? "results.deps.node.framework" : "results.deps.node.app", {
          name: node.Id,
        })}
        relationship="label"
      >
        <button
          type="button"
          className={`qsl-mono ${styles.depName}`}
          onClick={() => onCopy(node.Id, t("results.deps.copy", { name: node.Id }))}
          aria-label={t("results.deps.copy", { name: node.Id })}
        >
          {node.IsFramework ? <CubeTreeRegular fontSize={13} /> : <DocumentRegular fontSize={13} />}
          <span className={styles.depNameText}>{node.Name}</span>
        </button>
      </Tooltip>
      <Badge appearance="tint" color={node.IsFramework ? "informative" : "brand"} size="small">
        {t(node.IsFramework ? "results.deps.badge.framework" : "results.deps.badge.app")}
      </Badge>
      {versions && <span className={styles.depMeta}>{versions}</span>}
      {archs && <span className={`qsl-mono ${styles.depMeta}`}>{archs}</span>}
      {!node.Resolved && (
        <span className={styles.depDeclared}>{t("results.deps.declaredOnly")}</span>
      )}
    </div>
  );
}

// Folder header for a package identity with multiple variants. Spans the row;
// clicking toggles the children. The leading checkbox selects/deselects the
// whole group.
function GroupHeaderRow({
  identity,
  count,
  totalBytes,
  isOpen,
  checkState,
  onToggle,
  onSelect,
  styles,
  t,
}: {
  identity: string;
  count: number;
  totalBytes: number;
  isOpen: boolean;
  checkState: boolean | "mixed";
  onToggle: () => void;
  onSelect: () => void;
  styles: ReturnType<typeof useStyles>;
  t: TFn;
}) {
  return (
    <TableRow className={styles.groupRow}>
      <TableCell className={mergeClasses(styles.ckShellLeft, styles.colCheck)}>
        <Checkbox
          checked={checkState}
          onChange={onSelect}
          aria-label={t("results.group.selectAll", { name: identity })}
        />
      </TableCell>
      <TableCell colSpan={5} className={styles.groupCell}>
        <button
          type="button"
          className={styles.groupToggle}
          onClick={onToggle}
          aria-expanded={isOpen}
          title={identity}
        >
          <ChevronRightRegular
            fontSize={14}
            className={mergeClasses(styles.depsChevron, isOpen && styles.depsChevronOpen)}
          />
          <FolderRegular fontSize={16} className={styles.groupIcon} />
          <span className={`qsl-mono ${styles.groupName}`}>{identity}</span>
          <CounterBadge count={count} appearance="ghost" color="informative" size="small" />
          <span className={styles.groupSize}>{formatBytes(totalBytes)}</span>
        </button>
      </TableCell>
    </TableRow>
  );
}

// ── Mobile card list (replaces the table below 600px) ───────────────────

function MobileFolderHeader({
  identity,
  count,
  totalBytes,
  isOpen,
  checkState,
  onToggle,
  onSelect,
  t,
}: {
  identity: string;
  count: number;
  totalBytes: number;
  isOpen: boolean;
  checkState: boolean | "mixed";
  onToggle: () => void;
  onSelect: () => void;
  t: TFn;
}) {
  const styles = useStyles();
  return (
    <div className={styles.mFolder}>
      <Checkbox
        checked={checkState}
        onChange={onSelect}
        aria-label={t("results.group.selectAll", { name: identity })}
      />
      <button
        type="button"
        className={styles.mFolderToggle}
        onClick={onToggle}
        aria-expanded={isOpen}
        title={identity}
      >
        <ChevronRightRegular
          fontSize={14}
          className={mergeClasses(styles.depsChevron, isOpen && styles.depsChevronOpen)}
        />
        <FolderRegular fontSize={16} className={styles.groupIcon} />
        <span className={`qsl-mono ${styles.mFolderName}`}>{identity}</span>
        <CounterBadge count={count} appearance="ghost" color="informative" size="small" />
        <span className={styles.mFolderSize}>{formatBytes(totalBytes)}</span>
      </button>
    </div>
  );
}

function MobileCard({
  item,
  selected,
  onToggle,
  onCopy,
  t,
  label,
  indent,
}: {
  item: NormalizedItem;
  selected: boolean;
  onToggle: () => void;
  onCopy: (text: string, what: string) => void;
  t: TFn;
  label?: string;
  indent?: boolean;
}) {
  const styles = useStyles();
  const badgeColor: "brand" | "warning" | "informative" =
    item.type === "APPX" ? "brand" : item.type === "BlockMap" ? "informative" : "warning";
  return (
    <div
      className={mergeClasses(
        styles.mCard,
        selected && styles.mCardSel,
        indent && styles.mCardIndent,
      )}
    >
      <Checkbox
        checked={selected}
        onChange={onToggle}
        aria-label={t("results.table.selectOne", { name: item.name })}
      />
      <div className={styles.mCardBody}>
        <Text className={`qsl-mono ${styles.mCardName}`} title={item.name}>
          {label ?? item.name}
        </Text>
        <div className={styles.mCardMeta}>
          <Badge appearance="tint" color={badgeColor} size="small">
            {item.type}
          </Badge>
          <span className="qsl-mono">{item.arch ?? "—"}</span>
          <span aria-hidden>·</span>
          <span>{item.size}</span>
        </div>
      </div>
      <div className={styles.mCardActions}>
        <DetailsDialog
          item={item}
          onCopy={onCopy}
          onDownload={() => startDownload(item.url, item.name)}
          t={t}
        />
        <Tooltip content={t("results.row.download")} relationship="label">
          <Button
            appearance="subtle"
            size="small"
            icon={<ArrowDownloadRegular />}
            aria-label={t("results.row.download")}
            onClick={() => startDownload(item.url, item.name)}
          />
        </Tooltip>
      </div>
    </div>
  );
}

function ResultRow({
  item,
  selected,
  onToggle,
  onCopy,
  t,
  label,
  indent,
}: {
  item: NormalizedItem;
  selected: boolean;
  onToggle: () => void;
  onCopy: (text: string, what: string) => void;
  t: TFn;
  /** Compact display name shown instead of the full filename (folder child). */
  label?: string;
  /** Indent the name cell to show the row nests under a folder header. */
  indent?: boolean;
}) {
  const styles = useStyles();
  const badgeColor: "brand" | "warning" | "informative" =
    item.type === "APPX" ? "brand" : item.type === "BlockMap" ? "informative" : "warning";

  const triggerDownload = () => {
    const a = document.createElement("a");
    a.href = item.url;
    a.download = item.name;
    a.target = "_blank";
    a.rel = "noreferrer";
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  return (
    <TableRow className={selected ? styles.rowSelected : undefined}>
      <TableCell className={mergeClasses(styles.ckShellLeft, styles.colCheck)}>
        <Checkbox
          checked={selected}
          onChange={onToggle}
          aria-label={t("results.table.selectOne", { name: item.name })}
        />
      </TableCell>
      <TableCell
        className={mergeClasses(styles.colName, indent && styles.nameIndent)}
        style={{ minWidth: 0 }}
      >
        <TableCellLayout
          truncate
          media={
            <DocumentRegular fontSize={16} style={{ color: tokens.colorNeutralForeground3 }} />
          }
        >
          <div className={styles.nameStack}>
            <Text className={`qsl-mono ${styles.nameText}`} title={item.name}>
              {label ?? item.name}
            </Text>
            <div className={styles.mobileMeta}>
              <Badge appearance="tint" color={badgeColor} size="small">
                {item.type}
              </Badge>
              <Text className={`qsl-mono ${styles.mobileArchText}`}>{item.arch ?? "—"}</Text>
              <span className={styles.mobileMetaSep} aria-hidden>
                ·
              </span>
              <Text className={styles.mobileArchText}>{item.size}</Text>
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
              <HashChip algo="sha1" value={item.sha1} fileName={item.name} onCopy={onCopy} t={t} />
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
          <DetailsDialog item={item} onCopy={onCopy} onDownload={triggerDownload} t={t} />
          <Tooltip content={t("results.row.copyUrl")} relationship="label">
            <Button
              appearance="subtle"
              size="small"
              icon={<CopyRegular />}
              aria-label={t("results.row.copyUrl")}
              onClick={() => onCopy(item.url, item.name)}
              className={styles.actionDesktopOnly}
            />
          </Tooltip>
          <Tooltip content={t("results.row.download")} relationship="label">
            <Button
              appearance="subtle"
              size="small"
              icon={<ArrowDownloadRegular />}
              aria-label={t("results.row.download")}
              onClick={triggerDownload}
            />
          </Tooltip>
          <Tooltip content={t("results.row.open")} relationship="label">
            <Button
              appearance="subtle"
              size="small"
              icon={<OpenRegular />}
              aria-label={t("results.row.open")}
              onClick={() => window.open(item.url, "_blank")}
              className={styles.actionDesktopOnly}
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
          <Tooltip content={t("results.hash.verifyTooltip", { algo: label })} relationship="label">
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

// Full-fat details surface — opened from the row's fingerprint button.
// Tables don't scale to phone widths, so this is the canonical place to
// see the full hash, run verify commands, and reach Copy URL / Open
// when those actions are hidden from the row on mobile.
function DetailsDialog({
  item,
  onCopy,
  onDownload,
  t,
}: {
  item: NormalizedItem;
  onCopy: (text: string, what: string) => void;
  onDownload: () => void;
  t: TFn;
}) {
  const styles = useStyles();
  return (
    <Dialog>
      <DialogTrigger disableButtonEnhancement>
        <Tooltip content={t("results.details.open")} relationship="label">
          <Button
            appearance="subtle"
            size="small"
            icon={<FingerprintRegular />}
            aria-label={t("results.details.openAria", { name: item.name })}
          />
        </Tooltip>
      </DialogTrigger>
      <DialogSurface className={styles.dialogSurface}>
        <DialogBody>
          <DialogTitle className={`qsl-mono ${styles.dialogTitle}`}>{item.name}</DialogTitle>
          <DialogContent className={styles.dialogBody}>
            <section>
              <div className={styles.dialogSectionLabel}>
                {t("results.details.section.metadata")}
              </div>
              <div className={styles.fieldGrid}>
                <span className={styles.fieldLabel}>{t("results.details.field.type")}</span>
                <span className={styles.fieldValue}>{item.type}</span>
                <span className={styles.fieldLabel}>{t("results.details.field.arch")}</span>
                <span className={`qsl-mono ${styles.fieldValue}`}>{item.arch ?? "—"}</span>
                <span className={styles.fieldLabel}>{t("results.details.field.size")}</span>
                <span className={styles.fieldValue}>{item.size}</span>
                {item.version && (
                  <>
                    <span className={styles.fieldLabel}>{t("results.details.field.version")}</span>
                    <span className={`qsl-mono ${styles.fieldValue}`}>{item.version}</span>
                  </>
                )}
              </div>
            </section>

            <HashSection
              algo="sha256"
              value={item.sha256}
              fileName={item.name}
              onCopy={onCopy}
              t={t}
            />
            <HashSection algo="sha1" value={item.sha1} fileName={item.name} onCopy={onCopy} t={t} />
          </DialogContent>
          <DialogActions className={styles.dialogActions}>
            <div className={styles.dialogActionsGroup}>
              <Button
                appearance="subtle"
                icon={<CopyRegular />}
                onClick={() => onCopy(item.url, item.name)}
              >
                {t("results.details.copyUrl")}
              </Button>
              <Button
                appearance="subtle"
                icon={<OpenRegular />}
                onClick={() => window.open(item.url, "_blank")}
              >
                {t("results.row.open")}
              </Button>
              <Button appearance="primary" icon={<ArrowDownloadRegular />} onClick={onDownload}>
                {t("results.row.download")}
              </Button>
              <DialogTrigger disableButtonEnhancement>
                <Button appearance="secondary">{t("results.details.close")}</Button>
              </DialogTrigger>
            </div>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

function HashSection({
  algo,
  value,
  fileName,
  onCopy,
  t,
}: {
  algo: HashAlgo;
  value: string | undefined;
  fileName: string;
  onCopy: (text: string, what: string) => void;
  t: TFn;
}) {
  const styles = useStyles();
  const label = t(
    algo === "sha256" ? "results.hash.copyLabel.sha256" : "results.hash.copyLabel.sha1",
  );
  return (
    <section className={styles.hashSection}>
      <div className={styles.hashHeader}>
        <span className={styles.hashHeaderName}>{label}</span>
        {value && (
          <Tooltip content={t("results.hash.copyAria", { algo: label })} relationship="label">
            <Button
              appearance="subtle"
              size="small"
              icon={<CopyRegular />}
              onClick={() => onCopy(value, label)}
              aria-label={t("results.hash.copyAria", { algo: label })}
            />
          </Tooltip>
        )}
      </div>
      {value ? (
        <>
          <div className={`qsl-mono ${styles.hashBlock}`}>{value}</div>
          <div className={styles.verifyRow}>
            <span className={styles.verifyLabel}>{t("results.details.verifyOn")}</span>
            <Button
              appearance="outline"
              size="small"
              icon={<WindowConsoleRegular />}
              onClick={() =>
                onCopy(
                  buildVerifyCommand("powershell", algo, fileName, value),
                  t("results.hash.shell.powershellLabel", { algo: label }),
                )
              }
            >
              {t("results.hash.shell.powershell")}
            </Button>
            <Button
              appearance="outline"
              size="small"
              icon={<WindowConsoleRegular />}
              onClick={() =>
                onCopy(
                  buildVerifyCommand("cmd", algo, fileName, value),
                  t("results.hash.shell.cmdLabel", { algo: label }),
                )
              }
            >
              {t("results.hash.shell.cmd")}
            </Button>
            <Button
              appearance="outline"
              size="small"
              icon={<WindowConsoleRegular />}
              onClick={() =>
                onCopy(
                  buildVerifyCommand("bash", algo, fileName, value),
                  t("results.hash.shell.bashLabel", { algo: label }),
                )
              }
            >
              {t("results.hash.shell.bash")}
            </Button>
          </div>
        </>
      ) : (
        <div className={styles.hashEmpty}>{t("results.details.hash.empty", { algo: label })}</div>
      )}
    </section>
  );
}
