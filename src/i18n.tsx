// i18n.tsx co-locates the Provider component with the dictionaries and the
// `useT` / `translateApiCode` helpers it depends on — splitting them would
// add files without adding clarity. Fast-refresh's only-export-components
// rule doesn't apply to this design.
/* eslint-disable react-refresh/only-export-components */
import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { API_CODE_MESSAGES_EN, type ApiCode } from "./shared";

export type Lang = "en" | "zh";

export const SUPPORTED_LANGS: { value: Lang; label: string; nativeLabel: string }[] = [
  { value: "en", label: "English", nativeLabel: "English" },
  { value: "zh", label: "Chinese", nativeLabel: "中文" },
];

type Dict = Record<string, string>;

// ── English dictionary ─────────────────────────────────────────────────────
const en: Dict = {
  // App shell
  "app.brand": "Query Store Links",
  "app.tagline": "MSIX bundle resolver",
  "app.hero.titleLead": "Resolve Microsoft Store",
  "app.hero.titleHighlight": "download links",
  "app.hero.sub":
    "Look up direct MSIX, APPX, and bundle URLs for any package on the Microsoft Store. Supports all identifier types — modern and legacy.",
  "app.footer.uiVersion": "UI version",
  "app.footer.viaLead": ", Via {host} ({version}{storelib}",
  "app.footer.apiCommitSep": ", commit ",
  "app.footer.viaTail": ")",
  "app.footer.versionUnknown": "unknown version",
  "app.footer.storelib": " with storelib v{version}",
  "app.footer.github": "GitHub",
  "app.footer.copy": "© 2026 QSL",

  // Toasts
  "toast.copied": "Copied",
  "toast.couldntCopy": "Couldn't copy",
  "toast.clipboardDenied": "Clipboard access denied.",
  "toast.shareCopied": "Shareable link copied",
  "toast.resolved": "{count} files resolved",

  // Warnings / banners
  "banner.unofficial.title": "Unofficial deployment",
  "banner.unofficial.body":
    "You're using a copy of the Query Store Links UI hosted at {host}, not the official qsl.krnl64.win. The page you're looking at may have been modified by whoever runs this host — it can log everything you submit or rewrite the URLs it shows you. Only proceed if you trust the operator.",
  "banner.unofficial.dismiss": "I trust this host — don't warn again",
  "banner.unofficial.ack": "Acknowledge unofficial deployment",
  "banner.apiDisabled.title": "Built-in resolver disabled",
  "banner.apiDisabled.body":
    "This deployment's same-origin API is turned off. Open Settings and set {apiBackend} to a third-party QSL endpoint, or host your own. Resolves will fail until you do.",
  "banner.apiDisabled.heads": "Heads-up:",
  "banner.apiDisabled.warn":
    "any backend you enter receives every identifier you look up and serves the download URLs back. Only use one you trust.",
  "banner.thirdParty.title": "Using a third-party backend",
  "banner.thirdParty.body":
    "Queries go to {host}. That host sees every identifier you submit and returns the download URLs you'll click — a malicious one can log your queries or serve poisoned packages. Only proceed if you trust the operator.",
  "banner.thirdParty.dismiss": "I trust this backend — don't warn again",
  "banner.thirdParty.ack": "Acknowledge third-party backend",

  "banner.workerNotes.title": "{count} note from the worker",
  "banner.workerNotes.title.plural": "{count} notes from the worker",
  "banner.offlinePreview.title": "Offline preview",
  "banner.offlinePreview.body":
    "Showing sample data so you can preview the UI — see Diagnostics above.",
  "banner.debug.resolved": "Resolved",
  "banner.debug.failed": "Resolution failed",

  "common.dismiss": "Dismiss",
  "common.cancel": "Cancel",
  "common.close": "Close",
  "common.copy": "Copy",
  "common.copyClipboard": "Copy to clipboard",
  "common.remove": "Remove",
  "common.reset": "Reset",
  "common.apply": "Apply",

  // TopBar
  "topbar.backend.down": "Backend unreachable · click to configure",
  "topbar.backend.checking": "Checking backend…",
  "topbar.backend.ok": "Backend reachable · click to configure",
  "topbar.backend.unknown": "Backend · click to configure",
  "topbar.history": "Recent searches",
  "topbar.theme.toLight": "Switch to light",
  "topbar.theme.toDark": "Switch to dark",
  "topbar.theme.toggle": "Toggle theme",
  "topbar.lang.tooltip": "Language",
  "topbar.settings": "Settings",
  "topbar.config.title": "Configuration",
  "topbar.config.backend.label": "API Backend",
  "topbar.config.backend.hint":
    "The QSL backend that resolves identifiers to download URLs. Leave empty to use the same-origin worker.",
  "topbar.config.market.label": "Market override",
  "topbar.config.market.placeholder": "auto",
  "topbar.config.locale.label": "Locale",
  "topbar.config.lang.label": "Display language",

  // SearchCard
  "search.identifier.label": "Identifier",
  "search.identifier.hint":
    "Paste a Product ID, Package Family Name, Xbox Title ID, or apps.microsoft.com URL.",
  "search.identifier.kbd": "Focus: Ctrl+K",
  "search.identifier.clear": "Clear",
  "search.detect.detected": "Detected:",
  "search.detect.looksLike": "Looks like a",
  "search.detect.switch": "— switch?",
  "search.detect.matches": "Matches {label} format.",
  "search.detect.mismatch": "Doesn't match {label} — try a different type or fix the value.",
  "search.identifierType": "Identifier type",
  "search.field.ring": "Ring",
  "search.field.market": "Market",
  "search.field.locale": "Locale",
  "search.field.packageTypes": "Package types",
  "search.checkbox.appx": "APPX",
  "search.checkbox.other": "Other",
  "search.status.querying": "Querying {ring} on {market}…",
  "search.status.ready": "Ready to fetch from {ring} · {market} · {locale}",
  "search.action.share": "Share",
  "search.action.share.tooltip": "Copy a shareable URL with these params",
  "search.action.share.disabled": "Enter an identifier first",
  "search.action.permalink": "Direct link",
  "search.action.permalink.tooltip": "Build a permalink that redirects straight to a download",
  "search.action.permalink.disabled": "Enter an identifier first",
  "search.action.permalink.unsupported": "Requires worker ≥ {version}",
  "search.action.resolve": "Resolve links",
  "search.action.resolving": "Resolving",

  // PermalinkBuilder
  "permalink.title": "Direct download link",
  "permalink.subtitle": "A GET URL that redirects (or proxies) straight to the picked file.",
  "permalink.section.path": "Path style",
  "permalink.path.d": "Short — /d/<id>",
  "permalink.path.download": "Standard — /download/<id>",
  "permalink.path.installerDownload": "Verbose — /installer/download/<id>",
  "permalink.section.filters": "Filters",
  "permalink.filter.arch": "Architecture",
  "permalink.filter.arch.any": "Any (smart pick)",
  "permalink.filter.match": "Match (regex)",
  "permalink.filter.match.placeholder": "e.g. .appxbundle$",
  "permalink.filter.match.invalid": "Invalid regex",
  "permalink.filter.n": "Candidate index",
  "permalink.filter.n.hint": "0 = best match; bump for the next-best",
  "permalink.filter.includeFramework": "Include framework packages",
  "permalink.filter.includeFramework.hint":
    "VCLibs, .NET Native, etc. — normally hidden so the picker lands on the main app.",
  "permalink.filter.includeAuxiliary": "Include block-map and encrypted files",
  "permalink.filter.includeAuxiliary.hint":
    "AppxBlockMap.xml manifests and DRM-encrypted .eappx / .emsix variants — hidden by default because they aren't installable.",
  "permalink.section.response": "Response",
  "permalink.section.advanced": "Advanced options",
  "permalink.response.format": "Format",
  "permalink.response.format.auto": "Auto (redirect for browsers, JSON for clients)",
  "permalink.response.format.auto.short": "Auto",
  "permalink.response.format.redirect": "Always redirect (302)",
  "permalink.response.format.redirect.short": "Redirect",
  "permalink.response.format.json": "Always JSON",
  "permalink.response.format.json.short": "JSON",
  "permalink.response.proxy": "Proxy through this worker",
  "permalink.response.proxy.hint":
    "Stream the bytes server-side instead of redirecting. Hides the FE3 URL; adds worker bandwidth.",
  "permalink.badge.proxied": "Proxied",
  "permalink.section.locale": "Locale override",
  "permalink.locale.toggle": "Use a different market / language than the search",
  "permalink.locale.market": "Market",
  "permalink.locale.lang": "Language tag",
  "permalink.section.preview": "Permalink",
  "permalink.preview.empty": "Enter an identifier in the search box to build a link.",
  "permalink.preview.length": "{n} character",
  "permalink.preview.length.plural": "{n} characters",
  "permalink.action.copy": "Copy link",
  "permalink.action.open": "Open in new tab",
  "permalink.action.reset": "Reset to defaults",
  "permalink.toast.copied": "Permalink copied",

  // ResultsView
  "results.fileCount": "{count} file",
  "results.fileCount.plural": "{count} files",
  "results.totalSize": "{size} total",
  "results.category.tooltip": "WU Category ID · click to copy · {id}",
  "results.category.label": "Category",
  "results.category.copy": "Copy Category ID",
  "results.filter.placeholder": "Filter file names",
  "results.tab.all": "All",
  "results.tab.appx": "APPX",
  "results.tab.other": "Other",
  "results.tab.blockMap": "BlockMap",
  "results.bulk.selected": "{count} selected · {size}",
  "results.bulk.copyUrls": "Copy URLs",
  "results.bulk.downloadAll": "Download all",
  "results.bulk.clear": "Clear",
  "results.table.aria": "Resolved packages",
  "results.table.selectAll": "Select all",
  "results.table.selectOne": "Select {name}",
  "results.table.fileName": "File name",
  "results.table.type": "Type",
  "results.table.arch": "Arch",
  "results.table.size": "Size",
  "results.table.actions": "Actions",
  "results.empty": "No files match this filter.",
  "results.hash.tooltip": "Click to copy · {hash}",
  "results.hash.copyAria": "Copy SHA-256",
  "results.hash.copyLabel": "SHA-256",
  "results.hash.verifyTooltip": "Copy verify-hash command",
  "results.hash.verifyAria": "Copy verify-hash command",
  "results.hash.shell.powershell": "PowerShell",
  "results.hash.shell.cmd": "Command Prompt",
  "results.hash.shell.bash": "Bash (Linux / macOS)",
  "results.hash.shell.powershellLabel": "PowerShell verify command",
  "results.hash.shell.cmdLabel": "cmd.exe verify command",
  "results.hash.shell.bashLabel": "Bash verify command",
  "results.row.copyUrl": "Copy URL",
  "results.row.download": "Download",
  "results.row.open": "Open in new tab",
  "results.copy.urls": "{count} URL",
  "results.copy.urls.plural": "{count} URLs",

  // HistoryDrawer
  "history.title": "Recent searches",
  "history.meta": "{count} saved · stored locally",
  "history.empty.title": "No searches yet",
  "history.empty.body": "Your resolved identifiers will appear here.",
  "history.item.files": "{count} files",
  "history.item.rerun": "Re-run",
  "history.clearAll": "Clear all",

  // DebugPanel
  "debug.unknownError": "An unknown error occurred.",
  "debug.warnings.count": "{count} warning",
  "debug.warnings.count.plural": "{count} warnings",
  "debug.diagnostics": "Diagnostics",
  "debug.endpoint": "Endpoint:",
  "debug.copyDiagnostics": "Copy diagnostics",
  "debug.hide": "Hide",
  "debug.hideDiagnostics": "Hide diagnostics",
  "debug.rawJson": "Raw JSON",
  "debug.bundleLabel": "diagnostic bundle",
  "debug.fact.endpoint": "Endpoint",
  "debug.fact.http": "HTTP",
  "debug.fact.input": "Input",
  "debug.fact.type": "Type",
  "debug.fact.market": "Market",
  "debug.fact.locale": "Locale",
  "debug.fact.kind": "Error kind",
  "debug.fact.handler": "Handler error",

  // ProgressPanel
  "progress.starting": "Starting",
  "progress.connecting": "Connecting to the worker…",
  "progress.counter": "{current} of {total}",

  // NotFoundPage
  "notFound.title": "404 — Page not found",
  "notFound.bodyLead": "We couldn't find {path}. The link may be stale, or the path was mistyped.",
  "notFound.linkLead": "Head back to the resolver, or open the",
  "notFound.linkText": "project on GitHub",
  "notFound.linkTail": ".",
  "notFound.back": "Back to the resolver",

  // Relative time
  "time.justNow": "just now",
  "time.minutes": "{n}m ago",
  "time.hours": "{n}h ago",
  "time.days": "{n}d ago",

  // Identifier types
  "idType.ProductId.label": "Product ID",
  "idType.ProductId.short": "Product",
  "idType.ProductId.hint": "12-character alphanumeric ID, or apps.microsoft.com URL",
  "idType.PackageFamilyName.label": "Package Family Name",
  "idType.PackageFamilyName.short": "PFN",
  "idType.PackageFamilyName.hint": "Identity.Name_publisherhash",
  "idType.XboxTitleId.label": "Xbox Title ID",
  "idType.XboxTitleId.short": "Xbox Title",
  "idType.XboxTitleId.hint": "Decimal Xbox title identifier (4–10 digits)",
  "idType.ContentId.label": "Content ID",
  "idType.ContentId.short": "Content",
  "idType.ContentId.hint": "GUID-form content identifier",
  "idType.WuCategoryId.label": "WU Category ID",
  "idType.WuCategoryId.short": "WU Category",
  "idType.WuCategoryId.hint": "GUID consumed by Windows Update (FE3) — skips DisplayCatalog",
  "idType.LegacyWindowsStoreProductId.label": "Legacy Store Product ID",
  "idType.LegacyWindowsStoreProductId.short": "Legacy Store",
  "idType.LegacyWindowsStoreProductId.hint": "Older Windows 8/10 store identifier",
  "idType.LegacyWindowsPhoneProductId.label": "Legacy Phone Product ID",
  "idType.LegacyWindowsPhoneProductId.short": "Legacy Phone",
  "idType.LegacyWindowsPhoneProductId.hint": "Windows Phone 7/8 product GUID",
  "idType.LegacyXboxProductId.label": "Legacy Xbox Product ID",
  "idType.LegacyXboxProductId.short": "Legacy Xbox",
  "idType.LegacyXboxProductId.hint": "Xbox 360-era title GUID",

  // Rings
  "ring.Retail.label": "Retail",
  "ring.Retail.sub": "Stable",
  "ring.RP.label": "Release Preview",
  "ring.RP.sub": "RP channel",
  "ring.WIF.label": "Insider Dev",
  "ring.WIF.sub": "Fast (WIF)",
  "ring.WIS.label": "Insider Beta",
  "ring.WIS.sub": "Slow (WIS)",

  // Markets
  "market.US": "United States",
  "market.GB": "United Kingdom",
  "market.DE": "Germany",
  "market.FR": "France",
  "market.JP": "Japan",
  "market.CN": "China",
  "market.BR": "Brazil",
  "market.IN": "India",
  "market.RU": "Russia",
  "market.KR": "Korea",

  // Stage labels (storelib_rs)
  "stage.dcat.request": "Querying Microsoft Store catalog",
  "stage.dcat.response": "Receiving catalog response",
  "stage.dcat.parse": "Parsing catalog data",
  "stage.dcat.done": "Product found",
  "stage.dcat.notFound": "Product not found",
  "stage.fe3.start": "Starting package resolution",
  "stage.fe3.getCookie": "Authenticating with FE3",
  "stage.fe3.syncUpdates": "Requesting package updates",
  "stage.fe3.parseUpdateIds": "Reading update IDs",
  "stage.fe3.parseUpdateIds.done": "Found update IDs",
  "stage.fe3.parsePackages": "Reading package metadata",
  "stage.fe3.parsePackages.done": "Parsed packages",
  "stage.fe3.resolveUrls": "Resolving download URLs",
  "stage.fe3.resolveUrls.done": "Resolved download URLs",
  "stage.fe3.done": "Package resolution complete",
  "stage.search.request": "Sending search query",
  "stage.search.response": "Receiving search response",
  "stage.search.parse": "Parsing search response",
  "stage.search.done": "Search complete",
  "stage.retry.wait": "Waiting before retry",
  "stage.retry.attempt": "Retrying request",

  // API error/warning codes are merged in below from `API_CODE_MESSAGES_EN`
  // so the worker and the frontend can't disagree on the English wording.
};

for (const [k, v] of Object.entries(API_CODE_MESSAGES_EN)) en[`api.${k}`] = v;

// ── Chinese (Simplified) dictionary ────────────────────────────────────────
const zh: Dict = {
  // App shell
  "app.brand": "Query Store Links",
  "app.tagline": "MSIX 安装包解析器",
  "app.hero.titleLead": "解析 Microsoft Store",
  "app.hero.titleHighlight": "下载链接",
  "app.hero.sub":
    "查询 Microsoft Store 中任意应用的 MSIX、APPX 直链和捆绑包 URL。支持所有标识符类型 —— 包括现代标识符与旧版标识符。",
  "app.footer.uiVersion": "UI 版本",
  "app.footer.viaLead": "，经由 {host}（{version}{storelib}",
  "app.footer.apiCommitSep": "，commit ",
  "app.footer.viaTail": "）",
  "app.footer.versionUnknown": "版本未知",
  "app.footer.storelib": "，storelib v{version}",
  "app.footer.github": "GitHub",
  "app.footer.copy": "© 2026 QSL",

  // Toasts
  "toast.copied": "已复制",
  "toast.couldntCopy": "复制失败",
  "toast.clipboardDenied": "剪贴板访问被拒绝。",
  "toast.shareCopied": "分享链接已复制",
  "toast.resolved": "已解析 {count} 个文件",

  // Warnings / banners
  "banner.unofficial.title": "非官方部署",
  "banner.unofficial.body":
    "你正在使用部署于 {host} 的 Query Store Links 副本,而非官方的 qsl.krnl64.win。该页面可能被运维者修改 —— 它可能记录你提交的所有内容,或重写显示给你的 URL。只有信任运维者时才应继续使用。",
  "banner.unofficial.dismiss": "我信任此宿主 —— 不再提醒",
  "banner.unofficial.ack": "确认非官方部署",
  "banner.apiDisabled.title": "内置解析器已禁用",
  "banner.apiDisabled.body":
    "此部署的同源 API 已关闭。请打开“设置”,将 {apiBackend} 指向第三方 QSL 端点,或自行托管。在此之前所有解析都会失败。",
  "banner.apiDisabled.heads": "提示:",
  "banner.apiDisabled.warn":
    "你填入的任何后端都会接收你查询的全部标识符,并返回下载 URL。务必只使用你信任的后端。",
  "banner.thirdParty.title": "正在使用第三方后端",
  "banner.thirdParty.body":
    "请求会发送到 {host}。该主机会看到你提交的每个标识符,并返回你即将点击的下载 URL —— 恶意主机可能记录你的查询或返回被篡改的安装包。只有信任运营者时才应继续使用。",
  "banner.thirdParty.dismiss": "我信任此后端 —— 不再提醒",
  "banner.thirdParty.ack": "确认第三方后端",

  "banner.workerNotes.title": "Worker 报告了 {count} 条提示",
  "banner.workerNotes.title.plural": "Worker 报告了 {count} 条提示",
  "banner.offlinePreview.title": "离线预览",
  "banner.offlinePreview.body": "已显示示例数据以便预览界面 —— 详见上方诊断信息。",
  "banner.debug.resolved": "解析完成",
  "banner.debug.failed": "解析失败",

  "common.dismiss": "关闭",
  "common.cancel": "取消",
  "common.close": "关闭",
  "common.copy": "复制",
  "common.copyClipboard": "复制到剪贴板",
  "common.remove": "移除",
  "common.reset": "重置",
  "common.apply": "应用",

  // TopBar
  "topbar.backend.down": "后端不可达 · 点击配置",
  "topbar.backend.checking": "正在检查后端…",
  "topbar.backend.ok": "后端可用 · 点击配置",
  "topbar.backend.unknown": "后端 · 点击配置",
  "topbar.history": "最近查询",
  "topbar.theme.toLight": "切换到浅色",
  "topbar.theme.toDark": "切换到深色",
  "topbar.theme.toggle": "切换主题",
  "topbar.lang.tooltip": "语言",
  "topbar.settings": "设置",
  "topbar.config.title": "配置",
  "topbar.config.backend.label": "API 后端",
  "topbar.config.backend.hint": "用于将标识符解析为下载 URL 的 QSL 后端。留空则使用同源 worker。",
  "topbar.config.market.label": "市场覆盖",
  "topbar.config.market.placeholder": "自动",
  "topbar.config.locale.label": "区域",
  "topbar.config.lang.label": "显示语言",

  // SearchCard
  "search.identifier.label": "标识符",
  "search.identifier.hint":
    "粘贴 Product ID、Package Family Name、Xbox Title ID 或 apps.microsoft.com 链接。",
  "search.identifier.kbd": "聚焦快捷键: Ctrl+K",
  "search.identifier.clear": "清空",
  "search.detect.detected": "已识别为:",
  "search.detect.looksLike": "看起来像",
  "search.detect.switch": "—— 切换?",
  "search.detect.matches": "匹配 {label} 格式。",
  "search.detect.mismatch": "不符合 {label} 格式 —— 请改换类型或修正输入。",
  "search.identifierType": "标识符类型",
  "search.field.ring": "通道",
  "search.field.market": "市场",
  "search.field.locale": "区域",
  "search.field.packageTypes": "包类型",
  "search.checkbox.appx": "APPX",
  "search.checkbox.other": "其他",
  "search.status.querying": "正在从 {market} 的 {ring} 通道查询…",
  "search.status.ready": "准备从 {ring} · {market} · {locale} 拉取",
  "search.action.share": "分享",
  "search.action.share.tooltip": "复制带这些参数的分享链接",
  "search.action.share.disabled": "请先输入标识符",
  "search.action.permalink": "直链",
  "search.action.permalink.tooltip": "构建直接跳转到下载文件的永久链接",
  "search.action.permalink.disabled": "请先输入标识符",
  "search.action.permalink.unsupported": "需要 Worker ≥ {version}",
  "search.action.resolve": "解析链接",
  "search.action.resolving": "解析中",

  // PermalinkBuilder
  "permalink.title": "直接下载链接",
  "permalink.subtitle": "一个 GET URL,直接跳转(或代理)到选中的文件。",
  "permalink.section.path": "路径样式",
  "permalink.path.d": "短 — /d/<id>",
  "permalink.path.download": "标准 — /download/<id>",
  "permalink.path.installerDownload": "完整 — /installer/download/<id>",
  "permalink.section.filters": "过滤",
  "permalink.filter.arch": "体系结构",
  "permalink.filter.arch.any": "任意(智能选择)",
  "permalink.filter.match": "匹配(正则)",
  "permalink.filter.match.placeholder": "例:.appxbundle$",
  "permalink.filter.match.invalid": "正则无效",
  "permalink.filter.n": "候选索引",
  "permalink.filter.n.hint": "0 = 最佳;调高以获取次优",
  "permalink.filter.includeFramework": "包含框架包",
  "permalink.filter.includeFramework.hint":
    "VCLibs、.NET Native 等 — 默认隐藏,使选择器锁定主应用。",
  "permalink.filter.includeAuxiliary": "包含 BlockMap 与加密文件",
  "permalink.filter.includeAuxiliary.hint":
    "AppxBlockMap.xml 清单及 DRM 加密的 .eappx / .emsix 变体 —— 默认隐藏,因为它们无法直接安装。",
  "permalink.section.response": "响应",
  "permalink.section.advanced": "高级选项",
  "permalink.response.format": "格式",
  "permalink.response.format.auto": "自动(浏览器跳转,客户端 JSON)",
  "permalink.response.format.auto.short": "自动",
  "permalink.response.format.redirect": "始终跳转(302)",
  "permalink.response.format.redirect.short": "跳转",
  "permalink.response.format.json": "始终 JSON",
  "permalink.response.format.json.short": "JSON",
  "permalink.response.proxy": "通过此 Worker 反向代理",
  "permalink.response.proxy.hint":
    "由服务端流式转发字节,而非跳转。隐藏 FE3 URL,但占用 Worker 带宽。",
  "permalink.badge.proxied": "已代理",
  "permalink.section.locale": "区域覆盖",
  "permalink.locale.toggle": "为此链接使用不同的市场 / 语言",
  "permalink.locale.market": "市场",
  "permalink.locale.lang": "语言标签",
  "permalink.section.preview": "永久链接",
  "permalink.preview.empty": "请先在搜索框输入标识符以生成链接。",
  "permalink.preview.length": "{n} 字符",
  "permalink.preview.length.plural": "{n} 字符",
  "permalink.action.copy": "复制链接",
  "permalink.action.open": "新标签页打开",
  "permalink.action.reset": "重置为默认",
  "permalink.toast.copied": "永久链接已复制",

  // ResultsView
  "results.fileCount": "{count} 个文件",
  "results.fileCount.plural": "{count} 个文件",
  "results.totalSize": "总计 {size}",
  "results.category.tooltip": "WU 类别 ID · 点击复制 · {id}",
  "results.category.label": "类别",
  "results.category.copy": "复制类别 ID",
  "results.filter.placeholder": "按文件名过滤",
  "results.tab.all": "全部",
  "results.tab.appx": "APPX",
  "results.tab.other": "其他",
  "results.tab.blockMap": "BlockMap",
  "results.bulk.selected": "已选 {count} 项 · {size}",
  "results.bulk.copyUrls": "复制 URL",
  "results.bulk.downloadAll": "全部下载",
  "results.bulk.clear": "清空",
  "results.table.aria": "已解析的包",
  "results.table.selectAll": "全选",
  "results.table.selectOne": "选择 {name}",
  "results.table.fileName": "文件名",
  "results.table.type": "类型",
  "results.table.arch": "架构",
  "results.table.size": "大小",
  "results.table.actions": "操作",
  "results.empty": "没有匹配此过滤条件的文件。",
  "results.hash.tooltip": "点击复制 · {hash}",
  "results.hash.copyAria": "复制 SHA-256",
  "results.hash.copyLabel": "SHA-256",
  "results.hash.verifyTooltip": "复制校验哈希命令",
  "results.hash.verifyAria": "复制校验哈希命令",
  "results.hash.shell.powershell": "PowerShell",
  "results.hash.shell.cmd": "命令提示符",
  "results.hash.shell.bash": "Bash (Linux / macOS)",
  "results.hash.shell.powershellLabel": "PowerShell 校验命令",
  "results.hash.shell.cmdLabel": "cmd.exe 校验命令",
  "results.hash.shell.bashLabel": "Bash 校验命令",
  "results.row.copyUrl": "复制 URL",
  "results.row.download": "下载",
  "results.row.open": "在新标签页打开",
  "results.copy.urls": "{count} 个 URL",
  "results.copy.urls.plural": "{count} 个 URL",

  // HistoryDrawer
  "history.title": "最近查询",
  "history.meta": "已保存 {count} 条 · 仅存于本地",
  "history.empty.title": "暂无查询记录",
  "history.empty.body": "你解析过的标识符会出现在这里。",
  "history.item.files": "{count} 个文件",
  "history.item.rerun": "重新运行",
  "history.clearAll": "全部清空",

  // DebugPanel
  "debug.unknownError": "发生未知错误。",
  "debug.warnings.count": "{count} 条警告",
  "debug.warnings.count.plural": "{count} 条警告",
  "debug.diagnostics": "诊断信息",
  "debug.endpoint": "端点:",
  "debug.copyDiagnostics": "复制诊断信息",
  "debug.hide": "隐藏",
  "debug.hideDiagnostics": "隐藏诊断信息",
  "debug.rawJson": "原始 JSON",
  "debug.bundleLabel": "诊断信息包",
  "debug.fact.endpoint": "端点",
  "debug.fact.http": "HTTP",
  "debug.fact.input": "输入",
  "debug.fact.type": "类型",
  "debug.fact.market": "市场",
  "debug.fact.locale": "区域",
  "debug.fact.kind": "错误种类",
  "debug.fact.handler": "处理器错误",

  // ProgressPanel
  "progress.starting": "正在启动",
  "progress.connecting": "正在连接 worker…",
  "progress.counter": "{current} / {total}",

  // NotFoundPage
  "notFound.title": "404 —— 页面未找到",
  "notFound.bodyLead": "找不到 {path}。链接可能已失效,或路径拼写有误。",
  "notFound.linkLead": "返回解析器,或访问",
  "notFound.linkText": "GitHub 上的项目主页",
  "notFound.linkTail": "。",
  "notFound.back": "返回解析器",

  // Relative time
  "time.justNow": "刚刚",
  "time.minutes": "{n} 分钟前",
  "time.hours": "{n} 小时前",
  "time.days": "{n} 天前",

  // Identifier types
  "idType.ProductId.label": "Product ID",
  "idType.ProductId.short": "Product",
  "idType.ProductId.hint": "12 位字母数字 ID,或 apps.microsoft.com 链接",
  "idType.PackageFamilyName.label": "Package Family Name",
  "idType.PackageFamilyName.short": "PFN",
  "idType.PackageFamilyName.hint": "Identity.Name_publisherhash",
  "idType.XboxTitleId.label": "Xbox Title ID",
  "idType.XboxTitleId.short": "Xbox Title",
  "idType.XboxTitleId.hint": "十进制 Xbox 标题标识(4–10 位)",
  "idType.ContentId.label": "Content ID",
  "idType.ContentId.short": "Content",
  "idType.ContentId.hint": "GUID 形式的内容标识符",
  "idType.WuCategoryId.label": "WU Category ID",
  "idType.WuCategoryId.short": "WU 类别",
  "idType.WuCategoryId.hint": "Windows Update(FE3)使用的 GUID — 跳过 DisplayCatalog",
  "idType.LegacyWindowsStoreProductId.label": "旧版 Store Product ID",
  "idType.LegacyWindowsStoreProductId.short": "旧版 Store",
  "idType.LegacyWindowsStoreProductId.hint": "较早的 Windows 8/10 商店标识符",
  "idType.LegacyWindowsPhoneProductId.label": "旧版 Phone Product ID",
  "idType.LegacyWindowsPhoneProductId.short": "旧版 Phone",
  "idType.LegacyWindowsPhoneProductId.hint": "Windows Phone 7/8 产品 GUID",
  "idType.LegacyXboxProductId.label": "旧版 Xbox Product ID",
  "idType.LegacyXboxProductId.short": "旧版 Xbox",
  "idType.LegacyXboxProductId.hint": "Xbox 360 时代的标题 GUID",

  // Rings
  "ring.Retail.label": "正式版",
  "ring.Retail.sub": "稳定",
  "ring.RP.label": "Release Preview",
  "ring.RP.sub": "RP 通道",
  "ring.WIF.label": "Insider Dev",
  "ring.WIF.sub": "快速(WIF)",
  "ring.WIS.label": "Insider Beta",
  "ring.WIS.sub": "慢速(WIS)",

  // Markets
  "market.US": "美国",
  "market.GB": "英国",
  "market.DE": "德国",
  "market.FR": "法国",
  "market.JP": "日本",
  "market.CN": "中国",
  "market.BR": "巴西",
  "market.IN": "印度",
  "market.RU": "俄罗斯",
  "market.KR": "韩国",

  // Stage labels
  "stage.dcat.request": "正在查询 Microsoft Store 目录",
  "stage.dcat.response": "正在接收目录响应",
  "stage.dcat.parse": "正在解析目录数据",
  "stage.dcat.done": "已找到产品",
  "stage.dcat.notFound": "未找到产品",
  "stage.fe3.start": "开始解析安装包",
  "stage.fe3.getCookie": "正在进行 FE3 鉴权",
  "stage.fe3.syncUpdates": "请求安装包更新",
  "stage.fe3.parseUpdateIds": "读取更新 ID",
  "stage.fe3.parseUpdateIds.done": "已找到更新 ID",
  "stage.fe3.parsePackages": "读取安装包元数据",
  "stage.fe3.parsePackages.done": "已解析安装包",
  "stage.fe3.resolveUrls": "正在解析下载 URL",
  "stage.fe3.resolveUrls.done": "下载 URL 已解析",
  "stage.fe3.done": "安装包解析完成",
  "stage.search.request": "发送搜索请求",
  "stage.search.response": "接收搜索响应",
  "stage.search.parse": "解析搜索响应",
  "stage.search.done": "搜索完成",
  "stage.retry.wait": "重试前等待",
  "stage.retry.attempt": "正在重试请求",

  // API error codes
  "api.product.notFound": "未找到产品。",
  "api.product.lookupFailed": "产品查询失败: {detail}",
  "api.packages.fetchFailed": "获取安装包失败: {detail}",
  "api.nonAppx.notFound": "未找到非 Appx 产品。",
  "api.method.notAllowed": "不允许的方法。请使用 POST 并提交 JSON 请求体。",
  "api.request.invalidJson": "无法将请求体解析为 JSON: {detail}",
  "api.productInput.required": "缺少 ProductInput 字段。",
  "api.internal.error": "内部错误: {detail}",
  "api.apiDisabled":
    "此部署的内置解析器已禁用。请在“设置”中将 API 后端指向第三方 QSL 端点才能使用此界面。",
  "api.route.notFound": "API 路由不存在: {path}",

  // Locale warning codes
  "api.locale.unknownMarket": '未知市场 "{raw}",已回退到 "{fallback}"。({detail})',
  "api.locale.unknownLanguageTag": '未知语言标签 "{raw}"。({detail})',
  "api.locale.unknownLanguage": '未知语言 "{raw}"。({detail})',
  "api.locale.tagFailed": 'Locale.fromTag("{tag}") 失败: {detail} —— 已回退到 en-US。',

  // Frontend-originated errors
  "api.client.noDownloadLinks": "此标识符未返回任何下载链接。",
  "api.client.httpError": "后端返回 HTTP {status}",
  "api.client.emptyBody": "后端返回了空响应体。",

  // Used when consuming an older worker that only emits the legacy
  // `Errors: string[]` form — the English message arrives as a param.
  "api.legacy": "{message}",
};

const DICTS: Record<Lang, Dict> = { en, zh };

type TParams = Record<string, string | number> | null | undefined;

export type TFn = (key: string, params?: TParams) => string;

interface I18nValue {
  lang: Lang;
  setLang: (l: Lang) => void;
  t: TFn;
}

const I18nContext = createContext<I18nValue | null>(null);

function detectLang(): Lang {
  try {
    const saved = localStorage.getItem("qsl_lang");
    if (saved === "en" || saved === "zh") return saved;
  } catch {
    /* ignore */
  }
  if (typeof navigator !== "undefined") {
    const n = navigator.language.toLowerCase();
    if (n.startsWith("zh")) return "zh";
  }
  return "en";
}

function interpolate(template: string, params?: TParams): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (_, k: string) => {
    const v = params[k];
    return v == null ? `{${k}}` : String(v);
  });
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(detectLang);

  useEffect(() => {
    try {
      localStorage.setItem("qsl_lang", lang);
    } catch {
      /* ignore */
    }
    if (typeof document !== "undefined") {
      document.documentElement.setAttribute("lang", lang === "zh" ? "zh-CN" : "en");
    }
  }, [lang]);

  const setLang = useCallback((l: Lang) => setLangState(l), []);

  const t = useCallback<TFn>(
    (key, params) => {
      const dict = DICTS[lang];
      const raw = dict[key] ?? DICTS.en[key] ?? key;
      return interpolate(raw, params ?? undefined);
    },
    [lang],
  );

  const value = useMemo<I18nValue>(() => ({ lang, setLang, t }), [lang, setLang, t]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useI18n must be used within I18nProvider");
  return ctx;
}

export function useT(): TFn {
  return useI18n().t;
}

/** Render a worker-emitted {@link ApiCode} as a localized string. */
export function translateApiCode(t: TFn, ac: ApiCode): string {
  return t(`api.${ac.code}`, ac.params ?? undefined);
}
