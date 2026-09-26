import assert from "node:assert/strict";
import test from "node:test";

// Start `bun run dev`, then set QSL_TEST_ORIGIN to its local URL.
const origin = process.env.QSL_TEST_ORIGIN;

test(
  "worker accepts old encoded Store links and preserves PSI options",
  { skip: !origin },
  async () => {
    const id = "9NTSNMSVCB5L";
    const oldId = encodeURIComponent(
      `https://apps.microsoft.com/detail/${id}?hl=en-us&gl=US&ocid=pdpshare`,
    );
    for (const input of [id, oldId]) {
      const url = `${origin}/psi/${input}?arch=arm64&deps=false&market=GB&lang=en-GB`;
      const response = await fetch(url);
      assert.equal(response.status, 200);
      const script = await response.text();
      assert.match(script, /Id\s+= '9NTSNMSVCB5L'/);
      assert.match(script, /Arch\s+= 'arm64'/);
      assert.match(script, /Deps\s+= \$false/);
      const dataUrl = new URL(script.match(/DataUrl\s+= '([^']+)'/)[1]);
      assert.equal(dataUrl.searchParams.get("format"), "json");
      assert.equal(dataUrl.searchParams.get("market"), "GB");
      assert.equal(dataUrl.searchParams.get("lang"), "en-GB");
    }
    const pfn = "Microsoft.WindowsCalculator_8wekyb3d8bbwe";
    const response = await fetch(`${origin}/psi/${pfn}?type=PackageFamilyName`);
    const script = await response.text();
    assert.ok(script.includes(`Id           = '${pfn}'`));
  },
);
