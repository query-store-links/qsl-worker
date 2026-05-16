import { useEffect, useState } from "react";
import {
  Button,
  Divider,
  Field,
  Input,
  Popover,
  PopoverSurface,
  PopoverTrigger,
  Text,
  Tooltip,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import {
  HistoryRegular,
  SettingsRegular,
  WeatherMoonRegular,
  WeatherSunnyRegular,
  LinkRegular,
  GlobeRegular,
} from "@fluentui/react-icons";

export interface AppSettings {
  backend: string;
  customMarket: string;
  locale: string;
}

export const DEFAULT_BACKEND = "";

interface TopBarProps {
  isDark: boolean;
  setIsDark: (v: boolean) => void;
  settings: AppSettings;
  setSettings: (v: AppSettings | ((p: AppSettings) => AppSettings)) => void;
  onOpenHistory: () => void;
  historyCount: number;
}

const useStyles = makeStyles({
  header: {
    position: "sticky",
    top: 0,
    zIndex: 50,
    backgroundColor: `color-mix(in srgb, ${tokens.colorNeutralBackground2} 88%, transparent)`,
    backdropFilter: "saturate(140%) blur(12px)",
    WebkitBackdropFilter: "saturate(140%) blur(12px)",
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  inner: {
    maxWidth: "1240px",
    margin: "0 auto",
    height: "56px",
    padding: "0 24px",
    display: "flex",
    alignItems: "center",
    columnGap: "16px",
    "@media (max-width: 600px)": {
      padding: "0 12px",
      columnGap: "8px",
    },
  },
  brand: {
    display: "flex",
    alignItems: "center",
    columnGap: "10px",
    minWidth: 0,
    flexShrink: 1,
  },
  logo: {
    width: "28px",
    height: "28px",
    display: "block",
    flexShrink: 0,
  },
  brandText: {
    display: "flex",
    flexDirection: "column",
    lineHeight: 1.1,
    minWidth: 0,
    overflow: "hidden",
  },
  brandTitle: {
    fontSize: "14px",
    fontWeight: 600,
    letterSpacing: "-0.1px",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  brandSub: {
    fontSize: "11px",
    color: tokens.colorNeutralForeground3,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  spacer: { flex: 1 },
  pill: {
    display: "inline-flex",
    alignItems: "center",
    columnGap: "6px",
    height: "28px",
    padding: "0 10px",
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    borderRadius: tokens.borderRadiusCircular,
    color: tokens.colorNeutralForeground2,
    fontSize: "12px",
    fontWeight: 500,
    cursor: "pointer",
    fontFamily: "inherit",
  },
  pillDot: {
    width: "6px",
    height: "6px",
    borderRadius: "999px",
    backgroundColor: tokens.colorPaletteGreenForeground1,
    boxShadow: `0 0 0 2px color-mix(in srgb, ${tokens.colorPaletteGreenForeground1} 25%, transparent)`,
  },
  pillText: {
    maxWidth: "220px",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  historyBadge: {
    position: "absolute",
    top: "2px",
    right: "2px",
    minWidth: "16px",
    height: "16px",
    padding: "0 4px",
    backgroundColor: tokens.colorBrandBackground,
    color: tokens.colorNeutralForegroundOnBrand,
    fontSize: "10px",
    fontWeight: 700,
    borderRadius: tokens.borderRadiusCircular,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    border: `1.5px solid ${tokens.colorNeutralBackground2}`,
    pointerEvents: "none",
  },
  historyWrap: { position: "relative" },
  popover: { width: "380px" },
  popoverInner: { display: "flex", flexDirection: "column", rowGap: "14px", padding: "4px" },
  popoverHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    fontSize: "14px",
    fontWeight: 600,
  },
  popoverHint: {
    fontSize: "11px",
    color: tokens.colorNeutralForeground3,
  },
  twoCol: {
    display: "grid",
    // `minmax(0, 1fr)` lets the grid shrink past the children's intrinsic
    // min-width — Fluent `Input` has an ~120px default which would otherwise
    // overflow this 380px popover.
    gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)",
    columnGap: "10px",
  },
  fieldFill: { minWidth: 0 },
  inputFill: { width: "100%", minWidth: 0 },
  footer: {
    display: "flex",
    columnGap: "8px",
    justifyContent: "flex-end",
  },
});

export function TopBar({
  isDark,
  setIsDark,
  settings,
  setSettings,
  onOpenHistory,
  historyCount,
}: TopBarProps) {
  const styles = useStyles();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<AppSettings>(settings);

  useEffect(() => {
    if (open) setDraft(settings);
  }, [open, settings]);

  const apply = () => {
    setSettings(draft);
    setOpen(false);
  };
  const reset = () => setDraft({ backend: DEFAULT_BACKEND, customMarket: "", locale: "en-US" });

  const backendLabel = settings.backend ? settings.backend.replace(/^https?:\/\//, "") : null;

  return (
    <header className={styles.header}>
      <div className={styles.inner}>
        <div className={styles.brand}>
          <img src="/favicon.svg" alt="" aria-hidden className={styles.logo} />
          <div className={styles.brandText}>
            <Text className={styles.brandTitle}>Query Store Links</Text>
            <Text className={styles.brandSub}>MSIX bundle resolver</Text>
          </div>
        </div>

        <div className={styles.spacer} />

        <Tooltip content="Backend · click to configure" relationship="label">
          <button type="button" className={styles.pill} onClick={() => setOpen(true)}>
            <span className={styles.pillDot} aria-hidden />
            {backendLabel && <Text className={`qsl-mono ${styles.pillText}`}>{backendLabel}</Text>}
          </button>
        </Tooltip>

        <div className={styles.historyWrap}>
          <Tooltip content="Recent searches" relationship="label">
            <Button
              appearance="subtle"
              icon={<HistoryRegular />}
              onClick={onOpenHistory}
              aria-label="Recent searches"
            />
          </Tooltip>
          {historyCount > 0 && (
            <Text className={styles.historyBadge}>{historyCount > 9 ? "9+" : historyCount}</Text>
          )}
        </div>

        <Tooltip content={isDark ? "Switch to light" : "Switch to dark"} relationship="label">
          <Button
            appearance="subtle"
            icon={isDark ? <WeatherSunnyRegular /> : <WeatherMoonRegular />}
            onClick={() => setIsDark(!isDark)}
            aria-label="Toggle theme"
          />
        </Tooltip>

        <Popover
          open={open}
          onOpenChange={(_, d) => setOpen(d.open)}
          positioning="below-end"
          trapFocus
        >
          <PopoverTrigger disableButtonEnhancement>
            <Tooltip content="Configuration" relationship="label">
              <Button appearance="subtle" icon={<SettingsRegular />} aria-label="Settings" />
            </Tooltip>
          </PopoverTrigger>
          <PopoverSurface className={styles.popover}>
            <div className={styles.popoverInner}>
              <div className={styles.popoverHeader}>Configuration</div>

              <Field
                label="API Backend"
                hint="The QSL backend that resolves identifiers to download URLs. Leave empty to use the same-origin worker."
              >
                <Input
                  contentBefore={<LinkRegular />}
                  value={draft.backend}
                  onChange={(_, d) => setDraft({ ...draft, backend: d.value })}
                  placeholder="https://qsl-api.example.com"
                />
              </Field>

              <div className={styles.twoCol}>
                <Field label="Market override" className={styles.fieldFill}>
                  <Input
                    className={styles.inputFill}
                    contentBefore={<GlobeRegular />}
                    value={draft.customMarket}
                    onChange={(_, d) =>
                      setDraft({ ...draft, customMarket: d.value.toUpperCase().slice(0, 2) })
                    }
                    placeholder="auto"
                  />
                </Field>
                <Field label="Locale" className={styles.fieldFill}>
                  <Input
                    className={styles.inputFill}
                    value={draft.locale}
                    onChange={(_, d) => setDraft({ ...draft, locale: d.value })}
                    placeholder="en-US"
                  />
                </Field>
              </div>

              <Divider />

              <div className={styles.footer}>
                <Button appearance="subtle" onClick={reset}>
                  Reset
                </Button>
                <Button appearance="primary" onClick={apply}>
                  Apply
                </Button>
              </div>
            </div>
          </PopoverSurface>
        </Popover>
      </div>
    </header>
  );
}
