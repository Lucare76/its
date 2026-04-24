import { chromium } from "playwright";
import { pathToFileURL } from "node:url";
import path from "node:path";

const root = process.cwd();
const htmlPath = path.join(root, "docs", "analisi-finale-stato-attuale.html");
const pdfPath = path.join(root, "docs", "analisi-finale-stato-attuale.pdf");

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
    '<div style="font-family: Arial, sans-serif; font-size: 9px; color: #667085; width: 100%; padding: 0 14mm; display: flex; justify-content: space-between;"><span>Analisi finale stato attuale - Ischia Transfer Service</span><span>Pagina <span class="pageNumber"></span> di <span class="totalPages"></span></span></div>',
  margin: { top: "13mm", right: "13mm", bottom: "18mm", left: "13mm" }
});
await browser.close();

console.log(pdfPath);
