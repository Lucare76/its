import { chromium } from "@playwright/test";
import { pathToFileURL } from "node:url";
import path from "node:path";

const root = process.cwd();
const htmlPath = path.join(root, "docs", "audit-ITS-2026-04-27.html");
const pdfPath = path.join(root, "docs", "audit-ITS-2026-04-27.pdf");

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1240, height: 1754 } });
await page.goto(pathToFileURL(htmlPath).href, { waitUntil: "networkidle" });
await page.pdf({
  path: pdfPath,
  format: "A4",
  printBackground: true,
  displayHeaderFooter: true,
  headerTemplate: "<div></div>",
  footerTemplate:
    '<div style="font-family: Arial, sans-serif; font-size: 9px; color: #667085; width: 100%; padding: 0 15mm; display: flex; justify-content: space-between;"><span>Audit tecnico completo - Ischia Transfer</span><span>Pagina <span class="pageNumber"></span> di <span class="totalPages"></span></span></div>',
  margin: { top: "14mm", right: "14mm", bottom: "18mm", left: "14mm" }
});
await browser.close();

console.log(pdfPath);
