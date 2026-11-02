// Renders docs/images/banner.html to docs/images/banner.png (1280×400 at 2×) with Playwright's Chromium.
//   node scripts/render-banner.mjs [input.html] [output.png]
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const input = path.resolve(process.argv[2] ?? path.join(root, "docs/images/banner.html"));
const output = path.resolve(process.argv[3] ?? path.join(root, "docs/images/banner.png"));

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 400 }, deviceScaleFactor: 2 });
  await page.goto(pathToFileURL(input).href);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: output, clip: { x: 0, y: 0, width: 1280, height: 400 } });
  console.log(`Wrote ${path.relative(process.cwd(), output)}`);
} finally {
  await browser.close();
}
