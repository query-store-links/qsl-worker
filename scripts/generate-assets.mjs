// Derives the web/social asset variants from the two source images in
// `public/`. Run with `bun run assets` (or `node scripts/generate-assets.mjs`).
//
// Sources (committed to public/):
//   favicon.svg       — vector mark, linked directly
//   qsl.png           — 512×512 square icon (master for app/touch icons)
//   qsl-banner.png    — 1920×1200 social banner (master for og/twitter image)
//
// Outputs (also written to public/, safe to regenerate):
//   apple-touch-icon.png  180×180   (iOS home-screen)
//   icon-192.png          192×192   (Android/PWA)
//   icon-512.png          512×512   (PWA, also covers high-DPI Android)
//   og-image.png         1200×630   (Open Graph + Twitter card)

import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const here = dirname(fileURLToPath(import.meta.url));
const PUBLIC = resolve(here, "..", "public");
const SQUARE = resolve(PUBLIC, "qsl.png");
const BANNER = resolve(PUBLIC, "qsl-banner.png");

async function squareIcon(size, outName) {
  const out = resolve(PUBLIC, outName);
  await sharp(SQUARE).resize(size, size, { fit: "cover" }).png({ compressionLevel: 9 }).toFile(out);
  console.log(`  ${outName.padEnd(24)} ${size}×${size}`);
}

async function ogImage() {
  // OG / Twitter summary_large_image expects 1200×630 (1.91:1). The banner is
  // 1920×1200 (1.6:1), so we cover-crop to the wider OG aspect.
  const out = resolve(PUBLIC, "og-image.png");
  await sharp(BANNER)
    .resize(1200, 630, { fit: "cover", position: "centre" })
    .png({ compressionLevel: 9 })
    .toFile(out);
  console.log(`  og-image.png             1200×630`);
}

await mkdir(PUBLIC, { recursive: true });

console.log("Generating site assets in public/ …");
await squareIcon(180, "apple-touch-icon.png");
await squareIcon(192, "icon-192.png");
await squareIcon(512, "icon-512.png");
await ogImage();
console.log("Done.");
