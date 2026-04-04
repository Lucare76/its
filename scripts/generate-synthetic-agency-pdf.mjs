import fs from "node:fs";
import path from "node:path";

function escapePdfText(value) {
  return value.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function buildPdf(lines) {
  const contentLines = ["BT", "/F1 11 Tf", "50 790 Td", "14 TL"];
  for (const line of lines) {
    contentLines.push(`(${escapePdfText(line)}) Tj`);
    contentLines.push("T*");
  }
  contentLines.push("ET");
  const stream = contentLines.join("\n");

  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n",
    "4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
    `5 0 obj\n<< /Length ${Buffer.byteLength(stream, "utf8")} >>\nstream\n${stream}\nendstream\nendobj\n`
  ];

  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const object of objects) {
    offsets.push(Buffer.byteLength(pdf, "utf8"));
    pdf += object;
  }
  const xrefOffset = Buffer.byteLength(pdf, "utf8");
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += "0000000000 65535 f \n";
  for (let index = 1; index <= objects.length; index += 1) {
    pdf += `${String(offsets[index]).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return pdf;
}

const practice = process.argv[2] ?? `99/${Date.now().toString().slice(-6)}`;
const outputPath = path.resolve(process.argv[3] ?? "samples/review-test.pdf");
const lines = [
  "CONFERMA D'ORDINE n. 009999 Data 11-mar-26",
  "PRATICA DATA 1 BENEFICIARIO ns riferimento NS REFERENTE PAX",
  `${practice} 11-mar-26 ROSSI MARIO STAFF TEST 2`,
  "PROGRAMMA DESCRIZIONE DAL AL",
  "26/TRANSFER PACCHETTO TRANSFER 01-giu-26 05-giu-26",
  "DAL AL DESCRIZIONE IMPORTO TASSE PAX NUM TOTALE",
  "01-giu 15:10 TRAGHETTO NAPOLI + TRS H. ISCHIA 15:10 12,50 2 (1) 25,00",
  "01-giu 01-giu AUTO ISCHIA/HOTEL 2 (2)",
  "05-giu 09:40 TRS H. ISCHIA + TRAGHETTO NAPOLI 09:40 12,50 2 (1) 25,00",
  "05-giu 05-giu AUTO HOTEL / ISCHIA 2 (2)",
  "Il01-giu-26 1TRAGHETTO NAPOLI + TRS H. ISCHIA 15:10",
  "Dalle15:10M.p.: PORTO DI NAPOLI PORTA DI MASSA da: NAPOLI CON MEDMAR a: CELL: 3330001111 dest: HOTEL TEST OPERATIVO",
  "Il05-giu-26 1TRS H. ISCHIA + TRAGHETTO NAPOLI 09:40",
  "Dalle09:40M.p.: HOTEL TEST OPERATIVO da: HOTEL a: PORTO PER NAPOLI CON MEDMAR dest: PORTO DI NAPOLI",
  "Cliente: ROSSI MARIO",
  "Cellulare/Tel. 3330001111",
  "Ufficio Booking - Agenzia Test Operativa"
];

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, buildPdf(lines), "binary");
console.log(outputPath);
