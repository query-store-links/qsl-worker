import { useEffect, useMemo, useRef } from "react";
import {
  Body1,
  Body1Strong,
  Button,
  Caption1,
  Card,
  Checkbox,
  Dropdown,
  Field,
  Input,
  Label,
  Option,
  ProgressBar,
  Text,
  Tooltip,
  makeStyles,
  mergeClasses,
  tokens,
} from "@fluentui/react-components";
import {
  ArrowRightRegular,
  CheckmarkCircleRegular,
  DismissRegular,
  ErrorCircleRegular,
  InfoRegular,
  KeyboardRegular,
  SearchRegular,
  ShareRegular,
  ShieldRegular,
} from "@fluentui/react-icons";
import {
  ID_TYPES,
  ID_TYPE_BY_VALUE,
  LOCALES,
  MARKETS,
  RINGS,
  detectIdentifierType,
  type Ring,
  type SearchFormData,
} from "../shared";

interface SearchCardProps {
  form: SearchFormData;
  setForm: (v: SearchFormData | ((p: SearchFormData) => SearchFormData)) => void;
  onResolve: () => void;
  loading: boolean;
  onAbort: () => void;
  shareUrl: string;
  onCopyShare: () => void;
}

const useStyles = makeStyles({
  card: {
    padding: "24px",
    rowGap: "0",
  },
  headerRow: {
    display: "flex",
    alignItems: "flex-end",
    columnGap: "16px",
    marginBottom: "6px",
  },
  headerLeft: { flex: 1 },
  headerHint: {
    fontSize: "12px",
    color: tokens.colorNeutralForeground3,
    marginTop: "2px",
    display: "block",
  },
  kbd: {
    display: "inline-flex",
    alignItems: "center",
    columnGap: "4px",
    fontSize: "11px",
    color: tokens.colorNeutralForeground3,
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    borderRadius: tokens.borderRadiusSmall,
    padding: "2px 6px",
    backgroundColor: tokens.colorNeutralBackground2,
  },
  inputWrap: { marginTop: "8px" },
  detection: {
    display: "flex",
    alignItems: "center",
    columnGap: "8px",
    minHeight: "22px",
    marginTop: "8px",
    fontSize: "12px",
  },
  detectionLink: {
    height: "auto",
    padding: "1px 6px",
    minHeight: "20px",
    fontSize: "11px",
  },
  pickerWrap: { marginTop: "16px" },
  pickerLabel: { marginBottom: "8px", display: "block" },
  pickerRow: { display: "flex", flexWrap: "wrap", columnGap: "6px", rowGap: "6px" },
  pillBase: {
    display: "inline-flex",
    alignItems: "center",
    columnGap: "6px",
    height: "30px",
    padding: "0 12px",
    fontFamily: "inherit",
    fontSize: "13px",
    fontWeight: 500,
    borderTop: `1px solid ${tokens.colorNeutralStroke1}`,
    borderRight: `1px solid ${tokens.colorNeutralStroke1}`,
    borderBottom: `1px solid ${tokens.colorNeutralStroke1}`,
    borderLeft: `1px solid ${tokens.colorNeutralStroke1}`,
    backgroundColor: tokens.colorNeutralBackground1,
    color: tokens.colorNeutralForeground2,
    borderRadius: tokens.borderRadiusCircular,
    cursor: "pointer",
    position: "relative",
  },
  pillActive: {
    borderTopColor: tokens.colorBrandStroke1,
    borderRightColor: tokens.colorBrandStroke1,
    borderBottomColor: tokens.colorBrandStroke1,
    borderLeftColor: tokens.colorBrandStroke1,
    backgroundColor: tokens.colorBrandBackground2,
    color: tokens.colorBrandForeground1,
  },
  detectDot: {
    width: "6px",
    height: "6px",
    borderRadius: "999px",
    backgroundColor: tokens.colorPaletteGreenForeground1,
  },
  filtersGrid: {
    marginTop: "16px",
    display: "grid",
    // `min(180px, 100%)` lets the column shrink below 180px when the
    // container itself is narrower, so the grid never overflows its parent.
    gridTemplateColumns: "repeat(auto-fit, minmax(min(180px, 100%), 1fr))",
    columnGap: "12px",
    rowGap: "12px",
  },
  // Grid items default to `min-width: auto`, which lets a wide Dropdown
  // (e.g. "United States") force the column wider than its 1fr share and
  // overflow into the neighbouring cell. `min-width: 0` lets the cell
  // shrink to the column track instead.
  filtersCell: { minWidth: 0 },
  // Fluent UI's Dropdown ships with its own default width (~250px) and a
  // `min-width: 250px` on the button — so the cell shrinks but the
  // Dropdown stays wide and overlaps the neighbouring cell. Force both
  // the button and its internal listbox trigger to fill the cell.
  fullWidthDropdown: {
    width: "100%",
    minWidth: 0,
    "& > button": { minWidth: 0, width: "100%" },
  },
  pkgRow: {
    minHeight: "32px",
    display: "flex",
    alignItems: "center",
    flexWrap: "wrap",
    columnGap: "16px",
    rowGap: "4px",
    padding: "0 4px",
    marginTop: "4px",
  },
  progress: { marginTop: "18px" },
  actionRow: {
    marginTop: "18px",
    display: "flex",
    flexWrap: "wrap",
    justifyContent: "space-between",
    alignItems: "center",
    columnGap: "12px",
    rowGap: "12px",
  },
  statusLine: {
    display: "flex",
    alignItems: "center",
    columnGap: "8px",
    color: tokens.colorNeutralForeground3,
    fontSize: "12px",
  },
  statusDot: {
    width: "6px",
    height: "6px",
    borderRadius: "999px",
    backgroundColor: tokens.colorNeutralForeground4,
  },
  statusDotActive: { backgroundColor: tokens.colorBrandBackground },
  buttonGroup: { display: "flex", columnGap: "8px" },
});

export function SearchCard({
  form,
  setForm,
  onResolve,
  loading,
  onAbort,
  shareUrl,
  onCopyShare,
}: SearchCardProps) {
  const styles = useStyles();
  const inputRef = useRef<HTMLInputElement>(null);
  const set = <K extends keyof SearchFormData>(k: K, v: SearchFormData[K]) =>
    setForm((p) => ({ ...p, [k]: v }));

  const detected = useMemo(() => detectIdentifierType(form.productInput), [form.productInput]);
  const detectionMatch = detected != null && detected === form.identifierType;
  const detectionMismatch = detected != null && detected !== form.identifierType;
  const meta = ID_TYPE_BY_VALUE[form.identifierType];
  const validates = !!form.productInput && meta.pattern.test(form.productInput.trim());

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        if (!loading && form.productInput) onResolve();
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [form.productInput, loading, onResolve]);

  return (
    <Card className={styles.card}>
      <div className={styles.headerRow}>
        <div className={styles.headerLeft}>
          <Label htmlFor="qsl-input" size="large" required>
            Identifier
          </Label>
          <Caption1 className={styles.headerHint}>
            Paste a Product ID, Package Family Name, Xbox Title ID, or apps.microsoft.com URL.
          </Caption1>
        </div>
        <Tooltip content="Focus: Ctrl+K" relationship="label">
          <Text as="span" className={styles.kbd}>
            <KeyboardRegular fontSize={12} />{" "}
            <Text as="span" className="qsl-mono">
              Ctrl+K
            </Text>
          </Text>
        </Tooltip>
      </div>

      <div className={styles.inputWrap}>
        <Input
          ref={inputRef}
          id="qsl-input"
          size="large"
          contentBefore={<SearchRegular />}
          placeholder={meta.example}
          value={form.productInput}
          onChange={(_, d) => set("productInput", d.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !loading && form.productInput) onResolve();
          }}
          contentAfter={
            form.productInput ? (
              <Button
                size="small"
                appearance="transparent"
                icon={<DismissRegular />}
                aria-label="Clear"
                onClick={() => set("productInput", "")}
              />
            ) : null
          }
        />

        <div className={styles.detection}>
          {form.productInput ? (
            detectionMatch ? (
              <>
                <CheckmarkCircleRegular
                  fontSize={14}
                  style={{ color: tokens.colorPaletteGreenForeground1 }}
                />
                <Body1Strong style={{ color: tokens.colorPaletteGreenForeground1 }}>
                  Detected:
                </Body1Strong>
                <Body1>{meta.label}</Body1>
              </>
            ) : detectionMismatch ? (
              <>
                <InfoRegular fontSize={14} style={{ color: tokens.colorBrandForeground1 }} />
                <Body1>Looks like a</Body1>
                <Button
                  appearance="primary"
                  size="small"
                  className={styles.detectionLink}
                  onClick={() => set("identifierType", detected!)}
                >
                  {ID_TYPE_BY_VALUE[detected!].label}
                </Button>
                <Caption1>— switch?</Caption1>
              </>
            ) : validates ? (
              <>
                <CheckmarkCircleRegular
                  fontSize={14}
                  style={{ color: tokens.colorPaletteGreenForeground1 }}
                />
                <Caption1>Matches {meta.label} format.</Caption1>
              </>
            ) : (
              <>
                <ErrorCircleRegular
                  fontSize={14}
                  style={{ color: tokens.colorPaletteDarkOrangeForeground1 }}
                />
                <Caption1>
                  Doesn&apos;t match {meta.label} — try a different type or fix the value.
                </Caption1>
              </>
            )
          ) : (
            <Caption1>
              <Text as="span" className="qsl-mono">
                {meta.example}
              </Text>{" "}
              · {meta.hint}
            </Caption1>
          )}
        </div>
      </div>

      <div className={styles.pickerWrap}>
        <Label size="small" className={styles.pickerLabel}>
          Identifier type
        </Label>
        <div className={styles.pickerRow}>
          {ID_TYPES.map((t) => {
            const active = t.value === form.identifierType;
            return (
              <button
                key={t.value}
                type="button"
                onClick={() => set("identifierType", t.value)}
                title={t.hint}
                className={mergeClasses(styles.pillBase, active && styles.pillActive)}
              >
                {t.group === "legacy" && <ShieldRegular fontSize={12} />}
                {t.short}
                {detected === t.value && form.productInput && !active && (
                  <span className={styles.detectDot} aria-hidden />
                )}
              </button>
            );
          })}
        </div>
      </div>

      <div className={styles.filtersGrid}>
        <Field label="Ring" className={styles.filtersCell}>
          <Dropdown
            className={styles.fullWidthDropdown}
            value={RINGS.find((r) => r.value === form.ring)?.label ?? form.ring}
            selectedOptions={[form.ring]}
            onOptionSelect={(_, d) => d.optionValue && set("ring", d.optionValue as Ring)}
          >
            {RINGS.map((r) => (
              <Option key={r.value} value={r.value} text={`${r.label} — ${r.sub}`}>
                {r.label} — {r.sub}
              </Option>
            ))}
          </Dropdown>
        </Field>
        <Field label="Market" className={styles.filtersCell}>
          <Dropdown
            className={styles.fullWidthDropdown}
            value={MARKETS.find((m) => m.value === form.market)?.label ?? form.market}
            selectedOptions={[form.market]}
            onOptionSelect={(_, d) => d.optionValue && set("market", d.optionValue)}
          >
            {MARKETS.map((m) => (
              <Option key={m.value} value={m.value} text={`${m.label} (${m.value})`}>
                {m.label} ({m.value})
              </Option>
            ))}
          </Dropdown>
        </Field>
        <Field label="Locale" className={styles.filtersCell}>
          <Dropdown
            className={styles.fullWidthDropdown}
            value={form.locale}
            selectedOptions={[form.locale]}
            onOptionSelect={(_, d) => d.optionValue && set("locale", d.optionValue)}
          >
            {LOCALES.map((l) => (
              <Option key={l} value={l}>
                {l}
              </Option>
            ))}
          </Dropdown>
        </Field>
        <Field label="Package types" className={styles.filtersCell}>
          <div className={styles.pkgRow}>
            <Checkbox
              checked={form.includeAppx}
              onChange={(_, d) => set("includeAppx", !!d.checked)}
              label="APPX"
            />
            <Checkbox
              checked={form.includeNonAppx}
              onChange={(_, d) => set("includeNonAppx", !!d.checked)}
              label="Other"
            />
          </div>
        </Field>
      </div>

      {loading && <ProgressBar className={styles.progress} />}

      <div className={styles.actionRow}>
        <div className={styles.statusLine}>
          <span
            className={mergeClasses(styles.statusDot, loading && styles.statusDotActive)}
            aria-hidden
          />
          {loading ? (
            <Text as="span">
              Querying <Body1Strong>{form.ring}</Body1Strong> on{" "}
              <Body1Strong>{form.market}</Body1Strong>…
            </Text>
          ) : (
            <Text as="span">
              Ready to fetch from <Body1Strong>{form.ring}</Body1Strong> ·{" "}
              <Body1Strong>{form.market}</Body1Strong> · <Body1Strong>{form.locale}</Body1Strong>
            </Text>
          )}
        </div>
        <div className={styles.buttonGroup}>
          {loading && (
            <Button appearance="subtle" onClick={onAbort}>
              Cancel
            </Button>
          )}
          <Tooltip
            content={
              shareUrl ? "Copy a shareable URL with these params" : "Enter an identifier first"
            }
            relationship="label"
          >
            <Button
              appearance="outline"
              icon={<ShareRegular />}
              onClick={onCopyShare}
              disabled={!shareUrl}
            >
              Share
            </Button>
          </Tooltip>
          <Button
            appearance="primary"
            icon={loading ? undefined : <ArrowRightRegular />}
            iconPosition="after"
            disabled={loading || !form.productInput || (!form.includeAppx && !form.includeNonAppx)}
            onClick={onResolve}
          >
            {loading ? "Resolving" : "Resolve links"}
          </Button>
        </div>
      </div>
    </Card>
  );
}
