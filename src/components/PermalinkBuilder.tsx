import { useEffect, useMemo } from "react";
import {
  Accordion,
  AccordionHeader,
  AccordionItem,
  AccordionPanel,
  Badge,
  Body1,
  Body1Strong,
  Button,
  Caption1,
  Divider,
  Drawer,
  DrawerBody,
  DrawerHeader,
  DrawerHeaderTitle,
  Dropdown,
  Field,
  Input,
  Option,
  Radio,
  RadioGroup,
  Switch,
  Text,
  Tooltip,
  makeStyles,
  mergeClasses,
  tokens,
} from "@fluentui/react-components";
import {
  ArrowResetRegular,
  CopyRegular,
  DismissRegular,
  LinkRegular,
  OpenRegular,
} from "@fluentui/react-icons";
import {
  DEFAULT_PERMALINK_OPTIONS,
  buildPermalink,
  type PermalinkOptions,
  type PermalinkPathStyle,
  type SearchFormData,
} from "../shared";
import { useLocalState } from "../hooks";
import { useT } from "../i18n";

interface PermalinkBuilderProps {
  open: boolean;
  onDismiss: () => void;
  form: SearchFormData;
  /** Same-origin app base (e.g. `https://qsl.example.com`). Defaults to
   *  `window.location.origin` when omitted — pass an override for testing. */
  origin?: string;
  onCopy: (text: string, what: string) => void;
}

const PATH_STYLES: readonly PermalinkPathStyle[] = ["d", "download", "installerDownload"];
const ARCH_OPTIONS: readonly PermalinkOptions["arch"][] = ["", "x64", "arm64", "x86", "neutral"];
const FORMAT_OPTIONS: readonly PermalinkOptions["format"][] = ["auto", "redirect", "json"];

const PATH_PREFIX: Record<PermalinkPathStyle, string> = {
  d: "/d/",
  download: "/download/",
  installerDownload: "/installer/download/",
};

const useStyles = makeStyles({
  drawer: { width: "560px", maxWidth: "94vw" },
  meta: {
    display: "block",
    fontSize: "12px",
    color: tokens.colorNeutralForeground3,
    marginTop: "6px",
    fontWeight: tokens.fontWeightRegular,
  },
  body: {
    display: "flex",
    flexDirection: "column",
    rowGap: "16px",
    paddingBottom: "16px",
  },

  // ── URL hero ──────────────────────────────────────────────────────────
  urlCard: {
    display: "flex",
    flexDirection: "column",
    rowGap: "10px",
    padding: "14px 16px",
    borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  urlText: {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace",
    fontSize: "13px",
    lineHeight: 1.5,
    wordBreak: "break-all",
    color: tokens.colorNeutralForeground1,
    // Keep very long URLs from blowing out the drawer — show ~5 lines, then
    // scroll. The Copy button still grabs the full URL either way.
    maxHeight: "7.5em",
    overflowY: "auto",
  },
  urlEmpty: {
    color: tokens.colorNeutralForeground3,
    fontStyle: "italic",
    fontSize: "13px",
  },
  urlMetaRow: {
    display: "flex",
    alignItems: "center",
    columnGap: "8px",
    flexWrap: "wrap",
    color: tokens.colorNeutralForeground3,
  },
  monoBadge: {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace",
  },
  metaSep: { color: tokens.colorNeutralForeground4 },
  actionRow: {
    display: "flex",
    alignItems: "center",
    columnGap: "8px",
    flexWrap: "wrap",
  },
  actionSpacer: { flex: 1 },

  // ── Quick options ─────────────────────────────────────────────────────
  quickGrid: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    columnGap: "12px",
    rowGap: "10px",
    alignItems: "start",
  },
  fullWidth: { width: "100%" },
  // Fluent's `Input` ships with a default min-width that overflows narrow
  // grid cells (the second column in `fieldGrid` ends up visually wider
  // than the first). Force it to fill the cell and shrink with the track.
  fullWidthInput: {
    width: "100%",
    minWidth: 0,
    "& input": { minWidth: 0 },
  },
  switchRow: {
    display: "flex",
    flexDirection: "column",
    rowGap: "2px",
  },
  switchHint: { color: tokens.colorNeutralForeground3 },

  // ── Advanced ──────────────────────────────────────────────────────────
  advancedItem: {
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground1,
  },
  advancedHeader: {
    "& button": {
      paddingLeft: "12px",
      paddingRight: "12px",
    },
  },
  advancedBody: {
    display: "flex",
    flexDirection: "column",
    rowGap: "16px",
    padding: "4px 12px 12px",
  },
  fieldGrid: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    columnGap: "12px",
    rowGap: "10px",
    // Grid items stretch by default — when one Field has a hint and the
    // other doesn't, the hint-less Input grows vertically to match the
    // taller cell. Anchor everyone to the top so heights are intrinsic.
    alignItems: "start",
  },
  pathRadioGroup: {
    display: "flex",
    flexDirection: "column",
    rowGap: "4px",
  },
  pathRadioLabel: {
    display: "flex",
    alignItems: "center",
    columnGap: "6px",
  },
  subsectionLabel: {
    color: tokens.colorNeutralForeground2,
    fontSize: "12px",
    fontWeight: 600,
  },
  localeBox: {
    display: "flex",
    flexDirection: "column",
    rowGap: "10px",
    padding: "10px 12px",
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground2,
  },
});

function tryCompileRegex(s: string): RegExp | null | false {
  if (!s) return null;
  try {
    return new RegExp(s, "i");
  } catch {
    return false;
  }
}

const STORAGE_KEY = "qsl_permalink_opts";

export function PermalinkBuilder({ open, onDismiss, form, origin, onCopy }: PermalinkBuilderProps) {
  const styles = useStyles();
  const t = useT();

  // Persist the builder's knobs across sessions so the user's preferred
  // path style / arch / proxy mode survives reloads. Defaults come from
  // shared.ts so worker + UI agree.
  const [opts, setOpts] = useLocalState<PermalinkOptions>(STORAGE_KEY, DEFAULT_PERMALINK_OPTIONS);

  // When the drawer opens, prefill the locale-override fields from the
  // current search state so the user has sensible defaults if they enable
  // the override toggle. We deliberately don't *enable* the toggle here —
  // that stays sticky from last use.
  useEffect(() => {
    if (!open) return;
    setOpts((p) => ({
      ...p,
      market: p.market || form.market || "US",
      lang: p.lang || form.locale || "en-US",
    }));
  }, [open, form.market, form.locale, setOpts]);

  const set = <K extends keyof PermalinkOptions>(k: K, v: PermalinkOptions[K]): void =>
    setOpts((p) => ({ ...p, [k]: v }));

  const computedOrigin = origin ?? (typeof window !== "undefined" ? window.location.origin : "");
  const url = useMemo(
    () => buildPermalink(computedOrigin, form.productInput, form.identifierType, opts),
    [computedOrigin, form.productInput, form.identifierType, opts],
  );

  const regexCheck = useMemo(() => tryCompileRegex(opts.match), [opts.match]);
  const regexInvalid = regexCheck === false;

  const copy = async () => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      onCopy(url, t("permalink.toast.copied"));
    } catch {
      onCopy(url, t("permalink.toast.copied"));
    }
  };

  const openInTab = () => {
    if (!url) return;
    window.open(url, "_blank", "noopener,noreferrer");
  };

  const reset = () => setOpts(DEFAULT_PERMALINK_OPTIONS);

  const charCount = url.length;
  const charLabel =
    charCount === 1
      ? t("permalink.preview.length", { n: charCount })
      : t("permalink.preview.length.plural", { n: charCount });

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
              aria-label={t("common.close")}
              onClick={onDismiss}
            />
          }
        >
          {t("permalink.title")}
          <Caption1 block className={styles.meta}>
            {t("permalink.subtitle")}
          </Caption1>
        </DrawerHeaderTitle>
      </DrawerHeader>

      <DrawerBody>
        <div className={styles.body}>
          {/* URL hero ─────────────────────────────────────────────────── */}
          <div className={styles.urlCard}>
            {url ? (
              <>
                <Text className={styles.urlText}>{url}</Text>
                <div className={styles.urlMetaRow}>
                  <Badge appearance="tint" size="small" className={styles.monoBadge}>
                    {PATH_PREFIX[opts.pathStyle]}
                  </Badge>
                  {opts.proxy && (
                    <Badge appearance="outline" size="small" color="brand">
                      {t("permalink.badge.proxied")}
                    </Badge>
                  )}
                  <Text as="span" className={styles.metaSep}>
                    ·
                  </Text>
                  <Caption1>{charLabel}</Caption1>
                </div>
              </>
            ) : (
              <Body1 className={styles.urlEmpty}>{t("permalink.preview.empty")}</Body1>
            )}
          </div>

          <div className={styles.actionRow}>
            <Tooltip content={t("permalink.action.copy")} relationship="label">
              <Button appearance="primary" icon={<CopyRegular />} onClick={copy} disabled={!url}>
                {t("permalink.action.copy")}
              </Button>
            </Tooltip>
            <Button appearance="outline" icon={<OpenRegular />} onClick={openInTab} disabled={!url}>
              {t("permalink.action.open")}
            </Button>
            <div className={styles.actionSpacer} />
            <Button appearance="subtle" icon={<ArrowResetRegular />} onClick={reset}>
              {t("permalink.action.reset")}
            </Button>
          </div>

          <Divider />

          {/* Quick options ────────────────────────────────────────────── */}
          <div className={styles.quickGrid}>
            <Field label={t("permalink.filter.arch")}>
              <Dropdown
                className={styles.fullWidth}
                value={opts.arch ? opts.arch : t("permalink.filter.arch.any")}
                selectedOptions={[opts.arch]}
                onOptionSelect={(_, d) =>
                  set("arch", (d.optionValue ?? "") as PermalinkOptions["arch"])
                }
              >
                {ARCH_OPTIONS.map((a) => (
                  <Option key={a || "any"} value={a} text={a || t("permalink.filter.arch.any")}>
                    {a || t("permalink.filter.arch.any")}
                  </Option>
                ))}
              </Dropdown>
            </Field>
            <Field label={t("permalink.response.format")}>
              <Dropdown
                className={styles.fullWidth}
                value={t(`permalink.response.format.${opts.format}.short`)}
                selectedOptions={[opts.format]}
                onOptionSelect={(_, d) =>
                  set("format", (d.optionValue ?? "auto") as PermalinkOptions["format"])
                }
              >
                {FORMAT_OPTIONS.map((f) => (
                  <Option key={f} value={f} text={t(`permalink.response.format.${f}.short`)}>
                    {t(`permalink.response.format.${f}`)}
                  </Option>
                ))}
              </Dropdown>
            </Field>
          </div>

          <div className={styles.switchRow}>
            <Switch
              checked={opts.proxy}
              onChange={(_, d) => set("proxy", d.checked)}
              label={t("permalink.response.proxy")}
            />
            <Caption1 className={styles.switchHint}>{t("permalink.response.proxy.hint")}</Caption1>
          </div>

          {/* Advanced ─────────────────────────────────────────────────── */}
          <Accordion collapsible>
            <AccordionItem value="advanced" className={styles.advancedItem}>
              <AccordionHeader expandIconPosition="end" className={styles.advancedHeader}>
                <Body1Strong>{t("permalink.section.advanced")}</Body1Strong>
              </AccordionHeader>
              <AccordionPanel>
                <div className={styles.advancedBody}>
                  {/* Path style */}
                  <Field label={t("permalink.section.path")}>
                    <RadioGroup
                      value={opts.pathStyle}
                      onChange={(_, d) => set("pathStyle", d.value as PermalinkPathStyle)}
                      className={styles.pathRadioGroup}
                    >
                      {PATH_STYLES.map((p) => (
                        <Radio
                          key={p}
                          value={p}
                          label={
                            <Text
                              as="span"
                              className={mergeClasses("qsl-mono", styles.pathRadioLabel)}
                            >
                              {t(`permalink.path.${p}`)}
                            </Text>
                          }
                        />
                      ))}
                    </RadioGroup>
                  </Field>

                  {/* Candidate index + filename regex */}
                  <div className={styles.fieldGrid}>
                    <Field
                      label={t("permalink.filter.n")}
                      hint={<Caption1>{t("permalink.filter.n.hint")}</Caption1>}
                    >
                      <Input
                        className={styles.fullWidthInput}
                        type="number"
                        min={0}
                        value={String(opts.n)}
                        onChange={(_, d) => {
                          const n = parseInt(d.value, 10);
                          set("n", Number.isFinite(n) && n >= 0 ? n : 0);
                        }}
                      />
                    </Field>
                    <Field
                      label={t("permalink.filter.match")}
                      validationState={regexInvalid ? "error" : "none"}
                      validationMessage={
                        regexInvalid ? t("permalink.filter.match.invalid") : undefined
                      }
                    >
                      <Input
                        className={styles.fullWidthInput}
                        value={opts.match}
                        onChange={(_, d) => set("match", d.value)}
                        placeholder={t("permalink.filter.match.placeholder")}
                      />
                    </Field>
                  </div>

                  {/* Include framework */}
                  <div className={styles.switchRow}>
                    <Switch
                      checked={opts.includeFramework}
                      onChange={(_, d) => set("includeFramework", d.checked)}
                      label={t("permalink.filter.includeFramework")}
                    />
                    <Caption1 className={styles.switchHint}>
                      {t("permalink.filter.includeFramework.hint")}
                    </Caption1>
                  </div>

                  {/* Include block-map / encrypted */}
                  <div className={styles.switchRow}>
                    <Switch
                      checked={opts.includeAuxiliary}
                      onChange={(_, d) => set("includeAuxiliary", d.checked)}
                      label={t("permalink.filter.includeAuxiliary")}
                    />
                    <Caption1 className={styles.switchHint}>
                      {t("permalink.filter.includeAuxiliary.hint")}
                    </Caption1>
                  </div>

                  {/* Locale override */}
                  <div className={styles.localeBox}>
                    <Switch
                      checked={opts.overrideLocale}
                      onChange={(_, d) => set("overrideLocale", d.checked)}
                      label={t("permalink.locale.toggle")}
                    />
                    {opts.overrideLocale && (
                      <div className={styles.fieldGrid}>
                        <Field label={t("permalink.locale.market")}>
                          <Input
                            className={styles.fullWidthInput}
                            value={opts.market}
                            onChange={(_, d) => set("market", d.value.toUpperCase())}
                            maxLength={4}
                          />
                        </Field>
                        <Field label={t("permalink.locale.lang")}>
                          <Input
                            className={styles.fullWidthInput}
                            value={opts.lang}
                            onChange={(_, d) => set("lang", d.value)}
                            placeholder="en-US"
                          />
                        </Field>
                      </div>
                    )}
                  </div>
                </div>
              </AccordionPanel>
            </AccordionItem>
          </Accordion>
        </div>
      </DrawerBody>
    </Drawer>
  );
}

export const PermalinkBuilderIcon = LinkRegular;
