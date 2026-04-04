/**
 * Utility condivisa per caricare il logo aziendale come base64 data URI.
 * Usato in PDF, email HTML ed Excel.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

let _cached: string | null | undefined;

const LOGO_CANDIDATES = [
  "Logo its.png",
  "brand/logo-ischia-transfer-email.png",
  "brand/logo-ischia-transfer.png",
];

export function getLogoDataUri(): string | null {
  if (_cached !== undefined) return _cached;
  for (const candidate of LOGO_CANDIDATES) {
    try {
      const filePath = path.join(process.cwd(), "public", candidate);
      const base64 = readFileSync(filePath).toString("base64");
      _cached = `data:image/png;base64,${base64}`;
      return _cached;
    } catch {
      // prova il prossimo
    }
  }
  _cached = null;
  return null;
}

export function getLogoBuffer(): Buffer | null {
  for (const candidate of LOGO_CANDIDATES) {
    try {
      return readFileSync(path.join(process.cwd(), "public", candidate));
    } catch {
      // prova il prossimo
    }
  }
  return null;
}
