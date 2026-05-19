import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const artifactDir = path.join(repoRoot, "artifacts", "qa-temp");

function loadEnv(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const values = {};
  for (const raw of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
}

function maskEmail(email) {
  return email ? email.replace(/^(.{2}).*(@.*)$/, "$1***$2") : null;
}

function isSafeService(row) {
  if (row.is_test_data === true) return true;
  const bag = Object.entries(row)
    .filter(([key, value]) => typeof value === "string" && /name|customer|passenger|booking|note|code|hotel|agency|test/i.test(key))
    .map(([, value]) => value)
    .join(" ")
    .toUpperCase();
  return bag.includes("TEST") || bag.includes("DEMO") || bag.includes("E2E");
}

function serviceType(row) {
  return String(row.service_type || row.direction || row.kind || "").toLowerCase();
}

async function waitReachable(baseUrl, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(baseUrl, { redirect: "manual" });
      return response.status;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  return null;
}

async function step(report, title, fn) {
  const item = { title, ok: false, notes: [], error: null };
  report.steps.push(item);
  try {
    await fn(item);
    item.ok = !item.error;
  } catch (error) {
    item.error = error?.message || String(error);
  }
  return item;
}

async function main() {
  const env = { ...loadEnv(path.join(repoRoot, ".env")), ...loadEnv(path.join(repoRoot, ".env.local")) };
  const required = [
    "E2E_BASE_URL",
    "E2E_TEST_EMAIL",
    "E2E_TEST_PASSWORD",
    "NEXT_PUBLIC_SUPABASE_URL",
    "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
  ];
  const missing = required.filter((key) => !env[key]);
  if (missing.length) {
    console.error(`Missing env: ${missing.join(", ")}`);
    process.exit(2);
  }

  fs.mkdirSync(artifactDir, { recursive: true });
  const baseURL = env.E2E_BASE_URL.replace(/\/$/, "");
  const report = {
    generated_at: new Date().toISOString(),
    environment: {
      baseURL,
      user: maskEmail(env.E2E_TEST_EMAIL),
      browser: "chromium",
    },
    auth: {},
    db: {},
    menu: [],
    pages: {},
    api_calls: [],
    console_errors: [],
    network_errors: [],
    problems: [],
    steps: [],
    screenshots: [],
  };

  const anon = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    auth: { persistSession: false },
  });
  const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  const auth = await anon.auth.signInWithPassword({
    email: env.E2E_TEST_EMAIL,
    password: env.E2E_TEST_PASSWORD,
  });
  let authSession = null;
  if (auth.error) {
    report.problems.push({ severity: "bloccante", area: "Auth", problem: auth.error.message });
  } else {
    authSession = auth.data.session;
    const userId = auth.data.user.id;
    report.auth = { login_ok: true, user_id: userId };
    const membership = await admin
      .from("memberships")
      .select("tenant_id,role,full_name")
      .eq("user_id", userId)
      .maybeSingle();
    if (membership.error || !membership.data?.tenant_id) {
      report.problems.push({
        severity: "bloccante",
        area: "Membership",
        problem: membership.error?.message || "Membership mancante",
      });
    } else {
      const tenantId = membership.data.tenant_id;
      const drivers = await admin
        .from("memberships")
        .select("user_id", { count: "exact", head: true })
        .eq("tenant_id", tenantId)
        .eq("role", "driver");
      const servicesCount = await admin
        .from("services")
        .select("id", { count: "exact", head: true })
        .eq("tenant_id", tenantId);
      const confirmations = await admin
        .from("daily_availability_confirmations")
        .select("date", { count: "exact", head: true })
        .eq("tenant_id", tenantId);
      const serviceSample = await admin.from("services").select("*").eq("tenant_id", tenantId).limit(1000);
      const safeServices = (serviceSample.data || []).filter(isSafeService);
      const safeArrivals = safeServices.filter((row) => serviceType(row).includes("arrival") || serviceType(row).includes("arrivo"));
      const safeDepartures = safeServices.filter((row) => serviceType(row).includes("departure") || serviceType(row).includes("partenza"));

      report.db = {
        tenant_id: tenantId,
        role: membership.data.role,
        full_name_present: Boolean(membership.data.full_name),
        drivers: drivers.count || 0,
        services: servicesCount.count || 0,
        availability_confirmations: confirmations.count || 0,
        safe_services_sample: safeServices.length,
        safe_arrivals_sample: safeArrivals.length,
        safe_departures_sample: safeDepartures.length,
        db_errors: [
          drivers.error?.message,
          servicesCount.error?.message,
          confirmations.error?.message,
          serviceSample.error?.message,
        ].filter(Boolean),
      };
    }
  }

  const reachableStatus = await waitReachable(baseURL);
  if (!reachableStatus) {
    report.problems.push({
      severity: "bloccante",
      area: "Ambiente",
      problem: `${baseURL} non raggiungibile`,
    });
    const out = path.join(artifactDir, `qa-report-${Date.now()}.json`);
    fs.writeFileSync(out, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ reportFile: out, summary: report }, null, 2));
    process.exit(1);
  }

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });

  page.on("console", (message) => {
    if (["error", "warning"].includes(message.type())) {
      report.console_errors.push({ type: message.type(), text: message.text(), url: page.url() });
    }
  });
  page.on("response", (response) => {
    const url = response.url();
    if (!url.includes("/api/")) return;
    const entry = {
      api: url.replace(baseURL, ""),
      method: response.request().method(),
      status: response.status(),
      ok: response.ok(),
    };
    report.api_calls.push(entry);
    if (response.status() >= 400) report.network_errors.push(entry);
  });

  await step(report, "Login UI", async () => {
    await page.goto(`${baseURL}/login`, { waitUntil: "domcontentloaded" });
    await page.getByTestId("login-email").fill(env.E2E_TEST_EMAIL);
    await page.getByTestId("login-password").fill(env.E2E_TEST_PASSWORD);
    await page.getByTestId("login-submit").click();
    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
    if (page.url().includes("/login")) {
      report.problems.push({
        severity: "alto",
        area: "Login UI",
        problem: "Login Supabase valido, ma la UI resta su /login. Per completare QA e2e e stata iniettata la sessione test nel localStorage del browser.",
      });
      if (!authSession) throw new Error("Login rimasto su /login e sessione Supabase non disponibile");
      const projectRef = new URL(env.NEXT_PUBLIC_SUPABASE_URL).host.split(".")[0];
      await page.evaluate(
        ({ key, session }) => {
          window.localStorage.setItem(key, JSON.stringify(session));
        },
        { key: `sb-${projectRef}-auth-token`, session: authSession },
      );
      await page.goto(`${baseURL}/dashboard`, { waitUntil: "domcontentloaded" });
      await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
      if (page.url().includes("/login")) throw new Error("Fallback sessione localStorage non ha aperto /dashboard");
    }
  });

  const routes = [
    ["Cruscotto", "/dashboard", /arrivi|partenze|prenot|oggi|cruscotto/i],
    ["Control Room", "/mappa-live", /control|mappa|mezzi|gps|radius/i],
    ["Arrivi", "/arrivals", /arrivi|aeroporto|stazione|porto|assegna/i],
    ["Partenze", "/departures", /partenze|pickup|barca|assegna/i],
    ["Prenotazioni", "/inbox", /inbox|prenot|pdf|email/i],
    ["Disponibilita", "/disponibilita", /disponibil|autist|mezzi/i],
    ["Piano del Giorno", "/piano-giorno", /piano|giorno|giro|continente/i],
  ];

  await step(report, "Menu e pagine protette", async () => {
    for (const [label, route, pattern] of routes) {
      const beforeConsole = report.console_errors.length;
      const beforeNetwork = report.network_errors.length;
      await page.goto(`${baseURL}${route}`, { waitUntil: "domcontentloaded" });
      await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
      const body = await page.locator("body").innerText({ timeout: 6000 }).catch(() => "");
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForLoadState("networkidle", { timeout: 12000 }).catch(() => {});
      report.menu.push({
        label,
        path: route,
        final_url: page.url().replace(baseURL, ""),
        opened: page.url().includes(route),
        content_match: pattern.test(body),
        console_errors: report.console_errors.length - beforeConsole,
        network_errors: report.network_errors.length - beforeNetwork,
        body_chars: body.length,
      });
    }
  });

  await step(report, "Click non distruttivi", async (item) => {
    const clickTargets = [
      ["/dashboard", /aggiorna|refresh|esporta|export/i],
      ["/mappa-live", /aggiorna|refresh|critici|offline/i],
      ["/arrivals", /reset|filtra|aggiorna|cerca/i],
      ["/departures", /reset|filtra|aggiorna|cerca/i],
      ["/inbox", /refresh|aggiorna|filtra|cerca/i],
      ["/disponibilita", /aggiorna|refresh/i],
      ["/piano-giorno", /aggiorna|refresh|continente/i],
    ];
    for (const [route, regex] of clickTargets) {
      await page.goto(`${baseURL}${route}`, { waitUntil: "domcontentloaded" });
      await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
      const button = page.getByRole("button", { name: regex }).first();
      if ((await button.count()) > 0) {
        await button.click({ timeout: 3000 }).catch((error) => item.notes.push(`${route}: click fallito ${error.message}`));
        await page.waitForTimeout(800);
        item.notes.push(`${route}: click non distruttivo eseguito`);
      } else {
        item.notes.push(`${route}: nessun bottone non distruttivo riconosciuto`);
      }
    }
  });

  await step(report, "Assegnazioni Arrivi/Partenze", async (item) => {
    if ((report.db.safe_arrivals_sample || 0) === 0 && (report.db.safe_departures_sample || 0) === 0) {
      item.notes.push("Saltate: nessun servizio DEMO/TEST/E2E nel campione letto. Evitato uso di dati reali.");
      return;
    }
    item.notes.push("Servizi test presenti nel campione, ma assegnazioni distruttive non eseguite in questo smoke.");
  });

  await step(report, "Piano del Giorno Continente", async () => {
    await page.goto(`${baseURL}/piano-giorno`, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
    const body = await page.locator("body").innerText({ timeout: 6000 }).catch(() => "");
    report.pages.piano_giorno = {
      has_continente: /continente/i.test(body),
      has_bruno: /bruno/i.test(body),
      has_vendor: /vendor/i.test(body),
      has_da_smistare: /smistare|smistamento/i.test(body),
    };
  });

  const screenshot = path.join(artifactDir, `qa-final-${Date.now()}.png`);
  await page.screenshot({ path: screenshot, fullPage: true }).catch(() => {});
  if (fs.existsSync(screenshot)) report.screenshots.push(screenshot);
  await browser.close();

  for (const entry of report.network_errors) {
    report.problems.push({
      severity: entry.api.includes("/api/gps/control-room") ? "basso" : "medio",
      area: "Network",
      problem: `${entry.method} ${entry.api} -> ${entry.status}`,
    });
  }
  if (report.console_errors.some((entry) => /hydration/i.test(entry.text))) {
    report.problems.push({ severity: "alto", area: "Hydration", problem: "Errore hydration rilevato" });
  }

  const out = path.join(artifactDir, `qa-report-${Date.now()}.json`);
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ reportFile: out, summary: report }, null, 2));
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
