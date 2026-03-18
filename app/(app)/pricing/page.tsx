"use client";

import { useEffect, useEffectEvent, useMemo, useState, type FormEvent } from "react";
import { z } from "zod";
import { getClientSessionContext } from "@/lib/supabase/client-session";
import { hasSupabaseEnv, supabase } from "@/lib/supabase/client";
import { BUS_LINES_2026 } from "@/lib/bus-lines-catalog";

type SectionKey = "listini" | "regole" | "agenzie" | "match" | "storico";
type LooseRow = Record<string, unknown>;

type Agency = {
  id: string;
  name: string;
  legal_name: string | null;
  billing_name: string | null;
  vat_number: string | null;
  pec_email: string | null;
  sdi_code: string | null;
  contact_email: string | null;
  booking_email: string | null;
  contact_emails: string[];
  booking_emails: string[];
  phone: string | null;
  parser_key_hint: string | null;
  sender_domains: string[] | null;
  default_enabled_booking_kinds: string[] | null;
  default_pricing_notes: string | null;
  notes: string | null;
  active: boolean;
};

type RouteItem = { id: string; name: string; origin_label: string; destination_label: string; active: boolean };
type PriceList = { id: string; name: string; currency: string; valid_from: string; valid_to: string | null; active: boolean; is_default: boolean; agency_id: string | null };
type PricingRule = {
  id: string;
  price_list_id: string;
  route_id: string;
  agency_id: string | null;
  bus_line_code: string | null;
  service_type: "transfer" | "bus_tour" | null;
  direction: "arrival" | "departure" | null;
  pax_min: number;
  pax_max: number | null;
  rule_kind: "fixed" | "per_pax";
  internal_cost_cents: number;
  public_price_cents: number;
  agency_price_cents: number | null;
  priority: number;
  vehicle_type: string | null;
  time_from: string | null;
  time_to: string | null;
  season_from: string | null;
  season_to: string | null;
  needs_manual_review: boolean;
  active: boolean;
};
type ImportMatch = {
  id: string;
  created_at: string;
  normalized_agency_name: string | null;
  normalized_route_name: string | null;
  pax: number | null;
  match_status: string;
  match_quality: "certain" | "partial" | "review" | null;
  review_required: boolean;
  match_confidence: number | null;
  match_notes: string;
};
type HistoryRow = {
  id: string;
  created_at: string;
  service_id: string;
  agency_label: string;
  route_label: string;
  internal_cost_cents: number;
  final_price_cents: number;
  margin_cents: number;
  apply_mode: string;
  manual_override: boolean;
};

type AgencyFormData = {
  name: string;
  legal_name: string | null;
  billing_name: string | null;
  vat_number: string | null;
  pec_email: string | null;
  sdi_code: string | null;
  contact_email: string | null;
  booking_email: string | null;
  contact_emails: string[];
  booking_emails: string[];
  phone: string | null;
  parser_key_hint: string | null;
  sender_domains: string[];
  default_enabled_booking_kinds: string[];
  default_pricing_notes: string;
  notes: string;
};

const parseCsv = (value: string, transform?: (item: string) => string) =>
  value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => (transform ? transform(item) : item));

const unique = (items: string[]) => Array.from(new Set(items));
const sanitizeEmail = (value: string) => value.trim().toLowerCase();
const eur = (n: number) => (n / 100).toLocaleString("it-IT", { style: "currency", currency: "EUR" });
const centsToEuroInput = (value: number | null | undefined) => {
  if (typeof value !== "number") return "";
  return (value / 100).toFixed(2).replace(".", ",");
};
const parseEuroAmountToCents = (value: FormDataEntryValue | null) => {
  const normalized = String(value ?? "")
    .trim()
    .replace(/\./g, "")
    .replace(",", ".");
  if (!normalized) return null;
  const amount = Number(normalized);
  if (!Number.isFinite(amount)) return Number.NaN;
  return Math.round(amount * 100);
};
const qClass = (q: ImportMatch["match_quality"]) => (q === "certain" ? "bg-emerald-100 text-emerald-700" : q === "partial" ? "bg-amber-100 text-amber-700" : "bg-rose-100 text-rose-700");
const rowString = (row: LooseRow, key: string) => (typeof row[key] === "string" ? String(row[key]) : null);
const rowStringArray = (row: LooseRow, key: string) => (Array.isArray(row[key]) ? row[key].map((item) => String(item)).filter(Boolean) : []);
const CREATE_AGENCY_PANEL_STORAGE_KEY = "pricing:create-agency-expanded";
const PRICE_LIST_NAME_PRESETS = ["FORMULA SNAV", "FORMULA MEDMAR", "GIRO ISOLA BUS", "LINEA BUS"];
const ROUTE_PRESETS = [
  { name: "FORMULA SNAV", origin_label: "Formula SNAV", destination_label: "Servizio formula" },
  { name: "FORMULA MEDMAR", origin_label: "Formula MEDMAR", destination_label: "Servizio formula" },
  { name: "TRASFERIMENTO STAZIONE / HOTEL", origin_label: "Stazione Napoli", destination_label: "Hotel Ischia" },
  { name: "TRASFERIMENTO AEROPORTO / HOTEL", origin_label: "Aeroporto Napoli", destination_label: "Hotel Ischia" },
  { name: "TRASFERIMENTO STAZIONE / HOTEL PRIVATO", origin_label: "Stazione Napoli", destination_label: "Hotel / Indirizzo privato Ischia" },
  { name: "TRASFERIMENTO AEROPORTO / HOTEL PRIVATO", origin_label: "Aeroporto Napoli", destination_label: "Hotel / Indirizzo privato Ischia" },
  { name: "GIRO ISOLA BUS", origin_label: "Ischia", destination_label: "Giro Isola" },
  { name: "LINEA BUS", origin_label: "Linea bus da PDF", destination_label: "Prezzo per linea" }
];
const RULE_PRESETS = [
  { label: "Formula SNAV", routeName: "FORMULA SNAV", service_type: "transfer", bus_line_code: "" },
  { label: "Formula MEDMAR", routeName: "FORMULA MEDMAR", service_type: "transfer", bus_line_code: "" },
  { label: "Transfer Aeroporto / Hotel", routeName: "TRASFERIMENTO AEROPORTO / HOTEL", service_type: "transfer", bus_line_code: "" },
  { label: "Transfer Stazione / Hotel", routeName: "TRASFERIMENTO STAZIONE / HOTEL", service_type: "transfer", bus_line_code: "" },
  { label: "Linea Bus", routeName: "", service_type: "bus_tour", bus_line_code: "LINEA_" }
] as const;
type RulePreset = {
  label: string;
  routeName: string;
  service_type: "transfer" | "bus_tour";
  bus_line_code: string;
};
const STANDARD_PRICE_GRID_ROWS = [
  { key: "snav", label: "FORMULA SNAV", routeName: "FORMULA SNAV", serviceType: "transfer", busLineCode: "" },
  { key: "medmar", label: "FORMULA MEDMAR", routeName: "FORMULA MEDMAR", serviceType: "transfer", busLineCode: "" },
  { key: "airport", label: "TRANSFER AEROPORTO / HOTEL", routeName: "TRASFERIMENTO AEROPORTO / HOTEL", serviceType: "transfer", busLineCode: "" },
  { key: "station", label: "TRANSFER STAZIONE / HOTEL", routeName: "TRASFERIMENTO STAZIONE / HOTEL", serviceType: "transfer", busLineCode: "" },
  { key: "bus", label: "LINEA BUS", routeName: "LINEA BUS", serviceType: "bus_tour", busLineCode: "LINEA_" }
] as const;

function detectMatchBadges(notes: string) {
  const lower = notes.toLowerCase();
  const badges: Array<{ label: string; className: string }> = [];
  if (lower.includes("email esatta")) badges.push({ label: "email", className: "bg-emerald-100 text-emerald-700" });
  if (lower.includes("dominio mittente")) badges.push({ label: "dominio", className: "bg-sky-100 text-sky-700" });
  if (lower.includes("alias agenzia")) badges.push({ label: "alias", className: "bg-violet-100 text-violet-700" });
  if (lower.includes("nome agenzia")) badges.push({ label: "nome", className: "bg-slate-200 text-slate-700" });
  if (lower.includes("origine/destinazione") || lower.includes("origine e destinazione complete")) {
    badges.push({ label: "tratta", className: "bg-amber-100 text-amber-700" });
  }
  if (lower.includes("intento servizio")) badges.push({ label: "intento", className: "bg-orange-100 text-orange-700" });
  if (lower.includes("revisione operatore")) badges.push({ label: "review", className: "bg-rose-100 text-rose-700" });
  return badges;
}

const emailArraySchema = z
  .string()
  .optional()
  .or(z.literal(""))
  .transform((value, ctx) => {
    const emails = unique(parseCsv(value || "", sanitizeEmail));
    for (const email of emails) {
      if (!z.string().email().safeParse(email).success) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Email non valida: ${email}` });
        return z.NEVER;
      }
    }
    return emails;
  });

const agencySchema = z
  .object({
    name: z.string().min(2).max(120),
    legal_name: z.string().max(160).optional().or(z.literal("")),
    billing_name: z.string().max(160).optional().or(z.literal("")),
    vat_number: z.string().max(32).optional().or(z.literal("")),
    pec_email: z.string().email().max(160).optional().or(z.literal("")),
    sdi_code: z.string().max(16).optional().or(z.literal("")),
    contact_email: z.string().email().max(160).optional().or(z.literal("")),
    booking_email: z.string().email().max(160).optional().or(z.literal("")),
    contact_emails_csv: emailArraySchema,
    booking_emails_csv: emailArraySchema,
    phone: z.string().max(60).optional().or(z.literal("")),
    parser_key_hint: z.string().max(80).optional().or(z.literal("")),
    sender_domains_csv: z.string().max(600).optional().or(z.literal("")),
    default_enabled_booking_kinds_csv: z.string().max(240).optional().or(z.literal("")),
    default_pricing_notes: z.string().max(1000).optional().or(z.literal("")),
    notes: z.string().max(2000).optional().or(z.literal(""))
  })
  .transform((v): AgencyFormData => {
    const primaryContactEmail = v.contact_email ? sanitizeEmail(v.contact_email) : null;
    const primaryBookingEmail = v.booking_email ? sanitizeEmail(v.booking_email) : null;
    const contactEmails = unique([...(primaryContactEmail ? [primaryContactEmail] : []), ...v.contact_emails_csv]);
    const bookingEmails = unique([...(primaryBookingEmail ? [primaryBookingEmail] : []), ...v.booking_emails_csv]);
    return {
      name: v.name,
      legal_name: v.legal_name || null,
      billing_name: v.billing_name || null,
      vat_number: v.vat_number || null,
      pec_email: v.pec_email ? sanitizeEmail(v.pec_email) : null,
      sdi_code: v.sdi_code || null,
      contact_email: primaryContactEmail ?? contactEmails[0] ?? null,
      booking_email: primaryBookingEmail ?? bookingEmails[0] ?? null,
      contact_emails: contactEmails,
      booking_emails: bookingEmails,
      phone: v.phone || null,
      parser_key_hint: v.parser_key_hint || null,
      sender_domains: unique(parseCsv(v.sender_domains_csv || "", (item) => item.toLowerCase())),
      default_enabled_booking_kinds: unique(parseCsv(v.default_enabled_booking_kinds_csv || "")),
      default_pricing_notes: v.default_pricing_notes || "",
      notes: v.notes || ""
    };
  });

const aliasSchema = z.object({ agency_id: z.string().uuid(), alias: z.string().min(2).max(120) });
const routeSchema = z.object({ name: z.string().min(2).max(120), origin_label: z.string().min(2).max(120), destination_label: z.string().min(2).max(120) });
const priceListSchema = z.object({ name: z.string().min(2).max(120), currency: z.string().length(3), valid_from: z.string().min(10), valid_to: z.string().optional().or(z.literal("")), agency_id: z.string().uuid().optional().or(z.literal("")), is_default: z.boolean().default(false) }).transform((v) => ({ ...v, valid_to: v.valid_to || null, agency_id: v.agency_id || null, currency: v.currency.toUpperCase() }));
const pricingRuleSchema = z.object({
  price_list_id: z.string().uuid(),
  route_id: z.string().uuid(),
  agency_id: z.string().uuid().optional().or(z.literal("")),
  bus_line_code: z.string().trim().max(80).optional().or(z.literal("")),
  service_type: z.enum(["transfer", "bus_tour"]).optional().or(z.literal("")),
  direction: z.enum(["arrival", "departure"]).optional().or(z.literal("")),
  pax_min: z.number().int().min(1),
  pax_max: z.number().int().min(1).optional().nullable(),
  rule_kind: z.enum(["fixed", "per_pax"]),
  internal_cost_cents: z.number().int().min(0),
  public_price_cents: z.number().int().min(0),
  agency_price_cents: z.number().int().min(0).optional().nullable(),
  priority: z.number().int().min(1).max(999),
  vehicle_type: z.string().trim().max(32).optional().or(z.literal("")),
  time_from: z.string().optional().or(z.literal("")),
  time_to: z.string().optional().or(z.literal("")),
  season_from: z.string().optional().or(z.literal("")),
  season_to: z.string().optional().or(z.literal("")),
  needs_manual_review: z.boolean().default(false)
});

const defaultsFromAgency = (agency: Agency) => ({
  name: agency.name,
  legal_name: agency.legal_name ?? "",
  billing_name: agency.billing_name ?? "",
  vat_number: agency.vat_number ?? "",
  pec_email: agency.pec_email ?? "",
  sdi_code: agency.sdi_code ?? "",
  contact_email: agency.contact_email ?? "",
  booking_email: agency.booking_email ?? "",
  contact_emails_csv: agency.contact_emails.join(", "),
  booking_emails_csv: agency.booking_emails.join(", "),
  phone: agency.phone ?? "",
  parser_key_hint: agency.parser_key_hint ?? "",
  sender_domains_csv: (agency.sender_domains ?? []).join(", "),
  default_enabled_booking_kinds_csv: (agency.default_enabled_booking_kinds ?? []).join(", "),
  default_pricing_notes: agency.default_pricing_notes ?? "",
  notes: agency.notes ?? ""
});

export default function PricingAdminPage() {
  const [tenantId, setTenantId] = useState<string | null>(null);
  const [agencies, setAgencies] = useState<Agency[]>([]);
  const [routes, setRoutes] = useState<RouteItem[]>([]);
  const [priceLists, setPriceLists] = useState<PriceList[]>([]);
  const [rules, setRules] = useState<PricingRule[]>([]);
  const [matches, setMatches] = useState<ImportMatch[]>([]);
  const [sel, setSel] = useState<string[]>([]);
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [summary, setSummary] = useState({ totalServices: 0, totalRevenueCents: 0, totalCostCents: 0, totalMarginCents: 0 });
  const [days, setDays] = useState(30);
  const [agencyFilter, setAgencyFilter] = useState("");
  const [routeFilter, setRouteFilter] = useState("");
  const [agencySearch, setAgencySearch] = useState("");
  const [section, setSection] = useState<SectionKey>("listini");
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("Configurazione tariffe e margini.");
  const [createAgencyExpanded, setCreateAgencyExpanded] = useState(() => {
    if (typeof window === "undefined") return true;
    return window.localStorage.getItem(CREATE_AGENCY_PANEL_STORAGE_KEY) !== "0";
  });
  const [expandedAgencyId, setExpandedAgencyId] = useState<string | null>(null);
  const [editingAgencyId, setEditingAgencyId] = useState<string | null>(null);
  const [creatingAgency, setCreatingAgency] = useState(false);
  const [savingAgencyId, setSavingAgencyId] = useState<string | null>(null);
  const [deletingAgencyId, setDeletingAgencyId] = useState<string | null>(null);
  const [editingPriceListId, setEditingPriceListId] = useState<string | null>(null);
  const [savingPriceListId, setSavingPriceListId] = useState<string | null>(null);
  const [deletingPriceListId, setDeletingPriceListId] = useState<string | null>(null);
  const [savingAllBusLines, setSavingAllBusLines] = useState(false);
  const [savingAllStandardRows, setSavingAllStandardRows] = useState(false);
  const [activeRulesExpanded, setActiveRulesExpanded] = useState(false);
  const [listDraft, setListDraft] = useState({ name: "", currency: "EUR", valid_from: "", valid_to: "", agency_id: "", is_default: false });
  const [routeDraft, setRouteDraft] = useState({ name: "", origin_label: "", destination_label: "" });
  const [ruleDraft, setRuleDraft] = useState({ price_list_id: "", agency_id: "", route_id: "", bus_line_code: "", service_type: "" });
  const [preparedAgencyList, setPreparedAgencyList] = useState<{ agencyId: string; agencyName: string } | null>(null);
  const [standardRowDrafts, setStandardRowDrafts] = useState<Record<string, { internalCost: string; agencyPrice: string; publicPrice: string; busLineCode: string }>>({});
  const [busLineRowDrafts, setBusLineRowDrafts] = useState<Record<string, { internalCost: string; agencyPrice: string; publicPrice: string }>>({});
  const [editingCustomRuleId, setEditingCustomRuleId] = useState<string | null>(null);
  const [customRuleDraft, setCustomRuleDraft] = useState({
    route_id: "",
    service_type: "transfer",
    bus_line_code: "",
    internalCost: "",
    agencyPrice: "",
    publicPrice: ""
  });

  const token = async () => {
    if (!supabase) return null;
    const { data } = await supabase.auth.getSession();
    return data.session?.access_token ?? null;
  };

  const loadBase = async (tidIn?: string | null) => {
    if (!hasSupabaseEnv || !supabase) {
      setLoading(false);
      setMessage("Supabase non configurato.");
      return;
    }
    const tid = tidIn ?? tenantId;
    if (!tid) return;
    const t = await token();
    if (!t) {
      setLoading(false);
      setMessage("Sessione non valida.");
      return;
    }
    const res = await fetch("/api/pricing/bootstrap", { headers: { Authorization: `Bearer ${t}` } });
    const body = (await res.json().catch(() => null)) as { agencies?: LooseRow[]; routes?: LooseRow[]; price_lists?: LooseRow[]; pricing_rules?: LooseRow[]; error?: string } | null;
    if (!res.ok) {
      setLoading(false);
      setMessage(body?.error ?? "Errore caricamento configurazione tariffe.");
      return;
    }

    setAgencies(
      (body?.agencies ?? []).map((row) => {
        const legacyEmail = rowString(row, "email");
        const contactEmail = rowString(row, "contact_email") ?? legacyEmail;
        const bookingEmail = rowString(row, "booking_email") ?? legacyEmail;
        return {
          id: String(row.id ?? ""),
          name: String(row.name ?? ""),
          legal_name: rowString(row, "legal_name"),
          billing_name: rowString(row, "billing_name"),
          vat_number: rowString(row, "vat_number"),
          pec_email: rowString(row, "pec_email"),
          sdi_code: rowString(row, "sdi_code"),
          contact_email: contactEmail,
          booking_email: bookingEmail,
          contact_emails: unique([...(contactEmail ? [contactEmail] : []), ...rowStringArray(row, "contact_emails")]),
          booking_emails: unique([...(bookingEmail ? [bookingEmail] : []), ...rowStringArray(row, "booking_emails")]),
          phone: rowString(row, "phone"),
          parser_key_hint: rowString(row, "parser_key_hint"),
          sender_domains: rowStringArray(row, "sender_domains"),
          default_enabled_booking_kinds: rowStringArray(row, "default_enabled_booking_kinds"),
          default_pricing_notes: rowString(row, "default_pricing_notes"),
          notes: rowString(row, "notes"),
          active: row.active !== false
        } satisfies Agency;
      })
    );
    setRoutes(
      (body?.routes ?? []).map((row) => ({
        id: String(row.id ?? ""),
        name: String(row.name ?? ""),
        origin_label: String(row.origin_label ?? ""),
        destination_label: String(row.destination_label ?? ""),
        active: row.active !== false
      }))
    );
    setPriceLists(
      (body?.price_lists ?? []).map((row) => ({
        id: String(row.id ?? ""),
        name: String(row.name ?? ""),
        currency: String(row.currency ?? "EUR"),
        valid_from: String(row.valid_from ?? ""),
        valid_to: rowString(row, "valid_to"),
        active: row.active !== false,
        is_default: row.is_default === true,
        agency_id: rowString(row, "agency_id")
      }))
    );
    setRules(
      (body?.pricing_rules ?? []).map((row) => ({
        id: String(row.id ?? ""),
        price_list_id: String(row.price_list_id ?? ""),
        route_id: String(row.route_id ?? ""),
        agency_id: rowString(row, "agency_id"),
        bus_line_code: rowString(row, "bus_line_code"),
        service_type: row.service_type === "bus_tour" ? "bus_tour" : row.service_type === "transfer" ? "transfer" : null,
        direction: row.direction === "departure" ? "departure" : row.direction === "arrival" ? "arrival" : null,
        pax_min: Number(row.pax_min ?? 1),
        pax_max: typeof row.pax_max === "number" ? row.pax_max : null,
        rule_kind: row.rule_kind === "per_pax" ? "per_pax" : "fixed",
        internal_cost_cents: Number(row.internal_cost_cents ?? 0),
        public_price_cents: Number(row.public_price_cents ?? 0),
        agency_price_cents: typeof row.agency_price_cents === "number" ? row.agency_price_cents : null,
        priority: Number(row.priority ?? 100),
        vehicle_type: rowString(row, "vehicle_type"),
        time_from: rowString(row, "time_from"),
        time_to: rowString(row, "time_to"),
        season_from: rowString(row, "season_from"),
        season_to: rowString(row, "season_to"),
        needs_manual_review: row.needs_manual_review === true,
        active: row.active !== false
      }))
    );
    setLoading(false);
  };

  const loadMatches = async () => {
    if (!hasSupabaseEnv || !supabase) return;
    const t = await token();
    if (!t) return;
    const res = await fetch("/api/pricing/matches?limit=300", { headers: { Authorization: `Bearer ${t}` } });
    const b = (await res.json().catch(() => null)) as { rows?: ImportMatch[]; error?: string } | null;
    if (!res.ok) {
      setMatches([]);
      if (section === "match") setMessage(b?.error ?? "Errore caricamento match.");
      return;
    }
    setMatches(b?.rows ?? []);
  };

  const loadHistory = async (d = days, a = agencyFilter, r = routeFilter) => {
    if (!hasSupabaseEnv || !supabase) return;
    const t = await token();
    if (!t) return;
    const q = new URLSearchParams({ days: String(d) });
    if (a) q.set("agency_id", a);
    if (r) q.set("route_id", r);
    const res = await fetch(`/api/pricing/history?${q.toString()}`, { headers: { Authorization: `Bearer ${t}` } });
    const b = (await res.json().catch(() => null)) as { rows?: HistoryRow[]; summary?: typeof summary; error?: string } | null;
    if (!res.ok) return setMessage(b?.error ?? "Errore storico.");
    setHistory(b?.rows ?? []);
    setSummary(b?.summary ?? { totalServices: 0, totalRevenueCents: 0, totalCostCents: 0, totalMarginCents: 0 });
  };

  const loadBaseEvent = useEffectEvent(loadBase);
  const loadMatchesEvent = useEffectEvent(loadMatches);
  const loadHistoryEvent = useEffectEvent(loadHistory);

  useEffect(() => {
    const boot = async () => {
      if (!hasSupabaseEnv || !supabase) {
        setLoading(false);
        return;
      }
      const session = await getClientSessionContext();
      if (!session.userId) {
        setLoading(false);
        setMessage("Sessione non valida. Rifai login.");
        return;
      }
      if (!session.tenantId) {
        setLoading(false);
        setMessage("Membership tenant non trovata.");
        return;
      }
      setTenantId(session.tenantId);
      await loadBaseEvent(session.tenantId);
    };
    void boot();
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(CREATE_AGENCY_PANEL_STORAGE_KEY, createAgencyExpanded ? "1" : "0");
  }, [createAgencyExpanded]);

  useEffect(() => {
    if (section === "match") void loadMatchesEvent();
  }, [section]);

  useEffect(() => {
    if (section === "storico") void loadHistoryEvent();
  }, [section]);

  const parseAgencyForm = (fd: FormData) =>
    agencySchema.safeParse({
      name: String(fd.get("name") ?? ""),
      legal_name: String(fd.get("legal_name") ?? ""),
      billing_name: String(fd.get("billing_name") ?? ""),
      vat_number: String(fd.get("vat_number") ?? ""),
      pec_email: String(fd.get("pec_email") ?? ""),
      sdi_code: String(fd.get("sdi_code") ?? ""),
      contact_email: String(fd.get("contact_email") ?? ""),
      booking_email: String(fd.get("booking_email") ?? ""),
      contact_emails_csv: String(fd.get("contact_emails_csv") ?? ""),
      booking_emails_csv: String(fd.get("booking_emails_csv") ?? ""),
      phone: String(fd.get("phone") ?? ""),
      parser_key_hint: String(fd.get("parser_key_hint") ?? ""),
      sender_domains_csv: String(fd.get("sender_domains_csv") ?? ""),
      default_enabled_booking_kinds_csv: String(fd.get("default_enabled_booking_kinds_csv") ?? ""),
      default_pricing_notes: String(fd.get("default_pricing_notes") ?? ""),
      notes: String(fd.get("notes") ?? "")
    });

  const createAgency = async (fd: FormData) => {
    if (!supabase || !tenantId) return false;
    const p = parseAgencyForm(fd);
    if (!p.success) {
      setMessage(p.error.issues[0]?.message ?? "Dati agenzia non validi.");
      return false;
    }
    const t = await token();
    if (!t) {
      setMessage("Sessione non valida.");
      return false;
    }
    setCreatingAgency(true);
    setMessage("Creazione agenzia in corso...");
    const res = await fetch("/api/pricing/agencies", {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${t}` },
      body: JSON.stringify(p.data)
    });
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    setCreatingAgency(false);
    if (!res.ok) {
      setMessage(body?.error ?? "Salvataggio agenzia non riuscito.");
      return false;
    }
    setMessage("Agenzia creata.");
    await loadBase();
    return true;
  };

  const updateAgency = async (agencyId: string, fd: FormData) => {
    if (!supabase || !tenantId) return;
    const p = parseAgencyForm(fd);
    if (!p.success) return setMessage(p.error.issues[0]?.message ?? "Dati agenzia non validi.");
    setSavingAgencyId(agencyId);
    const t = await token();
    if (!t) {
      setSavingAgencyId(null);
      return setMessage("Sessione non valida.");
    }
    const res = await fetch("/api/pricing/agencies", {
      method: "PATCH",
      headers: { "content-type": "application/json", Authorization: `Bearer ${t}` },
      body: JSON.stringify({ agency_id: agencyId, ...p.data })
    });
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    setSavingAgencyId(null);
    if (!res.ok) return setMessage(body?.error ?? "Aggiornamento agenzia non riuscito.");
    setEditingAgencyId(null);
    setMessage("Agenzia aggiornata.");
    await loadBase();
  };

  const deleteAgency = async (agencyId: string) => {
    if (!supabase || !tenantId) return;
    const confirmed = window.confirm("Vuoi eliminare davvero questa agenzia? L'operazione non si puo annullare.");
    if (!confirmed) return;
    const t = await token();
    if (!t) return setMessage("Sessione non valida.");
    setDeletingAgencyId(agencyId);
    setMessage("Eliminazione agenzia in corso...");
    const res = await fetch("/api/pricing/agencies", {
      method: "DELETE",
      headers: { "content-type": "application/json", Authorization: `Bearer ${t}` },
      body: JSON.stringify({ agency_id: agencyId })
    });
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    setDeletingAgencyId(null);
    if (!res.ok) return setMessage(body?.error ?? "Eliminazione agenzia non riuscita.");
    if (editingAgencyId === agencyId) setEditingAgencyId(null);
    if (expandedAgencyId === agencyId) setExpandedAgencyId(null);
    setMessage("Agenzia eliminata.");
    await loadBase();
  };

  const submitAgencyUpdate =
    (agencyId: string) =>
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      await updateAgency(agencyId, new FormData(event.currentTarget));
    };

  const submitAgencyCreate = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const ok = await createAgency(new FormData(form));
    if (ok) {
      form.reset();
    }
  };

  const submitRouteCreate = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const ok = await createRoute(new FormData(event.currentTarget));
    if (ok) {
      setRouteDraft({ name: "", origin_label: "", destination_label: "" });
    }
  };

  const submitListCreate = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    if (editingPriceListId) {
      const ok = await updatePriceList(editingPriceListId, formData);
      if (ok) {
        setListDraft({ name: "", currency: "EUR", valid_from: "", valid_to: "", agency_id: "", is_default: false });
      }
      return;
    }
    const createdList = await createList(formData);
    if (createdList) {
      setListDraft((current) => ({ ...current, name: "", valid_from: "", valid_to: "", is_default: false }));
      if (preparedAgencyList && createdList.agency_id === preparedAgencyList.agencyId) {
        setRuleDraft((current) => ({
          ...current,
          price_list_id: createdList.id,
          agency_id: preparedAgencyList.agencyId
        }));
        setSection("regole");
        setMessage(`Listino ${createdList.name} creato. Adesso compila le righe standard in Regole prezzo per ${preparedAgencyList.agencyName}.`);
      }
    }
  };

  const startAgencyPriceList = (agency: Agency) => {
    setEditingPriceListId(null);
    setPreparedAgencyList({ agencyId: agency.id, agencyName: agency.name });
    setListDraft({
      name: `Listino ${agency.name}`,
      currency: "EUR",
      valid_from: "",
      valid_to: "",
      agency_id: agency.id,
      is_default: false
    });
    setSection("listini");
    setMessage(`Preparazione listino per ${agency.name}. Crea il listino qui, poi inserisci i prezzi in Regole prezzo.`);
  };

  const startEditPriceList = (item: PriceList) => {
    setEditingPriceListId(item.id);
    setPreparedAgencyList(null);
    setListDraft({
      name: item.name,
      currency: item.currency,
      valid_from: item.valid_from,
      valid_to: item.valid_to ?? "",
      agency_id: item.agency_id ?? "",
      is_default: item.is_default
    });
    setSection("listini");
    setMessage(`Modifica listino ${item.name}.`);
  };

  const openPriceListRules = (item: PriceList) => {
    setEditingPriceListId(null);
    setPreparedAgencyList(null);
    setRuleDraft((current) => ({
      ...current,
      price_list_id: item.id,
      agency_id: item.agency_id ?? ""
    }));
    setSection("regole");
    setMessage(`Stai compilando i prezzi del listino ${item.name}.`);
  };

  const applyRulePreset = (preset: RulePreset) => {
    const matchedRoute = preset.routeName ? routes.find((route) => route.name.toLowerCase() === preset.routeName.toLowerCase()) : null;
    setRuleDraft((current) => ({
      ...current,
      route_id: matchedRoute?.id ?? "",
      bus_line_code: preset.bus_line_code,
      service_type: preset.service_type
    }));
    setMessage(`Preset regola pronto: ${preset.label}. Inserisci ora solo i prezzi.`);
  };

  const createAlias = async (fd: FormData) => {
    if (!supabase || !tenantId) return;
    const p = aliasSchema.safeParse({ agency_id: String(fd.get("agency_id") ?? ""), alias: String(fd.get("alias") ?? "") });
    if (!p.success) return setMessage(p.error.issues[0]?.message ?? "Alias non valido.");
    const { error } = await supabase.from("agency_aliases").insert({ tenant_id: tenantId, ...p.data });
    if (error) return setMessage(error.message);
    setMessage("Alias creato.");
    await loadBase();
  };

  const createRoute = async (fd: FormData) => {
    if (!supabase || !tenantId) return;
    const p = routeSchema.safeParse({ name: String(fd.get("name") ?? ""), origin_label: String(fd.get("origin_label") ?? ""), destination_label: String(fd.get("destination_label") ?? "") });
    if (!p.success) {
      setMessage(p.error.issues[0]?.message ?? "Tratta non valida.");
      return false;
    }
    const t = await token();
    if (!t) {
      setMessage("Sessione non valida.");
      return false;
    }
    const res = await fetch("/api/pricing/routes", {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${t}` },
      body: JSON.stringify(p.data)
    });
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    if (!res.ok) {
      setMessage(body?.error ?? "Creazione tratta non riuscita.");
      return false;
    }
    setMessage("Tratta creata.");
    await loadBase();
    return true;
  };

  const ensureRoutePreset = async (routeName: string) => {
    const existing = routes.find((route) => route.name.toLowerCase() === routeName.toLowerCase());
    if (existing) return existing.id;

    const preset = ROUTE_PRESETS.find((item) => item.name.toLowerCase() === routeName.toLowerCase());
    if (!preset) return null;

    const t = await token();
    if (!t) {
      setMessage("Sessione non valida.");
      return null;
    }

    const res = await fetch("/api/pricing/routes", {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${t}` },
      body: JSON.stringify(preset)
    });
    const body = (await res.json().catch(() => null)) as { error?: string; route?: { id: string } } | null;
    if (!res.ok || !body?.route?.id) {
      setMessage(body?.error ?? `Creazione tratta ${routeName} non riuscita.`);
      return null;
    }

    await loadBase();
    return body.route.id;
  };

  const createList = async (fd: FormData) => {
    if (!supabase || !tenantId) return;
    const p = priceListSchema.safeParse({
      name: String(fd.get("name") ?? ""),
      currency: String(fd.get("currency") ?? "EUR"),
      valid_from: String(fd.get("valid_from") ?? ""),
      valid_to: String(fd.get("valid_to") ?? ""),
      agency_id: String(fd.get("agency_id") ?? ""),
      is_default: String(fd.get("is_default") ?? "") === "on"
    });
    if (!p.success) {
      setMessage(p.error.issues[0]?.message ?? "Listino non valido.");
      return false;
    }
    const t = await token();
    if (!t) {
      setMessage("Sessione non valida.");
      return false;
    }
    const res = await fetch("/api/pricing/price-lists", {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${t}` },
      body: JSON.stringify(p.data)
    });
    const body = (await res.json().catch(() => null)) as { error?: string; price_list?: { id: string; agency_id: string | null; name: string } } | null;
    if (!res.ok || !body?.price_list) {
      setMessage(body?.error ?? "Creazione listino non riuscita.");
      return false;
    }
    setMessage("Listino creato.");
    await loadBase();
    return body.price_list;
  };

  const updatePriceList = async (priceListId: string, fd: FormData) => {
    if (!supabase || !tenantId) return false;
    const p = priceListSchema.safeParse({
      name: String(fd.get("name") ?? ""),
      currency: String(fd.get("currency") ?? "EUR"),
      valid_from: String(fd.get("valid_from") ?? ""),
      valid_to: String(fd.get("valid_to") ?? ""),
      agency_id: String(fd.get("agency_id") ?? ""),
      is_default: String(fd.get("is_default") ?? "") === "on"
    });
    if (!p.success) {
      setMessage(p.error.issues[0]?.message ?? "Listino non valido.");
      return false;
    }
    const t = await token();
    if (!t) {
      setMessage("Sessione non valida.");
      return false;
    }
    setSavingPriceListId(priceListId);
    const res = await fetch("/api/pricing/price-lists", {
      method: "PATCH",
      headers: { "content-type": "application/json", Authorization: `Bearer ${t}` },
      body: JSON.stringify({ price_list_id: priceListId, ...p.data })
    });
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    setSavingPriceListId(null);
    if (!res.ok) {
      setMessage(body?.error ?? "Aggiornamento listino non riuscito.");
      return false;
    }
    setEditingPriceListId(null);
    setPreparedAgencyList(null);
    setMessage("Listino aggiornato.");
    await loadBase();
    return true;
  };

  const deletePriceList = async (priceListId: string) => {
    if (!supabase || !tenantId) return;
    const confirmed = window.confirm("Vuoi eliminare davvero questo listino? Verranno eliminate anche le regole collegate.");
    if (!confirmed) return;
    const t = await token();
    if (!t) return setMessage("Sessione non valida.");
    setDeletingPriceListId(priceListId);
    const res = await fetch("/api/pricing/price-lists", {
      method: "DELETE",
      headers: { "content-type": "application/json", Authorization: `Bearer ${t}` },
      body: JSON.stringify({ price_list_id: priceListId })
    });
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    setDeletingPriceListId(null);
    if (!res.ok) return setMessage(body?.error ?? "Eliminazione listino non riuscita.");
    if (editingPriceListId === priceListId) {
      setEditingPriceListId(null);
      setListDraft({ name: "", currency: "EUR", valid_from: "", valid_to: "", agency_id: "", is_default: false });
    }
    setPreparedAgencyList(null);
    setMessage("Listino eliminato.");
    await loadBase();
  };

  const createRule = async (fd: FormData) => {
    if (!supabase || !tenantId) return;
    const p = pricingRuleSchema.safeParse({
      price_list_id: String(fd.get("price_list_id") ?? ""),
      route_id: String(fd.get("route_id") ?? ""),
      agency_id: String(fd.get("agency_id") ?? ""),
      bus_line_code: String(fd.get("bus_line_code") ?? ""),
      service_type: String(fd.get("service_type") ?? ""),
      direction: String(fd.get("direction") ?? ""),
      pax_min: Number(fd.get("pax_min") ?? 1),
      pax_max: fd.get("pax_max") ? Number(fd.get("pax_max")) : null,
      rule_kind: String(fd.get("rule_kind") ?? "fixed") as "fixed" | "per_pax",
      internal_cost_cents: parseEuroAmountToCents(fd.get("internal_cost_cents")),
      public_price_cents: parseEuroAmountToCents(fd.get("public_price_cents")),
      agency_price_cents: parseEuroAmountToCents(fd.get("agency_price_cents")),
      priority: Number(fd.get("priority") ?? 100),
      vehicle_type: String(fd.get("vehicle_type") ?? ""),
      time_from: String(fd.get("time_from") ?? ""),
      time_to: String(fd.get("time_to") ?? ""),
      season_from: String(fd.get("season_from") ?? ""),
      season_to: String(fd.get("season_to") ?? ""),
      needs_manual_review: String(fd.get("needs_manual_review") ?? "") === "on"
    });
    if (!p.success) return setMessage(p.error.issues[0]?.message ?? "Regola non valida.");
    const payload = {
      ...p.data,
      agency_id: p.data.agency_id || null,
      bus_line_code: p.data.bus_line_code || null,
      service_type: p.data.service_type || null,
      direction: p.data.direction || null,
      vehicle_type: p.data.vehicle_type ? p.data.vehicle_type.toUpperCase() : null,
      time_from: p.data.time_from || null,
      time_to: p.data.time_to || null,
      season_from: p.data.season_from || null,
      season_to: p.data.season_to || null,
      tenant_id: tenantId,
      active: true
    };
    const t = await token();
    if (!t) return setMessage("Sessione non valida.");
    const res = await fetch("/api/pricing/rules", {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${t}` },
      body: JSON.stringify(payload)
    });
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    if (!res.ok) return setMessage(body?.error ?? "Creazione regola non riuscita.");
    setMessage("Regola creata.");
    setRuleDraft((current) => ({
      ...current,
      route_id: "",
      bus_line_code: "",
      service_type: ""
    }));
    await loadBase();
  };

  const saveStandardGridRow = async (row: (typeof standardGridRows)[number]) => {
    if (!supabase || !tenantId) return;
    if (!ruleDraft.price_list_id) {
      setMessage("Seleziona prima un listino.");
      return;
    }
    const resolvedRouteId = row.routeId || (row.routeName ? await ensureRoutePreset(row.routeName) : null);
    if (!resolvedRouteId) {
      setMessage(`Manca la tratta standard per ${row.label}.`);
      return;
    }

    const draft = standardRowDrafts[row.key];
    const internalCostInput = draft?.internalCost ?? centsToEuroInput(row.existingRule?.internal_cost_cents ?? 0);
    const agencyPriceInput = draft?.agencyPrice ?? centsToEuroInput(row.existingRule?.agency_price_cents ?? 0);
    const publicPriceInput = draft?.publicPrice ?? centsToEuroInput(row.existingRule?.public_price_cents ?? 0);

    const internalCostCents = parseEuroAmountToCents(internalCostInput);
    const agencyPriceCents = parseEuroAmountToCents(agencyPriceInput);
    const publicPriceCandidate = parseEuroAmountToCents(publicPriceInput);

    if (!Number.isFinite(internalCostCents) || internalCostCents === null) {
      setMessage(`Inserisci un costo valido per ${row.label}.`);
      return;
    }

    const resolvedPublicPrice =
      typeof publicPriceCandidate === "number" && Number.isFinite(publicPriceCandidate)
        ? publicPriceCandidate
        : typeof agencyPriceCents === "number" && Number.isFinite(agencyPriceCents)
          ? agencyPriceCents
          : null;

    if (resolvedPublicPrice === null) {
      setMessage(`Inserisci almeno un prezzo vendita per ${row.label}.`);
      return;
    }

    const resolvedAgencyPrice =
      typeof agencyPriceCents === "number" && Number.isFinite(agencyPriceCents) ? agencyPriceCents : null;

    const payload = {
      tenant_id: tenantId,
      price_list_id: ruleDraft.price_list_id,
      route_id: resolvedRouteId,
      agency_id: ruleDraft.agency_id || null,
      bus_line_code: draft?.busLineCode?.trim() || null,
      service_type: row.serviceType,
      direction: null,
      pax_min: 1,
      pax_max: null,
      rule_kind: "fixed" as const,
      internal_cost_cents: internalCostCents,
      public_price_cents: resolvedPublicPrice,
      agency_price_cents: resolvedAgencyPrice,
      priority: row.existingRule?.priority ?? 100,
      vehicle_type: null,
      time_from: null,
      time_to: null,
      season_from: null,
      season_to: null,
      needs_manual_review: false,
      active: true
    };

    const t = await token();
    if (!t) {
      setMessage("Sessione non valida.");
      return;
    }

    if (row.existingRule) {
      const res = await fetch("/api/pricing/rules", {
        method: "PATCH",
        headers: { "content-type": "application/json", Authorization: `Bearer ${t}` },
        body: JSON.stringify({ rule_id: row.existingRule.id, ...payload })
      });
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) {
        setMessage(body?.error ?? `Aggiornamento riga ${row.label} non riuscito.`);
        return;
      }
      setMessage(`Riga ${row.label} aggiornata.`);
    } else {
      const res = await fetch("/api/pricing/rules", {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: `Bearer ${t}` },
        body: JSON.stringify(payload)
      });
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) {
        setMessage(body?.error ?? `Creazione riga ${row.label} non riuscita.`);
        return;
      }
      setMessage(`Riga ${row.label} creata.`);
    }

    await loadBase();
  };

  const saveAllStandardGridRows = async () => {
    if (!ruleDraft.price_list_id) {
      setMessage("Seleziona prima un listino.");
      return;
    }

    const rowsToSave = standardGridRows.filter((row) => {
      const draft = standardRowDrafts[row.key];
      return Boolean(draft?.internalCost?.trim() || draft?.agencyPrice?.trim() || draft?.publicPrice?.trim() || draft?.busLineCode?.trim());
    });

    if (rowsToSave.length === 0) {
      setMessage("Compila almeno una riga standard prima di usare Salva tutte le righe.");
      return;
    }

    setSavingAllStandardRows(true);
    setMessage(`Salvataggio di ${rowsToSave.length} righe standard in corso...`);
    for (const row of rowsToSave) {
      await saveStandardGridRow(row);
    }
    setSavingAllStandardRows(false);
    setMessage(`Salvate ${rowsToSave.length} righe standard.`);
  };

  const deletePricingRuleRow = async (ruleId: string) => {
    if (!supabase || !tenantId) return;
    const confirmed = window.confirm("Vuoi eliminare questa riga del listino?");
    if (!confirmed) return;
    const t = await token();
    if (!t) {
      setMessage("Sessione non valida.");
      return;
    }
    const res = await fetch("/api/pricing/rules", {
      method: "DELETE",
      headers: { "content-type": "application/json", Authorization: `Bearer ${t}` },
      body: JSON.stringify({ rule_id: ruleId })
    });
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    if (!res.ok) {
      setMessage(body?.error ?? "Eliminazione riga non riuscita.");
      return;
    }
    setMessage("Riga listino eliminata.");
    await loadBase();
  };

  const saveBusLineRule = async (line: (typeof BUS_LINES_2026)[number], options?: { skipReload?: boolean }) => {
    if (!supabase || !tenantId) return false;
    if (!ruleDraft.price_list_id) {
      setMessage("Seleziona prima un listino.");
      return false;
    }
    const resolvedRouteId = lineaBusRoute?.id || (await ensureRoutePreset("LINEA BUS"));
    if (!resolvedRouteId) {
      setMessage("Manca la tratta standard LINEA BUS.");
      return false;
    }

    const existingRule = busLineListRules.find((rule) => rule.bus_line_code === line.code);
    const draft = busLineRowDrafts[line.code];
    const internalCostCents = parseEuroAmountToCents(draft?.internalCost ?? "");
    const agencyPriceCents = parseEuroAmountToCents(draft?.agencyPrice ?? "");
    const publicPriceCandidate = parseEuroAmountToCents(draft?.publicPrice ?? "");

    if (!Number.isFinite(internalCostCents) || internalCostCents === null) {
      setMessage(`Inserisci un costo valido per ${line.name}.`);
      return false;
    }

    const resolvedPublicPrice =
      typeof publicPriceCandidate === "number" && Number.isFinite(publicPriceCandidate)
        ? publicPriceCandidate
        : typeof agencyPriceCents === "number" && Number.isFinite(agencyPriceCents)
          ? agencyPriceCents
          : null;

    if (resolvedPublicPrice === null) {
      setMessage(`Inserisci almeno un prezzo vendita per ${line.name}.`);
      return false;
    }

    const resolvedAgencyPrice =
      typeof agencyPriceCents === "number" && Number.isFinite(agencyPriceCents) ? agencyPriceCents : null;

    const payload = {
      tenant_id: tenantId,
      price_list_id: ruleDraft.price_list_id,
      route_id: resolvedRouteId,
      agency_id: ruleDraft.agency_id || null,
      bus_line_code: line.code,
      service_type: "bus_tour" as const,
      direction: null,
      pax_min: 1,
      pax_max: null,
      rule_kind: "fixed" as const,
      internal_cost_cents: internalCostCents,
      public_price_cents: resolvedPublicPrice,
      agency_price_cents: resolvedAgencyPrice,
      priority: existingRule?.priority ?? 100,
      vehicle_type: null,
      time_from: null,
      time_to: null,
      season_from: null,
      season_to: null,
      needs_manual_review: false,
      active: true
    };

    const t = await token();
    if (!t) {
      setMessage("Sessione non valida.");
      return false;
    }

    if (existingRule) {
      const res = await fetch("/api/pricing/rules", {
        method: "PATCH",
        headers: { "content-type": "application/json", Authorization: `Bearer ${t}` },
        body: JSON.stringify({ rule_id: existingRule.id, ...payload })
      });
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) {
        setMessage(body?.error ?? `Aggiornamento linea ${line.code} non riuscito.`);
        return false;
      }
      setMessage(`Linea ${line.code} aggiornata.`);
    } else {
      const res = await fetch("/api/pricing/rules", {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: `Bearer ${t}` },
        body: JSON.stringify(payload)
      });
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) {
        setMessage(body?.error ?? `Creazione linea ${line.code} non riuscita.`);
        return false;
      }
      setMessage(`Linea ${line.code} creata.`);
    }

    if (!options?.skipReload) {
      await loadBase();
    }
    return true;
  };

  const saveAllBusLineRules = async () => {
    if (!ruleDraft.price_list_id) {
      setMessage("Seleziona prima un listino.");
      return;
    }

    const linesToSave = BUS_LINES_2026.filter((line) => {
      const draft = busLineRowDrafts[line.code];
      const existingRule = busLineListRules.find((rule) => rule.bus_line_code === line.code);
      const internalCostInput = draft?.internalCost ?? centsToEuroInput(existingRule?.internal_cost_cents ?? null);
      const agencyPriceInput = draft?.agencyPrice ?? centsToEuroInput(existingRule?.agency_price_cents ?? null);
      const publicPriceInput = draft?.publicPrice ?? centsToEuroInput(existingRule?.public_price_cents ?? null);
      return Boolean(internalCostInput?.trim() || agencyPriceInput?.trim() || publicPriceInput?.trim());
    });

    if (linesToSave.length === 0) {
      setMessage("Compila almeno una linea bus prima di usare Salva tutte le linee.");
      return;
    }

    setSavingAllBusLines(true);
    setMessage(`Salvataggio di ${linesToSave.length} linee bus in corso...`);
    for (const line of linesToSave) {
      const ok = await saveBusLineRule(line, { skipReload: true });
      if (!ok) {
        setSavingAllBusLines(false);
        return;
      }
    }

    setSavingAllBusLines(false);
    await loadBase();
    setMessage(`Salvate ${linesToSave.length} linee bus.`);
  };

  const saveCustomRuleRow = async () => {
    if (!supabase || !tenantId) return;
    if (!ruleDraft.price_list_id) {
      setMessage("Seleziona prima un listino.");
      return;
    }
    if (!customRuleDraft.route_id) {
      setMessage("Seleziona una tratta per la voce custom.");
      return;
    }

    const internalCostCents = parseEuroAmountToCents(customRuleDraft.internalCost);
    const agencyPriceCents = parseEuroAmountToCents(customRuleDraft.agencyPrice);
    const publicPriceCents = parseEuroAmountToCents(customRuleDraft.publicPrice);

    if (!Number.isFinite(internalCostCents) || internalCostCents === null) {
      setMessage("Inserisci un costo valido per la voce custom.");
      return;
    }

    const resolvedPublicPrice =
      typeof publicPriceCents === "number" && Number.isFinite(publicPriceCents)
        ? publicPriceCents
        : typeof agencyPriceCents === "number" && Number.isFinite(agencyPriceCents)
          ? agencyPriceCents
          : null;

    if (resolvedPublicPrice === null) {
      setMessage("Inserisci almeno un prezzo vendita per la voce custom.");
      return;
    }

    const resolvedAgencyPrice =
      typeof agencyPriceCents === "number" && Number.isFinite(agencyPriceCents) ? agencyPriceCents : null;

    const payload = {
      tenant_id: tenantId,
      price_list_id: ruleDraft.price_list_id,
      route_id: customRuleDraft.route_id,
      agency_id: ruleDraft.agency_id || null,
      bus_line_code: customRuleDraft.bus_line_code.trim() || null,
      service_type: customRuleDraft.service_type || null,
      direction: null,
      pax_min: 1,
      pax_max: null,
      rule_kind: "fixed",
      internal_cost_cents: internalCostCents,
      public_price_cents: resolvedPublicPrice,
      agency_price_cents: resolvedAgencyPrice,
      priority: 100,
      vehicle_type: null,
      time_from: null,
      time_to: null,
      season_from: null,
      season_to: null,
      needs_manual_review: false,
      active: true
    };
    const t = await token();
    if (!t) {
      setMessage("Sessione non valida.");
      return;
    }
    const res = await fetch("/api/pricing/rules", {
      method: editingCustomRuleId ? "PATCH" : "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${t}` },
      body: JSON.stringify(editingCustomRuleId ? { rule_id: editingCustomRuleId, ...payload } : payload)
    });
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    if (!res.ok) {
      setMessage(body?.error ?? (editingCustomRuleId ? "Aggiornamento voce custom non riuscito." : "Creazione voce custom non riuscita."));
      return;
    }

    setCustomRuleDraft({
      route_id: "",
      service_type: "transfer",
      bus_line_code: "",
      internalCost: "",
      agencyPrice: "",
      publicPrice: ""
    });
    setEditingCustomRuleId(null);
    setMessage(editingCustomRuleId ? "Voce custom aggiornata." : "Voce custom creata.");
    await loadBase();
  };

  const startEditCustomRule = (rule: PricingRule) => {
    setEditingCustomRuleId(rule.id);
    setCustomRuleDraft({
      route_id: rule.route_id,
      service_type: (rule.service_type as "transfer" | "bus_tour") ?? "transfer",
      bus_line_code: rule.bus_line_code ?? "",
      internalCost: centsToEuroInput(rule.internal_cost_cents),
      agencyPrice: centsToEuroInput(rule.agency_price_cents),
      publicPrice: centsToEuroInput(rule.public_price_cents)
    });
    setMessage("Modifica voce custom pronta.");
  };

  const cancelEditCustomRule = () => {
    setEditingCustomRuleId(null);
    setCustomRuleDraft({
      route_id: "",
      service_type: "transfer",
      bus_line_code: "",
      internalCost: "",
      agencyPrice: "",
      publicPrice: ""
    });
    setMessage("Modifica voce custom annullata.");
  };

  const toggle = async (table: "agencies" | "routes" | "price_lists" | "pricing_rules", id: string, current: boolean) => {
    if (!supabase || !tenantId) return;
    const { error } = await supabase.from(table).update({ active: !current }).eq("id", id).eq("tenant_id", tenantId);
    if (error) return setMessage(error.message);
    await loadBase();
  };

  const delRule = async (id: string) => {
    if (!supabase || !tenantId) return;
    const { error } = await supabase.from("pricing_rules").delete().eq("id", id).eq("tenant_id", tenantId);
    if (error) return setMessage(error.message);
    await loadBase();
  };

  const matchAction = async (action: "approve" | "reject" | "reapply") => {
    if (!hasSupabaseEnv || !supabase || sel.length === 0) return;
    const t = await token();
    if (!t) return;
    const res = await fetch("/api/pricing/matches", { method: "POST", headers: { "content-type": "application/json", Authorization: `Bearer ${t}` }, body: JSON.stringify({ action, ids: sel }) });
    const b = (await res.json().catch(() => null)) as { error?: string } | null;
    if (!res.ok) return setMessage(b?.error ?? "Azione match non riuscita.");
    setSel([]);
    setMessage("Azione match completata.");
    await Promise.all([loadMatches(), loadHistory()]);
  };

  const kpi = useMemo(() => ({ total: summary.totalServices, revenue: eur(summary.totalRevenueCents), cost: eur(summary.totalCostCents), margin: eur(summary.totalMarginCents) }), [summary]);
  const filteredAgencies = useMemo(() => {
    const query = agencySearch.trim().toLowerCase();
    if (!query) return agencies;
    return agencies.filter((agency) => {
      const haystack = [
        agency.name,
        agency.legal_name ?? "",
        agency.billing_name ?? "",
        agency.vat_number ?? "",
        agency.contact_email ?? "",
        agency.booking_email ?? ""
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(query);
    });
  }, [agencies, agencySearch]);
  const groupedPriceLists = useMemo(() => {
    const privateLists = priceLists.filter((item) => !item.agency_id);
    const agencyLists = priceLists.filter((item) => Boolean(item.agency_id));
    return { privateLists, agencyLists };
  }, [priceLists]);
  const editingPriceList = editingPriceListId ? priceLists.find((item) => item.id === editingPriceListId) ?? null : null;
  const lineaBusRoute = routes.find((item) => item.name.toLowerCase() === "linea bus");
  const standardGridRows = STANDARD_PRICE_GRID_ROWS.map((row) => {
    const route = row.routeName ? routes.find((item) => item.name.toLowerCase() === row.routeName.toLowerCase()) : null;
    const existingRule = rules.find(
      (rule) =>
        rule.price_list_id === ruleDraft.price_list_id &&
        rule.agency_id === (ruleDraft.agency_id || null) &&
        ((route && rule.route_id === route.id) || (!route && row.busLineCode && rule.bus_line_code?.startsWith(row.busLineCode)))
    );
    return {
      ...row,
      routeId: route?.id ?? "",
      routeReady: Boolean(route) || row.busLineCode.length > 0,
      existingRule
    };
  });
  const standardRuleIds = new Set(standardGridRows.flatMap((row) => (row.existingRule ? [row.existingRule.id] : [])));
  const busLineListRules = rules.filter(
    (rule) =>
      rule.price_list_id === ruleDraft.price_list_id &&
      rule.agency_id === (ruleDraft.agency_id || null) &&
      Boolean(rule.bus_line_code) &&
      (rule.route_id === (lineaBusRoute?.id ?? "") || rule.service_type === "bus_tour" || routes.find((item) => item.id === rule.route_id)?.name === "LINEA BUS")
  );
  const busLineRuleIds = new Set(busLineListRules.map((rule) => rule.id));
  const customListRules = rules.filter(
    (rule) =>
      rule.price_list_id === ruleDraft.price_list_id &&
      rule.agency_id === (ruleDraft.agency_id || null) &&
      !standardRuleIds.has(rule.id) &&
      !busLineRuleIds.has(rule.id)
  );
  if (loading) return <div className="card p-4 text-sm text-slate-500">Caricamento tariffe...</div>;

  return (
    <section className="pricing-admin space-y-4">
      <div className="card space-y-3 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h1 className="text-2xl font-semibold">Tariffe e Margini</h1>
          <p className="text-xs text-slate-500">Modulo premium per listini, matching inbound e marginalita</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {([{ key: "listini", label: "Listini" }, { key: "regole", label: "Regole prezzo" }, { key: "agenzie", label: "Agenzie" }, { key: "match", label: "Match prenotazioni" }, { key: "storico", label: "Storico margini" }] as Array<{ key: SectionKey; label: string }>).map((i) => (
            <button key={i.key} type="button" onClick={() => setSection(i.key)} className={section === i.key ? "btn-primary px-3 py-1.5 text-sm" : "btn-secondary px-3 py-1.5 text-sm"}>
              {i.label}
            </button>
          ))}
        </div>
        <p className="text-sm text-slate-600">{message}</p>
      </div>

      {section === "listini" ? (
        <div className="card space-y-4 p-4">
          <h2 className="text-base font-semibold">Listini</h2>
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-3 text-sm text-amber-900">
            Qui crei il contenitore del listino, di solito uno per agenzia e uno per i privati.
            I prezzi veri si inseriscono dopo nella sezione `Regole prezzo`.
          </div>
          {editingPriceList ? (
            <div className="rounded-xl border border-sky-200 bg-sky-50 px-3 py-3 text-sm text-sky-900">
              Stai modificando <span className="font-semibold">{editingPriceList.name}</span>.
            </div>
          ) : null}
          <form onSubmit={submitListCreate} className="grid gap-2 md:grid-cols-5">
            <div className="rounded-xl border border-slate-200 px-3 py-3 md:col-span-5">
              <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Preset rapidi listino</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {PRICE_LIST_NAME_PRESETS.map((preset) => (
                  <button
                    key={preset}
                    type="button"
                    className="rounded-full border border-slate-300 px-3 py-1 text-xs text-slate-700 hover:border-slate-400"
                    onClick={() => setListDraft((current) => ({ ...current, name: preset }))}
                  >
                    {preset}
                  </button>
                ))}
              </div>
              <p className="mt-2 text-xs text-slate-500">Per `LINEA BUS` usiamo un prezzo per singola linea del PDF, non serve riportare tutte le fermate nel listino.</p>
            </div>
            <input name="name" list="price-list-name-presets" placeholder="Nome listino" className="input-saas" value={listDraft.name} onChange={(event) => setListDraft((current) => ({ ...current, name: event.target.value }))} />
            <datalist id="price-list-name-presets">
              {PRICE_LIST_NAME_PRESETS.map((preset) => (
                <option key={preset} value={preset} />
              ))}
            </datalist>
            <select name="currency" className="input-saas" value={listDraft.currency} onChange={(event) => setListDraft((current) => ({ ...current, currency: event.target.value.toUpperCase() }))}>
              <option value="EUR">EUR</option>
            </select>
            <input name="valid_from" type="date" className="input-saas" value={listDraft.valid_from} onChange={(event) => setListDraft((current) => ({ ...current, valid_from: event.target.value }))} />
            <input name="valid_to" type="date" className="input-saas" value={listDraft.valid_to} onChange={(event) => setListDraft((current) => ({ ...current, valid_to: event.target.value }))} />
            <select name="agency_id" className="input-saas" value={listDraft.agency_id} onChange={(event) => setListDraft((current) => ({ ...current, agency_id: event.target.value }))}>
              <option value="">Listino privati</option>
              {agencies.map((agency) => (
                <option key={agency.id} value={agency.id}>
                  Listino agenzia: {agency.name}
                </option>
              ))}
            </select>
            <label className="inline-flex items-center gap-2 text-sm md:col-span-5">
              <input type="checkbox" name="is_default" checked={listDraft.is_default} onChange={(event) => setListDraft((current) => ({ ...current, is_default: event.target.checked }))} /> Listino predefinito per il contesto selezionato
            </label>
            <div className="flex flex-wrap gap-2 md:col-span-5">
              <button className="btn-primary px-4 py-2 text-sm" type="submit">
                {editingPriceListId ? (savingPriceListId === editingPriceListId ? "Salvataggio..." : "Salva Modifiche") : "Crea Listino"}
              </button>
              {editingPriceListId ? (
                <button
                  className="rounded-xl border border-slate-300 px-4 py-2 text-sm text-slate-700"
                  type="button"
                  onClick={() => {
                    setEditingPriceListId(null);
                    setPreparedAgencyList(null);
                    setListDraft({ name: "", currency: "EUR", valid_from: "", valid_to: "", agency_id: "", is_default: false });
                    setMessage("Modifica listino annullata.");
                  }}
                >
                  Annulla
                </button>
              ) : null}
            </div>
          </form>

          <div className="space-y-4 text-sm">
            <div className="space-y-2">
              <h3 className="text-sm font-semibold text-slate-700">Privati</h3>
              {groupedPriceLists.privateLists.length > 0 ? groupedPriceLists.privateLists.map((item) => (
                <div key={item.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 px-3 py-2">
                  <p>
                    <span className="font-medium">{item.name}</span> | {item.currency} | {item.valid_from}
                    {item.valid_to ? ` -> ${item.valid_to}` : " -> aperto"} | Privati
                    {item.is_default ? " | Default" : ""}
                    {editingPriceListId === item.id ? " | In modifica" : ""}
                  </p>
                  <div className="flex items-center gap-2 text-xs">
                    <button className="rounded-lg border border-sky-300 px-2 py-1 font-medium text-sky-700" onClick={() => openPriceListRules(item)} type="button">
                      Prezzi
                    </button>
                    <button className="rounded-lg border border-slate-300 px-2 py-1 font-medium text-slate-700" onClick={() => startEditPriceList(item)} type="button">
                      Modifica dati
                    </button>
                    <button className="rounded-lg border border-rose-300 px-2 py-1 font-medium text-rose-700" onClick={() => void deletePriceList(item.id)} type="button">
                      {deletingPriceListId === item.id ? "Eliminazione..." : "Elimina"}
                    </button>
                    <button className="rounded-lg border border-slate-300 px-2 py-1 font-medium text-slate-700" onClick={() => void toggle("price_lists", item.id, item.active)} type="button">
                      {item.active ? "Disattiva" : "Attiva"}
                    </button>
                  </div>
                </div>
              )) : <div className="rounded-xl border border-dashed border-slate-200 px-3 py-2 text-slate-500">Nessun listino privati.</div>}
            </div>

            <div className="space-y-2">
              <h3 className="text-sm font-semibold text-slate-700">Agenzie</h3>
              {groupedPriceLists.agencyLists.length > 0 ? groupedPriceLists.agencyLists.map((item) => (
                <div key={item.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 px-3 py-2">
                  <p>
                    <span className="font-medium">{item.name}</span> | {item.currency} | {item.valid_from}
                    {item.valid_to ? ` -> ${item.valid_to}` : " -> aperto"} | Agenzia: {agencies.find((agency) => agency.id === item.agency_id)?.name ?? "n/d"}
                    {item.is_default ? " | Default" : ""}
                    {editingPriceListId === item.id ? " | In modifica" : ""}
                  </p>
                  <div className="flex items-center gap-2 text-xs">
                    <button className="rounded-lg border border-sky-300 px-2 py-1 font-medium text-sky-700" onClick={() => openPriceListRules(item)} type="button">
                      Prezzi
                    </button>
                    <button className="rounded-lg border border-slate-300 px-2 py-1 font-medium text-slate-700" onClick={() => startEditPriceList(item)} type="button">
                      Modifica dati
                    </button>
                    <button className="rounded-lg border border-rose-300 px-2 py-1 font-medium text-rose-700" onClick={() => void deletePriceList(item.id)} type="button">
                      {deletingPriceListId === item.id ? "Eliminazione..." : "Elimina"}
                    </button>
                    <button className="rounded-lg border border-slate-300 px-2 py-1 font-medium text-slate-700" onClick={() => void toggle("price_lists", item.id, item.active)} type="button">
                      {item.active ? "Disattiva" : "Attiva"}
                    </button>
                  </div>
                </div>
              )) : <div className="rounded-xl border border-dashed border-slate-200 px-3 py-2 text-slate-500">Nessun listino agenzia.</div>}
            </div>
          </div>
        </div>
      ) : null}

      {section === "regole" ? (
        <div className="space-y-4">
          <form onSubmit={submitRouteCreate} className="card space-y-2 p-4">
            <h2 className="text-base font-semibold">Nuova Tratta</h2>
            <div className="rounded-xl border border-slate-200 px-3 py-3">
              <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Preset rapidi tratta</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {ROUTE_PRESETS.map((preset) => (
                  <button
                    key={preset.name}
                    type="button"
                    className="rounded-full border border-slate-300 px-3 py-1 text-xs text-slate-700 hover:border-slate-400"
                    onClick={() => setRouteDraft(preset)}
                  >
                    {preset.name}
                  </button>
                ))}
              </div>
              <p className="mt-2 text-xs text-slate-500">Per `LINEA BUS` ti basta una voce per linea; le fermate complete non sono necessarie nella tariffazione.</p>
            </div>
            <div className="grid gap-2 md:grid-cols-3">
              <input name="name" list="route-name-presets" placeholder="Nome tratta" className="input-saas" value={routeDraft.name} onChange={(event) => setRouteDraft((current) => ({ ...current, name: event.target.value }))} />
              <datalist id="route-name-presets">
                {ROUTE_PRESETS.map((preset) => (
                  <option key={preset.name} value={preset.name} />
                ))}
              </datalist>
              <input name="origin_label" placeholder="Origine" className="input-saas" value={routeDraft.origin_label} onChange={(event) => setRouteDraft((current) => ({ ...current, origin_label: event.target.value }))} />
              <input name="destination_label" placeholder="Destinazione" className="input-saas" value={routeDraft.destination_label} onChange={(event) => setRouteDraft((current) => ({ ...current, destination_label: event.target.value }))} />
            </div>
            <button className="btn-primary px-4 py-2 text-sm">Crea Tratta</button>
          </form>

          <form action={createRule} className="card grid gap-2 p-4 md:grid-cols-4">
            <h2 className="text-base font-semibold md:col-span-4">Nuova Regola Prezzo</h2>
            {ruleDraft.price_list_id ? (
              <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-3 text-sm text-emerald-900 md:col-span-4">
                Stai compilando il listino{" "}
                <span className="font-semibold">
                  {priceLists.find((item) => item.id === ruleDraft.price_list_id)?.name ?? "selezionato"}
                </span>
                {ruleDraft.agency_id
                  ? ` per ${agencies.find((item) => item.id === ruleDraft.agency_id)?.name ?? "agenzia selezionata"}`
                  : ""}.
              </div>
            ) : null}
            {ruleDraft.price_list_id ? (
              <div className="rounded-xl border border-slate-200 px-3 py-3 md:col-span-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Griglia standard listino</p>
                  <div className="flex items-center gap-3">
                    <p className="text-xs text-slate-500">Costo + prezzo vendita. Puoi aggiungere poi altre voci custom dal form sotto.</p>
                    <button className="rounded-lg border border-sky-300 px-3 py-1 text-xs font-medium text-sky-700" type="button" onClick={() => void saveAllStandardGridRows()}>
                      {savingAllStandardRows ? "Salvataggio..." : "Salva tutte le righe"}
                    </button>
                  </div>
                </div>
                <div className="mt-3 overflow-auto">
                  <table className="min-w-full text-sm">
                    <thead>
                      <tr className="border-b border-slate-200 text-left">
                        <th className="px-2 py-2">Voce</th>
                        <th className="px-2 py-2">Stato</th>
                        <th className="px-2 py-2">Costo</th>
                        <th className="px-2 py-2">Prezzo vendita</th>
                        <th className="px-2 py-2">Prezzo privati</th>
                        <th className="px-2 py-2">Linea bus</th>
                        <th className="px-2 py-2">Azione</th>
                      </tr>
                    </thead>
                    <tbody>
                      {standardGridRows.map((row) => {
                        const preset: RulePreset = {
                          label: row.label,
                          routeName: row.routeName,
                          service_type: row.serviceType,
                          bus_line_code: row.busLineCode
                        };
                        return (
                          <tr key={row.key} className="border-b border-slate-100">
                            <td className="px-2 py-2 font-medium">{row.label}</td>
                            <td className="px-2 py-2">
                              {row.existingRule ? (
                                <span className="rounded-full bg-emerald-100 px-2 py-1 text-xs font-semibold text-emerald-700">Configurata</span>
                              ) : row.routeReady ? (
                                <span className="rounded-full bg-amber-100 px-2 py-1 text-xs font-semibold text-amber-700">Da compilare</span>
                              ) : (
                                <span className="rounded-full bg-rose-100 px-2 py-1 text-xs font-semibold text-rose-700">Manca tratta</span>
                              )}
                            </td>
                            <td className="px-2 py-2">
                              <label className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-2 py-2">
                                <span className="text-xs text-slate-500">EUR</span>
                                <input
                                  value={standardRowDrafts[row.key]?.internalCost ?? centsToEuroInput(row.existingRule?.internal_cost_cents)}
                                  onChange={(event) =>
                                    setStandardRowDrafts((current) => ({
                                      ...current,
                                      [row.key]: { ...current[row.key], internalCost: event.target.value }
                                    }))
                                  }
                                  inputMode="decimal"
                                  placeholder="0,00"
                                  className="min-w-0 flex-1 bg-transparent outline-none"
                                />
                              </label>
                            </td>
                            <td className="px-2 py-2">
                              <label className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-2 py-2">
                                <span className="text-xs text-slate-500">EUR</span>
                                <input
                                  value={standardRowDrafts[row.key]?.agencyPrice ?? centsToEuroInput(row.existingRule?.agency_price_cents ?? null)}
                                  onChange={(event) =>
                                    setStandardRowDrafts((current) => ({
                                      ...current,
                                      [row.key]: { ...current[row.key], agencyPrice: event.target.value }
                                    }))
                                  }
                                  inputMode="decimal"
                                  placeholder="0,00"
                                  className="min-w-0 flex-1 bg-transparent outline-none"
                                />
                              </label>
                            </td>
                            <td className="px-2 py-2">
                              <label className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-2 py-2">
                                <span className="text-xs text-slate-500">EUR</span>
                                <input
                                  value={standardRowDrafts[row.key]?.publicPrice ?? centsToEuroInput(row.existingRule?.public_price_cents)}
                                  onChange={(event) =>
                                    setStandardRowDrafts((current) => ({
                                      ...current,
                                      [row.key]: { ...current[row.key], publicPrice: event.target.value }
                                    }))
                                  }
                                  inputMode="decimal"
                                  placeholder="0,00"
                                  className="min-w-0 flex-1 bg-transparent outline-none"
                                />
                              </label>
                            </td>
                            <td className="px-2 py-2">
                              {row.serviceType === "bus_tour" ? (
                                <input
                                  value={standardRowDrafts[row.key]?.busLineCode ?? row.existingRule?.bus_line_code ?? row.busLineCode}
                                  onChange={(event) =>
                                    setStandardRowDrafts((current) => ({
                                      ...current,
                                      [row.key]: { ...current[row.key], busLineCode: event.target.value }
                                    }))
                                  }
                                  placeholder="LINEA_"
                                  className="input-saas min-w-[140px]"
                                />
                              ) : (
                                <span className="text-slate-400">-</span>
                              )}
                            </td>
                            <td className="px-2 py-2">
                              <div className="flex flex-col gap-2">
                                <button className="text-xs underline" type="button" onClick={() => applyRulePreset(preset)}>
                                  {row.existingRule ? "Carica preset" : "Compila da preset"}
                                </button>
                                <button className="text-xs font-semibold text-sky-700 underline" type="button" onClick={() => void saveStandardGridRow(row)}>
                                  {row.existingRule ? "Salva aggiornamento" : "Salva riga"}
                                </button>
                                {row.existingRule ? (
                                  <button className="text-xs text-rose-700 underline" type="button" onClick={() => void deletePricingRuleRow(row.existingRule!.id)}>
                                    Elimina riga
                                  </button>
                                ) : null}
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : null}
            {ruleDraft.price_list_id ? (
              <div className="rounded-xl border border-slate-200 px-3 py-3 md:col-span-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Voci custom del listino</p>
                  <p className="text-xs text-slate-500">Qui aggiungi servizi extra oltre alle righe standard.</p>
                </div>
                <div className="mt-3 overflow-auto">
                  <table className="min-w-full text-sm">
                    <thead>
                      <tr className="border-b border-slate-200 text-left">
                        <th className="px-2 py-2">Servizio</th>
                        <th className="px-2 py-2">Tipo</th>
                        <th className="px-2 py-2">Costo</th>
                        <th className="px-2 py-2">Vendita</th>
                        <th className="px-2 py-2">Privati</th>
                        <th className="px-2 py-2">Linea bus</th>
                        <th className="px-2 py-2">Azioni</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr className="border-b border-slate-100">
                        <td className="px-2 py-2">
                          <select
                            className="input-saas"
                            value={customRuleDraft.route_id}
                            onChange={(event) => setCustomRuleDraft((current) => ({ ...current, route_id: event.target.value }))}
                          >
                            <option value="">Seleziona tratta/voce</option>
                            {routes.map((route) => (
                              <option key={route.id} value={route.id}>
                                {route.name}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td className="px-2 py-2">
                          <select
                            className="input-saas"
                            value={customRuleDraft.service_type}
                            onChange={(event) => setCustomRuleDraft((current) => ({ ...current, service_type: event.target.value as "transfer" | "bus_tour" }))}
                          >
                            <option value="transfer">transfer</option>
                            <option value="bus_tour">bus_tour</option>
                          </select>
                        </td>
                        <td className="px-2 py-2">
                          <label className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-2 py-2">
                            <span className="text-xs text-slate-500">EUR</span>
                            <input value={customRuleDraft.internalCost} onChange={(event) => setCustomRuleDraft((current) => ({ ...current, internalCost: event.target.value }))} inputMode="decimal" placeholder="0,00" className="min-w-0 flex-1 bg-transparent outline-none" />
                          </label>
                        </td>
                        <td className="px-2 py-2">
                          <label className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-2 py-2">
                            <span className="text-xs text-slate-500">EUR</span>
                            <input value={customRuleDraft.agencyPrice} onChange={(event) => setCustomRuleDraft((current) => ({ ...current, agencyPrice: event.target.value }))} inputMode="decimal" placeholder="0,00" className="min-w-0 flex-1 bg-transparent outline-none" />
                          </label>
                        </td>
                        <td className="px-2 py-2">
                          <label className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-2 py-2">
                            <span className="text-xs text-slate-500">EUR</span>
                            <input value={customRuleDraft.publicPrice} onChange={(event) => setCustomRuleDraft((current) => ({ ...current, publicPrice: event.target.value }))} inputMode="decimal" placeholder="0,00" className="min-w-0 flex-1 bg-transparent outline-none" />
                          </label>
                        </td>
                        <td className="px-2 py-2">
                          <input
                            className="input-saas min-w-[140px]"
                            value={customRuleDraft.bus_line_code}
                            onChange={(event) => setCustomRuleDraft((current) => ({ ...current, bus_line_code: event.target.value }))}
                            placeholder="LINEA_"
                          />
                        </td>
                        <td className="px-2 py-2">
                          <div className="flex items-center gap-2">
                            <button className="text-xs font-semibold text-sky-700 underline" type="button" onClick={() => void saveCustomRuleRow()}>
                              {editingCustomRuleId ? "Salva modifica" : "Aggiungi voce"}
                            </button>
                            {editingCustomRuleId ? (
                              <button className="text-xs text-slate-600 underline" type="button" onClick={cancelEditCustomRule}>
                                Annulla
                              </button>
                            ) : null}
                          </div>
                        </td>
                      </tr>
                      {customListRules.map((rule) => (
                        <tr key={rule.id} className="border-b border-slate-100">
                          <td className="px-2 py-2">{routes.find((route) => route.id === rule.route_id)?.name ?? rule.route_id.slice(0, 8)}</td>
                          <td className="px-2 py-2">{rule.service_type ?? "-"}</td>
                          <td className="px-2 py-2">{eur(rule.internal_cost_cents)}</td>
                          <td className="px-2 py-2">{rule.agency_price_cents !== null ? eur(rule.agency_price_cents) : "-"}</td>
                          <td className="px-2 py-2">{eur(rule.public_price_cents)}</td>
                          <td className="px-2 py-2">{rule.bus_line_code ?? "-"}</td>
                          <td className="px-2 py-2">
                            <div className="flex items-center gap-2">
                              <button className="text-xs text-sky-700 underline" type="button" onClick={() => startEditCustomRule(rule)}>
                                Modifica
                              </button>
                              <button className="text-xs text-rose-700 underline" type="button" onClick={() => void deletePricingRuleRow(rule.id)}>
                                Elimina riga
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : null}
            {ruleDraft.price_list_id ? (
              <div className="rounded-xl border border-slate-200 px-3 py-3 md:col-span-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Prezzi linee bus</p>
                    <p className="text-xs text-slate-500">Le linee arrivano già col loro nome. Tu inserisci solo costo e prezzo.</p>
                  </div>
                  <div className="flex items-center gap-3">
                    <p className="text-xs text-slate-500">{BUS_LINES_2026.length} linee tariffarie</p>
                    <button className="rounded-lg border border-sky-300 px-3 py-1 text-xs font-medium text-sky-700" type="button" onClick={() => void saveAllBusLineRules()}>
                      {savingAllBusLines ? "Salvataggio..." : "Salva tutte le linee"}
                    </button>
                  </div>
                </div>
                <div className="mt-3 overflow-auto">
                  <table className="min-w-full text-sm">
                    <thead>
                      <tr className="border-b border-slate-200 text-left">
                        <th className="px-2 py-2">Linea</th>
                        <th className="px-2 py-2">Stato</th>
                        <th className="px-2 py-2">Costo</th>
                        <th className="px-2 py-2">Prezzo vendita</th>
                        <th className="px-2 py-2">Prezzo privati</th>
                        <th className="px-2 py-2">Azione</th>
                      </tr>
                    </thead>
                    <tbody>
                      {BUS_LINES_2026.map((line) => {
                        const existingRule = busLineListRules.find((rule) => rule.bus_line_code === line.code);
                        return (
                          <tr key={line.code} className="border-b border-slate-100">
                            <td className="px-2 py-2">
                              <div className="font-medium">{line.name}</div>
                              <div className="text-xs text-slate-500">{line.code}</div>
                            </td>
                            <td className="px-2 py-2">
                              {existingRule ? (
                                <span className="rounded-full bg-emerald-100 px-2 py-1 text-xs font-semibold text-emerald-700">Configurata</span>
                              ) : (
                                <span className="rounded-full bg-amber-100 px-2 py-1 text-xs font-semibold text-amber-700">Da compilare</span>
                              )}
                            </td>
                            <td className="px-2 py-2">
                              <label className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-2 py-2">
                                <span className="text-xs text-slate-500">EUR</span>
                                <input
                                  value={busLineRowDrafts[line.code]?.internalCost ?? centsToEuroInput(existingRule?.internal_cost_cents)}
                                  onChange={(event) =>
                                    setBusLineRowDrafts((current) => ({
                                      ...current,
                                      [line.code]: { ...current[line.code], internalCost: event.target.value }
                                    }))
                                  }
                                  inputMode="decimal"
                                  placeholder="0,00"
                                  className="min-w-0 flex-1 bg-transparent outline-none"
                                />
                              </label>
                            </td>
                            <td className="px-2 py-2">
                              <label className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-2 py-2">
                                <span className="text-xs text-slate-500">EUR</span>
                                <input
                                  value={busLineRowDrafts[line.code]?.agencyPrice ?? centsToEuroInput(existingRule?.agency_price_cents ?? null)}
                                  onChange={(event) =>
                                    setBusLineRowDrafts((current) => ({
                                      ...current,
                                      [line.code]: { ...current[line.code], agencyPrice: event.target.value }
                                    }))
                                  }
                                  inputMode="decimal"
                                  placeholder="0,00"
                                  className="min-w-0 flex-1 bg-transparent outline-none"
                                />
                              </label>
                            </td>
                            <td className="px-2 py-2">
                              <label className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-2 py-2">
                                <span className="text-xs text-slate-500">EUR</span>
                                <input
                                  value={busLineRowDrafts[line.code]?.publicPrice ?? centsToEuroInput(existingRule?.public_price_cents)}
                                  onChange={(event) =>
                                    setBusLineRowDrafts((current) => ({
                                      ...current,
                                      [line.code]: { ...current[line.code], publicPrice: event.target.value }
                                    }))
                                  }
                                  inputMode="decimal"
                                  placeholder="0,00"
                                  className="min-w-0 flex-1 bg-transparent outline-none"
                                />
                              </label>
                            </td>
                            <td className="px-2 py-2">
                              <div className="flex flex-col gap-2">
                                <button className="text-xs font-semibold text-sky-700 underline" type="button" onClick={() => void saveBusLineRule(line)}>
                                  {existingRule ? "Salva aggiornamento" : "Salva riga"}
                                </button>
                                {existingRule ? (
                                  <button className="text-xs text-rose-700 underline" type="button" onClick={() => void deletePricingRuleRow(existingRule.id)}>
                                    Elimina riga
                                  </button>
                                ) : null}
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : null}
            <div className="rounded-xl border border-slate-200 px-3 py-3 md:col-span-4">
              <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Preset rapidi regola</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {RULE_PRESETS.map((preset) => (
                  <button
                    key={preset.label}
                    type="button"
                    className="rounded-full border border-slate-300 px-3 py-1 text-xs text-slate-700 hover:border-slate-400"
                    onClick={() => applyRulePreset(preset)}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
              <p className="mt-2 text-xs text-slate-500">Usa questi pulsanti per precompilare SNAV, MEDMAR, transfer standard e linee bus.</p>
            </div>
            <select name="price_list_id" className="input-saas" value={ruleDraft.price_list_id} onChange={(event) => setRuleDraft((current) => ({ ...current, price_list_id: event.target.value }))}>
              {priceLists.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
            <select name="route_id" className="input-saas" value={ruleDraft.route_id} onChange={(event) => setRuleDraft((current) => ({ ...current, route_id: event.target.value }))}>
              {routes.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
            <select name="agency_id" className="input-saas" value={ruleDraft.agency_id} onChange={(event) => setRuleDraft((current) => ({ ...current, agency_id: event.target.value }))}>
              <option value="">(tutte le agenzie)</option>
              {agencies.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
            <input name="bus_line_code" list="bus-line-code-presets" placeholder="Codice linea bus (opz)" className="input-saas" value={ruleDraft.bus_line_code} onChange={(event) => setRuleDraft((current) => ({ ...current, bus_line_code: event.target.value }))} />
            <datalist id="bus-line-code-presets">
              {BUS_LINES_2026.map((line) => (
                <option key={line.code} value={line.code} />
              ))}
            </datalist>
            <select name="rule_kind" defaultValue="fixed" className="input-saas">
              <option value="fixed">Prezzo fisso</option>
              <option value="per_pax">Prezzo per pax</option>
            </select>
            <select name="service_type" className="input-saas" value={ruleDraft.service_type} onChange={(event) => setRuleDraft((current) => ({ ...current, service_type: event.target.value }))}>
              <option value="">Tipo servizio: tutti</option>
              <option value="transfer">transfer</option>
              <option value="bus_tour">bus_tour</option>
            </select>
            <select name="direction" className="input-saas">
              <option value="">Direzione: tutte</option>
              <option value="arrival">arrivo</option>
              <option value="departure">partenza</option>
            </select>
            <input name="vehicle_type" placeholder="Veicolo (es. VAN/CAR/BUS)" className="input-saas" />
            <input name="priority" type="number" min={1} max={999} defaultValue={100} className="input-saas" />
            <input name="pax_min" type="number" min={1} defaultValue={1} className="input-saas" />
            <input name="pax_max" type="number" min={1} placeholder="Pax max (opz)" className="input-saas" />
            <input name="time_from" type="time" className="input-saas" />
            <input name="time_to" type="time" className="input-saas" />
            <input name="season_from" type="date" className="input-saas" />
            <input name="season_to" type="date" className="input-saas" />
            <label className="flex items-center gap-2 rounded-2xl border border-slate-200 bg-white px-3 py-2">
              <span className="text-sm font-medium text-slate-500">EUR</span>
              <input name="internal_cost_cents" inputMode="decimal" placeholder="Costo effettivo servizio" className="min-w-0 flex-1 bg-transparent outline-none" />
            </label>
            <label className="flex items-center gap-2 rounded-2xl border border-slate-200 bg-white px-3 py-2">
              <span className="text-sm font-medium text-slate-500">EUR</span>
              <input name="public_price_cents" inputMode="decimal" placeholder="Prezzo privati" className="min-w-0 flex-1 bg-transparent outline-none" />
            </label>
            <label className="flex items-center gap-2 rounded-2xl border border-slate-200 bg-white px-3 py-2 md:col-span-2">
              <span className="text-sm font-medium text-slate-500">EUR</span>
              <input name="agency_price_cents" inputMode="decimal" placeholder="Prezzo agenzia (opz)" className="min-w-0 flex-1 bg-transparent outline-none" />
            </label>
            <label className="inline-flex items-center gap-2 input-saas md:col-span-2">
              <input type="checkbox" name="needs_manual_review" /> Richiede revisione manuale operatore
            </label>
            <button className="btn-primary px-4 py-2 text-sm md:col-span-4">Crea Regola</button>
          </form>

          <div className="card p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-base font-semibold">Regole attive ({rules.length})</h2>
                <p className="text-xs text-slate-500">Riepilogo tecnico per controlli rapidi, debug e pulizia dei duplicati.</p>
              </div>
              <button
                type="button"
                className="text-xs underline"
                onClick={() => setActiveRulesExpanded((value) => !value)}
              >
                {activeRulesExpanded ? "Nascondi riepilogo" : "Mostra riepilogo"}
              </button>
            </div>
            {activeRulesExpanded ? (
              <div className="mt-3 overflow-auto">
                <table className="min-w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 text-left">
                      <th className="px-2 py-2">Priorita</th>
                      <th className="px-2 py-2">Tratta</th>
                      <th className="px-2 py-2">Linea bus</th>
                      <th className="px-2 py-2">Pax</th>
                      <th className="px-2 py-2">Veicolo/Fascia/Stagione</th>
                      <th className="px-2 py-2">Prezzi</th>
                      <th className="px-2 py-2">Azioni</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rules.map((rule) => (
                      <tr key={rule.id} className="border-b border-slate-100">
                        <td className="px-2 py-2">{rule.priority}</td>
                        <td className="px-2 py-2">{routes.find((route) => route.id === rule.route_id)?.name ?? rule.route_id.slice(0, 8)}</td>
                        <td className="px-2 py-2">{rule.bus_line_code ?? "-"}</td>
                        <td className="px-2 py-2">
                          {rule.pax_min} - {rule.pax_max ?? "*"}
                        </td>
                        <td className="px-2 py-2">
                          {rule.vehicle_type ?? "*"} | {rule.time_from ?? "00:00"} - {rule.time_to ?? "23:59"} | {rule.season_from ?? "-"} {rule.season_to ? `-> ${rule.season_to}` : ""}
                        </td>
                        <td className="px-2 py-2">
                          <div className="space-y-1">
                            <p>
                              <span className="font-medium">Costo:</span> {eur(rule.internal_cost_cents)}
                            </p>
                            <p>
                              <span className="font-medium">Privati:</span> {eur(rule.public_price_cents)}
                            </p>
                            <p>
                              <span className="font-medium">Agenzia:</span> {rule.agency_price_cents !== null ? eur(rule.agency_price_cents) : "-"}
                            </p>
                          </div>
                        </td>
                        <td className="px-2 py-2">
                          <div className="flex gap-2">
                            <button className="text-xs underline" type="button" onClick={() => void toggle("pricing_rules", rule.id, rule.active)}>
                              {rule.active ? "Disattiva" : "Attiva"}
                            </button>
                            <button className="text-xs text-rose-700 underline" type="button" onClick={() => void delRule(rule.id)}>
                              Elimina
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="mt-3 text-sm text-slate-500">Chiuso di default per lasciare più spazio al lavoro sul listino.</p>
            )}
          </div>
        </div>
      ) : null}

      {section === "agenzie" ? (
        <div className="space-y-4">
          <div className="grid gap-4 lg:grid-cols-2">
            <div className="card p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h2 className="text-base font-semibold">Nuova Agenzia</h2>
                <button
                  type="button"
                  className="text-xs underline"
                  onClick={() => setCreateAgencyExpanded((value) => !value)}
                >
                  {createAgencyExpanded ? "Riduci" : "Espandi"}
                </button>
              </div>

              {createAgencyExpanded ? (
                <form onSubmit={submitAgencyCreate} className="mt-3 space-y-3">
                  <div className="grid gap-2 md:grid-cols-2">
                    <input name="name" placeholder="Nome breve agenzia" className="input-saas" />
                    <input name="legal_name" placeholder="Ragione sociale" className="input-saas" />
                    <input name="billing_name" placeholder="Intestazione fatturazione" className="input-saas" />
                    <input name="vat_number" placeholder="P. IVA" className="input-saas" />
                    <input name="pec_email" placeholder="PEC" className="input-saas" />
                    <input name="sdi_code" placeholder="Codice SDI" className="input-saas" />
                    <input name="phone" placeholder="Telefono" className="input-saas" />
                    <input name="contact_email" placeholder="Email contatto principale" className="input-saas" />
                    <input name="booking_email" placeholder="Email booking principale" className="input-saas" />
                    <input name="contact_emails_csv" placeholder="Email contatto aggiuntive separate da virgola" className="input-saas md:col-span-2" />
                    <input name="booking_emails_csv" placeholder="Email booking aggiuntive separate da virgola" className="input-saas md:col-span-2" />
                    <input name="parser_key_hint" placeholder="Parser hint (es. agency_aleste_viaggi)" className="input-saas md:col-span-2" />
                    <input name="sender_domains_csv" placeholder="Domini mittente separati da virgola" className="input-saas md:col-span-2" />
                    <input name="default_enabled_booking_kinds_csv" placeholder="Servizi default (es. transfer_train_hotel,bus_city_hotel)" className="input-saas md:col-span-2" />
                    <input name="default_pricing_notes" placeholder="Note listino default" className="input-saas md:col-span-2" />
                    <textarea name="notes" placeholder="Note operative interne" rows={3} className="input-saas md:col-span-2" />
                  </div>
                  <button type="submit" className="btn-primary px-4 py-2 text-sm" disabled={creatingAgency}>
                    {creatingAgency ? "Creazione..." : "Crea Agenzia"}
                  </button>
                </form>
              ) : null}
            </div>

            <form action={createAlias} className="card space-y-2 p-4">
              <h2 className="text-base font-semibold">Nuovo Alias Agenzia</h2>
              <select name="agency_id" className="w-full input-saas">
                {agencies.map((agency) => (
                  <option key={agency.id} value={agency.id}>
                    {agency.name}
                  </option>
                ))}
              </select>
              <input name="alias" placeholder="Alias (come appare in email/PDF)" className="w-full input-saas" />
              <button className="btn-primary px-4 py-2 text-sm">Crea Alias</button>
            </form>
          </div>

          <div className="card space-y-2 p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-base font-semibold">Elenco Agenzie</h2>
              <p className="text-xs text-slate-500">
                {filteredAgencies.length} / {agencies.length}
              </p>
            </div>
            <input
              value={agencySearch}
              onChange={(event) => setAgencySearch(event.target.value)}
              placeholder="Cerca per nome, ragione sociale, P. IVA o email"
              className="input-saas"
            />
          </div>

          <div className="space-y-3">
            {filteredAgencies.map((item) => {
              const isExpanded = expandedAgencyId === item.id;
              const isEditing = editingAgencyId === item.id;
              const d = defaultsFromAgency(item);
              return (
                <article key={item.id} className="card overflow-hidden text-sm">
                  <button
                    type="button"
                    className="flex w-full items-center justify-between gap-3 p-4 text-left"
                    onClick={() => {
                      setExpandedAgencyId(isExpanded ? null : item.id);
                      if (isExpanded) setEditingAgencyId(null);
                    }}
                  >
                    <div>
                      <h3 className="text-base font-semibold">{item.name}</h3>
                      <p className="text-xs text-slate-500">{item.active ? "Attiva" : "Disattivata"}</p>
                    </div>
                    <span className="text-xs text-slate-500">{isExpanded ? "Chiudi" : "Apri dettagli"}</span>
                  </button>

                  {isExpanded ? (
                    <div className="space-y-3 border-t border-slate-200 p-4">
                      <div className="flex flex-wrap gap-3">
                        <button className="text-xs underline" type="button" onClick={() => startAgencyPriceList(item)}>
                          Nuovo listino per questa agenzia
                        </button>
                        <button className="text-xs underline" type="button" onClick={() => setEditingAgencyId(isEditing ? null : item.id)}>
                          {isEditing ? "Chiudi modifica" : "Modifica"}
                        </button>
                        <button className="text-xs underline" onClick={() => void toggle("agencies", item.id, item.active)} type="button">
                          {item.active ? "Disattiva" : "Attiva"}
                        </button>
                        <button
                          className="text-xs text-rose-700 underline"
                          type="button"
                          disabled={deletingAgencyId === item.id}
                          onClick={() => void deleteAgency(item.id)}
                        >
                          {deletingAgencyId === item.id ? "Eliminazione..." : "Elimina"}
                        </button>
                      </div>

                      <div className="grid gap-2 text-slate-700 md:grid-cols-2 xl:grid-cols-3">
                        <p><span className="font-medium">Ragione sociale:</span> {item.legal_name ?? "N/D"}</p>
                        <p><span className="font-medium">Fatturazione:</span> {item.billing_name ?? "N/D"}</p>
                        <p><span className="font-medium">P. IVA:</span> {item.vat_number ?? "N/D"}</p>
                        <p><span className="font-medium">PEC:</span> {item.pec_email ?? "N/D"}</p>
                        <p><span className="font-medium">Codice SDI:</span> {item.sdi_code ?? "N/D"}</p>
                        <p><span className="font-medium">Telefono:</span> {item.phone ?? "N/D"}</p>
                        <p><span className="font-medium">Email contatto principale:</span> {item.contact_email ?? "N/D"}</p>
                        <p><span className="font-medium">Email booking principale:</span> {item.booking_email ?? "N/D"}</p>
                        <p><span className="font-medium">Parser hint:</span> {item.parser_key_hint ?? "N/D"}</p>
                        <p className="md:col-span-2 xl:col-span-3"><span className="font-medium">Email contatto aggiuntive:</span> {item.contact_emails.length > 0 ? item.contact_emails.join(", ") : "N/D"}</p>
                        <p className="md:col-span-2 xl:col-span-3"><span className="font-medium">Email booking aggiuntive:</span> {item.booking_emails.length > 0 ? item.booking_emails.join(", ") : "N/D"}</p>
                        <p className="md:col-span-2 xl:col-span-3"><span className="font-medium">Domini mittente:</span> {(item.sender_domains ?? []).length > 0 ? (item.sender_domains ?? []).join(", ") : "N/D"}</p>
                        <p className="md:col-span-2 xl:col-span-3"><span className="font-medium">Servizi default:</span> {(item.default_enabled_booking_kinds ?? []).length > 0 ? (item.default_enabled_booking_kinds ?? []).join(", ") : "N/D"}</p>
                        <p className="md:col-span-2 xl:col-span-3"><span className="font-medium">Note listino default:</span> {item.default_pricing_notes ?? "N/D"}</p>
                        <p className="md:col-span-2 xl:col-span-3"><span className="font-medium">Note operative:</span> {item.notes ?? "N/D"}</p>
                      </div>

                      <div className="rounded-xl border border-slate-200 p-3">
                        <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Listini collegati</p>
                        <div className="mt-2 space-y-2 text-sm">
                          {priceLists.filter((priceList) => priceList.agency_id === item.id).length > 0 ? (
                            priceLists
                              .filter((priceList) => priceList.agency_id === item.id)
                              .map((priceList) => (
                                <div key={priceList.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 px-3 py-2">
                                  <p>
                                    <span className="font-medium">{priceList.name}</span> | {priceList.valid_from}
                                    {priceList.valid_to ? ` -> ${priceList.valid_to}` : " -> aperto"}
                                    {priceList.is_default ? " | Default" : ""}
                                  </p>
                                  <span className="text-xs text-slate-500">{priceList.active ? "Attivo" : "Disattivo"}</span>
                                </div>
                              ))
                          ) : (
                            <p className="text-slate-500">Nessun listino collegato a questa agenzia.</p>
                          )}
                        </div>
                      </div>

                      {isEditing ? (
                        <form onSubmit={submitAgencyUpdate(item.id)} className="grid gap-2 border-t border-slate-200 pt-3 md:grid-cols-2">
                          <input name="name" defaultValue={d.name} placeholder="Nome breve agenzia" className="input-saas" />
                          <input name="legal_name" defaultValue={d.legal_name} placeholder="Ragione sociale" className="input-saas" />
                          <input name="billing_name" defaultValue={d.billing_name} placeholder="Intestazione fatturazione" className="input-saas" />
                          <input name="vat_number" defaultValue={d.vat_number} placeholder="P. IVA" className="input-saas" />
                          <input name="pec_email" defaultValue={d.pec_email} placeholder="PEC" className="input-saas" />
                          <input name="sdi_code" defaultValue={d.sdi_code} placeholder="Codice SDI" className="input-saas" />
                          <input name="phone" defaultValue={d.phone} placeholder="Telefono" className="input-saas" />
                          <input name="contact_email" defaultValue={d.contact_email} placeholder="Email contatto principale" className="input-saas" />
                          <input name="booking_email" defaultValue={d.booking_email} placeholder="Email booking principale" className="input-saas" />
                          <input name="contact_emails_csv" defaultValue={d.contact_emails_csv} placeholder="Email contatto aggiuntive separate da virgola" className="input-saas md:col-span-2" />
                          <input name="booking_emails_csv" defaultValue={d.booking_emails_csv} placeholder="Email booking aggiuntive separate da virgola" className="input-saas md:col-span-2" />
                          <input name="parser_key_hint" defaultValue={d.parser_key_hint} placeholder="Parser hint" className="input-saas md:col-span-2" />
                          <input name="sender_domains_csv" defaultValue={d.sender_domains_csv} placeholder="Domini mittente separati da virgola" className="input-saas md:col-span-2" />
                          <input name="default_enabled_booking_kinds_csv" defaultValue={d.default_enabled_booking_kinds_csv} placeholder="Servizi default separati da virgola" className="input-saas md:col-span-2" />
                          <input name="default_pricing_notes" defaultValue={d.default_pricing_notes} placeholder="Note listino default" className="input-saas md:col-span-2" />
                          <textarea name="notes" defaultValue={d.notes} placeholder="Note operative interne" rows={3} className="input-saas md:col-span-2" />
                          <div className="flex gap-2 md:col-span-2">
                            <button type="submit" className="btn-primary px-4 py-2 text-sm" disabled={savingAgencyId === item.id}>
                              {savingAgencyId === item.id ? "Salvataggio..." : "Salva modifiche"}
                            </button>
                            <button type="button" className="btn-secondary px-4 py-2 text-sm" onClick={() => setEditingAgencyId(null)}>
                              Annulla
                            </button>
                          </div>
                        </form>
                      ) : null}
                    </div>
                  ) : null}
                </article>
              );
            })}
            {filteredAgencies.length === 0 ? <div className="card p-4 text-sm text-slate-500">Nessuna agenzia trovata con questo filtro.</div> : null}
          </div>
        </div>
      ) : null}

      {section === "match" ? <div className="card space-y-3 p-4"><div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-base font-semibold">Match prenotazioni ({matches.length})</h2><div className="flex gap-2"><button type="button" className="btn-secondary px-3 py-1.5 text-xs" onClick={() => void matchAction("approve")} disabled={sel.length === 0}>Approva</button><button type="button" className="btn-secondary px-3 py-1.5 text-xs" onClick={() => void matchAction("reject")} disabled={sel.length === 0}>Rifiuta</button><button type="button" className="btn-primary px-3 py-1.5 text-xs" onClick={() => void matchAction("reapply")} disabled={sel.length === 0}>Rielabora</button></div></div><div className="overflow-auto"><table className="min-w-full text-sm"><thead><tr className="border-b border-slate-200 text-left"><th className="px-2 py-2"></th><th className="px-2 py-2">Data</th><th className="px-2 py-2">Agenzia / Tratta</th><th className="px-2 py-2">Pax</th><th className="px-2 py-2">Confidenza</th><th className="px-2 py-2">Qualita</th><th className="px-2 py-2">Motivi</th><th className="px-2 py-2">Note</th></tr></thead><tbody>{matches.map((item) => {const badges = detectMatchBadges(item.match_notes || "");return <tr key={item.id} className="border-b border-slate-100"><td className="px-2 py-2"><input type="checkbox" checked={sel.includes(item.id)} onChange={(e) => setSel((prev) => e.target.checked ? [...prev, item.id] : prev.filter((id) => id !== item.id))} /></td><td className="px-2 py-2">{new Date(item.created_at).toLocaleString("it-IT")}</td><td className="px-2 py-2">{item.normalized_agency_name ?? "N/D"} / {item.normalized_route_name ?? "N/D"}</td><td className="px-2 py-2">{item.pax ?? "N/D"}</td><td className="px-2 py-2">{item.match_confidence ?? "-"}</td><td className="px-2 py-2"><span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ${qClass(item.match_quality)}`}>{item.match_quality ?? "review"}</span></td><td className="px-2 py-2"><div className="flex flex-wrap gap-1">{badges.length > 0 ? badges.map((badge) => <span key={`${item.id}-${badge.label}`} className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold ${badge.className}`}>{badge.label}</span>) : <span className="text-slate-400">-</span>}</div></td><td className="px-2 py-2">{item.match_notes || "-"}</td></tr>;})}{matches.length === 0 ? <tr><td colSpan={8} className="px-2 py-3 text-slate-500">Nessun record match.</td></tr> : null}</tbody></table></div></div> : null}

      {section === "storico" ? <div className="space-y-4"><div className="card flex flex-wrap items-end gap-2 p-4 text-sm"><label>Periodo<select value={days} onChange={(e) => {const v = Number(e.target.value);setDays(v);void loadHistory(v, agencyFilter, routeFilter);}} className="ml-2 rounded-lg border border-slate-300 px-2 py-1"><option value={7}>7 giorni</option><option value={30}>30 giorni</option><option value={90}>90 giorni</option><option value={180}>180 giorni</option></select></label><label>Agenzia<select value={agencyFilter} onChange={(e) => {const v = e.target.value;setAgencyFilter(v);void loadHistory(days, v, routeFilter);}} className="ml-2 rounded-lg border border-slate-300 px-2 py-1"><option value="">Tutte</option>{agencies.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label><label>Tratta<select value={routeFilter} onChange={(e) => {const v = e.target.value;setRouteFilter(v);void loadHistory(days, agencyFilter, v);}} className="ml-2 rounded-lg border border-slate-300 px-2 py-1"><option value="">Tutte</option>{routes.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></label><button type="button" className="btn-secondary px-3 py-1.5 text-xs" onClick={() => void loadHistory()}>Aggiorna</button></div><div className="grid gap-3 md:grid-cols-4"><article className="card p-4"><p className="text-xs text-slate-500">Servizi prezzati</p><p className="text-2xl font-semibold">{kpi.total}</p></article><article className="card p-4"><p className="text-xs text-slate-500">Ricavi</p><p className="text-2xl font-semibold">{kpi.revenue}</p></article><article className="card p-4"><p className="text-xs text-slate-500">Costi</p><p className="text-2xl font-semibold">{kpi.cost}</p></article><article className="card p-4"><p className="text-xs text-slate-500">Margine</p><p className="text-2xl font-semibold">{kpi.margin}</p></article></div><div className="card p-4"><h2 className="mb-2 text-base font-semibold">Storico margini ({history.length})</h2><div className="overflow-auto"><table className="min-w-full text-sm"><thead><tr className="border-b border-slate-200 text-left"><th className="px-2 py-2">Data</th><th className="px-2 py-2">Servizio</th><th className="px-2 py-2">Agenzia/Tratta</th><th className="px-2 py-2">Costo</th><th className="px-2 py-2">Prezzo finale</th><th className="px-2 py-2">Margine</th><th className="px-2 py-2">Modo</th></tr></thead><tbody>{history.map((row) => <tr key={row.id} className="border-b border-slate-100"><td className="px-2 py-2">{new Date(row.created_at).toLocaleString("it-IT")}</td><td className="px-2 py-2">{row.service_id.slice(0, 8)}...</td><td className="px-2 py-2">{row.agency_label} / {row.route_label}</td><td className="px-2 py-2">{eur(row.internal_cost_cents)}</td><td className="px-2 py-2">{eur(row.final_price_cents)}</td><td className="px-2 py-2">{eur(row.margin_cents)}</td><td className="px-2 py-2">{row.apply_mode}{row.manual_override ? " (override)" : ""}</td></tr>)}{history.length === 0 ? <tr><td colSpan={7} className="px-2 py-3 text-slate-500">Nessun dato storico.</td></tr> : null}</tbody></table></div></div></div> : null}
    </section>
  );
}
