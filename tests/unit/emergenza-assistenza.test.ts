import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { isAllowed } from "@/lib/rbac";
import { MAIN_NAV_BY_ROLE } from "@/lib/app-shell-nav";

/**
 * Source-contract per /emergenza-assistenza: pagina statica (nessuna API,
 * nessuna migration, nessuna dipendenza Supabase) accessibile solo ad
 * admin/operator/supervisor. Verifica nav, RBAC e contenuto minimo.
 */

const pageSource = readFileSync(
  join(process.cwd(), "app", "(app)", "emergenza-assistenza", "page.tsx"),
  "utf8"
);

describe("/emergenza-assistenza — navigazione", () => {
  it("è presente nella nav operativa principale per admin/operator/supervisor", () => {
    for (const role of ["admin", "operator", "supervisor"] as const) {
      expect(MAIN_NAV_BY_ROLE[role].some((item) => item.href === "/emergenza-assistenza")).toBe(true);
    }
  });

  it("è posizionata subito dopo /controllo-giornata e prima di /mario-assistant", () => {
    const hrefs = MAIN_NAV_BY_ROLE.admin.map((item) => item.href);
    const controlloIdx = hrefs.indexOf("/controllo-giornata");
    const emergenzaIdx = hrefs.indexOf("/emergenza-assistenza");
    const marioIdx = hrefs.indexOf("/mario-assistant");
    expect(controlloIdx).toBeGreaterThan(-1);
    expect(emergenzaIdx).toBe(controlloIdx + 1);
    expect(marioIdx).toBe(emergenzaIdx + 1);
  });

  it("non altera le altre voci della nav operativa (stessa lunghezza attesa, nessuna voce rimossa)", () => {
    const hrefs = MAIN_NAV_BY_ROLE.admin.map((item) => item.href);
    expect(hrefs).toContain("/dashboard");
    expect(hrefs).toContain("/mappa-live");
    expect(hrefs).toContain("/inbox");
    expect(hrefs).toContain("/whatsapp");
  });
});

describe("/emergenza-assistenza — RBAC", () => {
  it.each(["admin", "operator", "supervisor"] as const)("consente l'accesso al ruolo %s", (role) => {
    expect(isAllowed("/emergenza-assistenza", role)).toBe(true);
  });

  it.each(["agency", "driver", "autista", "assistenza"] as const)("nega l'accesso al ruolo %s", (role) => {
    expect(isAllowed("/emergenza-assistenza", role)).toBe(false);
  });

  it("nega l'accesso senza ruolo (non autenticato)", () => {
    expect(isAllowed("/emergenza-assistenza", null)).toBe(false);
  });
});

describe("/emergenza-assistenza — pagina: nessuna scrittura, nessuna dipendenza runtime", () => {
  it("non contiene chiamate fetch()", () => {
    expect(pageSource).not.toMatch(/\bfetch\s*\(/);
  });

  it("non contiene chiamate Supabase (client/admin) né import da @/lib/supabase", () => {
    // Il commento in cima al file menziona "Supabase" per documentare il vincolo:
    // qui verifichiamo l'assenza di import/uso reale, non della parola nei commenti.
    expect(pageSource).not.toMatch(/from ["']@\/lib\/supabase/);
    expect(pageSource).not.toMatch(/\bsupabase\.(auth|from|rpc)\b/);
    expect(pageSource).not.toMatch(/createClient\s*\(/);
    expect(pageSource).not.toMatch(/createServerClient\s*\(/);
  });

  it("non è marcata \"use client\" per intero (solo il pulsante copia lo è)", () => {
    expect(pageSource.trimStart().startsWith('"use client"')).toBe(false);
  });
});

describe("/emergenza-assistenza — contenuto minimo", () => {
  it("contiene i quattro link rapidi richiesti", () => {
    expect(pageSource).toMatch(/\/controllo-giornata/);
    expect(pageSource).toMatch(/\/mappa-live/);
    expect(pageSource).toMatch(/\/inbox/);
    expect(pageSource).toMatch(/\/whatsapp/);
  });

  it("non contiene link a /settings/system (operator non ha accesso)", () => {
    expect(pageSource).not.toMatch(/\/settings\/system/);
  });

  it("importa il template di segnalazione precompilato dal componente client dedicato", () => {
    expect(pageSource).toMatch(/EMERGENCY_REPORT_TEMPLATE/);
    expect(pageSource).toMatch(/EmergenzaCopyMessageButton/);
  });
});

describe("emergenza-copy-button — template segnalazione", () => {
  const buttonSource = readFileSync(join(process.cwd(), "components", "emergenza-copy-button.tsx"), "utf8");

  it("è un componente client isolato", () => {
    expect(buttonSource.trimStart().startsWith('"use client"')).toBe(true);
  });

  it("usa navigator.clipboard", () => {
    expect(buttonSource).toMatch(/navigator\.clipboard\.writeText/);
  });

  it("mostra il feedback 'Copiato'", () => {
    expect(buttonSource).toMatch(/Copiato/);
  });

  it("il template contiene tutti i campi richiesti", () => {
    expect(buttonSource).toMatch(/Ora:/);
    expect(buttonSource).toMatch(/Pagina:/);
    expect(buttonSource).toMatch(/Operazione che stavo facendo:/);
    expect(buttonSource).toMatch(/Pratica \/ cliente \/ servizio:/);
    expect(buttonSource).toMatch(/Succede anche ad altri operatori: sì \/ no/);
    expect(buttonSource).toMatch(/Screenshot allegato\./);
  });
});

describe("/emergenza-assistenza — nessuna API o migration aggiunta", () => {
  it("non esiste una route API dedicata", () => {
    expect(existsSync(join(process.cwd(), "app", "api", "emergenza-assistenza"))).toBe(false);
  });

  it("non esiste alcuna migration relativa a emergenza-assistenza", () => {
    const migrationsDir = join(process.cwd(), "supabase", "migrations");
    const files = readdirSync(migrationsDir);
    expect(files.some((f) => /emergenza/i.test(f))).toBe(false);
  });
});
