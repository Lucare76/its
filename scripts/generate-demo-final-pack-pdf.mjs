import path from "node:path";
import { chromium } from "@playwright/test";

const root = process.cwd();
const inputPath = path.join(root, "docs", "demo", "demo-final-pack-2026-03-11.html");
const outputPath = path.join(root, "docs", "demo", "Ischia-Transfer-Pacchetto-Demo-Finale-2026-03-11.pdf");

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.goto(`file://${inputPath}`, { waitUntil: "load" });
  await page.pdf({
    path: outputPath,
    format: "A4",
    margin: { top: "10mm", right: "10mm", bottom: "10mm", left: "10mm" },
    printBackground: true
  });
  console.log(outputPath);
} finally {
  await browser.close();
}
