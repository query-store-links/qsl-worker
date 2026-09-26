import assert from "node:assert/strict";
import test from "node:test";
import { buildPermalink, buildPsiCommand, DEFAULT_PERMALINK_OPTIONS } from "../src/shared.ts";

const origin = "https://qsl.krnl64.win";
const productId = "9NTSNMSVCB5L";
const storeUrl = `https://apps.microsoft.com/detail/${productId}?hl=en-us&gl=US&ocid=pdpshare`;

test("Store share URLs produce compact download and PowerShell links", () => {
  for (const pathStyle of ["download", "d", "installerDownload"]) {
    const opts = { ...DEFAULT_PERMALINK_OPTIONS, pathStyle };
    const path = pathStyle === "installerDownload" ? "installer/download" : pathStyle;
    assert.equal(
      buildPermalink(origin, storeUrl, "ProductId", opts),
      `${origin}/${path}/${productId}`,
    );
    assert.equal(
      buildPsiCommand(origin, storeUrl, "ProductId", opts),
      `irm ${origin}/psi/${productId} | iex`,
    );
  }
});

test("normalization preserves selected link options", () => {
  const opts = {
    ...DEFAULT_PERMALINK_OPTIONS,
    arch: "x64",
    overrideLocale: true,
    market: "GB",
    lang: "en-GB",
    psiDeps: false,
  };
  assert.equal(
    buildPermalink(origin, storeUrl, "ProductId", opts),
    `${origin}/download/${productId}?arch=x64&market=GB&lang=en-GB`,
  );
  assert.equal(
    buildPsiCommand(origin, storeUrl, "ProductId", opts),
    `irm "${origin}/psi/${productId}?arch=x64&deps=false&market=GB&lang=en-GB" | iex`,
  );
});

test("builders normalize whitespace and product casing and preserve other identifier types", () => {
  for (const build of [buildPermalink, buildPsiCommand]) {
    const opts = DEFAULT_PERMALINK_OPTIONS;
    assert.equal(build(origin, "  ", "ProductId", opts), "");
    assert.equal(
      build(origin, ` ${productId.toLowerCase()} `, "ProductId", opts),
      build(origin, productId, "ProductId", opts),
    );
    const pfn = "Microsoft.WindowsCalculator_8wekyb3d8bbwe";
    const result = build(origin, ` ${pfn} `, "PackageFamilyName", opts);
    assert.ok(result.includes(`/${pfn}?type=PackageFamilyName`));
  }
});
