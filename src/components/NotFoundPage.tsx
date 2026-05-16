import { Body1, Button, Card, Link, Title1, makeStyles, tokens } from "@fluentui/react-components";
import { ArrowLeftRegular, ErrorCircleRegular } from "@fluentui/react-icons";

interface NotFoundPageProps {
  path: string;
  onHome: () => void;
}

const useStyles = makeStyles({
  wrap: {
    minHeight: "100vh",
    display: "grid",
    placeItems: "center",
    backgroundColor: tokens.colorNeutralBackground2,
    padding: "32px",
  },
  card: {
    padding: "48px",
    maxWidth: "560px",
    width: "100%",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    rowGap: "16px",
    textAlign: "center",
  },
  halo: {
    width: "72px",
    height: "72px",
    borderRadius: tokens.borderRadiusXLarge,
    backgroundColor: tokens.colorPaletteRedBackground2,
    color: tokens.colorPaletteRedForeground1,
    display: "grid",
    placeItems: "center",
  },
  code: {
    fontFamily: '"Cascadia Mono", "JetBrains Mono", Menlo, Consolas, monospace',
    fontSize: "12px",
    padding: "4px 8px",
    borderRadius: tokens.borderRadiusSmall,
    backgroundColor: tokens.colorNeutralBackground3,
  },
});

export function NotFoundPage({ path, onHome }: NotFoundPageProps) {
  const styles = useStyles();
  return (
    <div className={styles.wrap}>
      <Card className={styles.card}>
        <div className={styles.halo}>
          <ErrorCircleRegular fontSize={36} />
        </div>
        <Title1>404 — Page not found</Title1>
        <Body1>
          We couldn&apos;t find{" "}
          <Body1 as="span" className={styles.code}>
            {path}
          </Body1>
          . The link may be stale, or the path was mistyped.
        </Body1>
        <Body1>
          Head back to the resolver, or open the{" "}
          <Link
            href="https://github.com/query-store-links/qsl-worker"
            target="_blank"
            rel="noreferrer"
          >
            project on GitHub
          </Link>
          .
        </Body1>
        <Button appearance="primary" icon={<ArrowLeftRegular />} onClick={onHome}>
          Back to the resolver
        </Button>
      </Card>
    </div>
  );
}
