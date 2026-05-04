"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase/client";

type ThreadRow = {
  id: string;
  wa_id: string;
  phone_e164: string | null;
  booking_id: string | null;
  transfer_id: string | null;
  last_message_at: string | null;
  last_message_preview: string | null;
  unread_count: number;
  status: "open" | "needs_review" | "closed";
  match_status: "matched" | "unmatched" | "ambiguous" | "needs_review";
  match_suggestions: Array<Record<string, unknown>>;
  whatsapp_contacts?: { profile_name?: string | null } | null;
  service?: {
    id: string;
    customer_name?: string | null;
    phone?: string | null;
    phone_e164?: string | null;
    date?: string | null;
    time?: string | null;
    booking_service_kind?: string | null;
    hotels?: { name?: string | null } | null;
  } | null;
};

type MessageRow = {
  id: string;
  wa_message_id: string | null;
  direction: "inbound" | "outbound";
  message_type: string | null;
  text_body: string | null;
  media_id: string | null;
  media_mime_type: string | null;
  status: string | null;
  failure_reason?: string | null;
  timestamp: string | null;
  created_at: string;
  booking_id: string | null;
};

type InboxPayload = {
  ok?: boolean;
  threads?: ThreadRow[];
  selected_thread_id?: string | null;
  messages?: MessageRow[];
  template_options?: TemplateOption[];
  template_fetch_error?: string | null;
  error?: string;
};

type TemplateOption = {
  key: string;
  label: string;
  template: string;
  language_code: string;
  status: string;
  category: string | null;
  body_parameter_count: number;
  body_text?: string | null;
  header_format?: string | null;
  is_tenant_default?: boolean;
  is_tenant_arrival?: boolean;
};

const filters = [
  { value: "open", label: "Aperte" },
  { value: "needs_review", label: "Da rivedere" },
  { value: "associated", label: "Associate" },
  { value: "unassociated", label: "Non associate" },
  { value: "closed", label: "Chiuse" },
] as const;

const quickEmojis = ["👍", "🙏", "😊", "🎉", "🚐", "📍", "⏰", "☎️"] as const;
const quickReplies = [
  "Arriviamo tra 5 minuti.",
  "Siamo al punto d'incontro indicato.",
  "Puoi inviarci la tua posizione?",
  "Ci chiami a questo numero, grazie.",
  "Perfetto, ti aspettiamo.",
] as const;

const CUSTOMER_CARE_WINDOW_MS = 24 * 60 * 60 * 1000;

// ─── Visual helpers ────────────────────────────────────────────────────────

function formatDate(value: string | null) {
  if (!value) return "";
  return new Intl.DateTimeFormat("it-IT", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatThreadDate(value: string | null) {
  if (!value) return "";
  const d = new Date(value);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  if (isToday) return d.toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" });
  return d.toLocaleDateString("it-IT", { day: "2-digit", month: "short" });
}

function messageStatusTone(status: string | null) {
  if (status === "read") return "bg-emerald-100 text-emerald-700";
  if (status === "delivered") return "bg-sky-100 text-sky-700";
  if (status === "sent") return "bg-slate-200 text-slate-700";
  if (status === "failed") return "bg-rose-100 text-rose-700";
  return "bg-slate-100 text-slate-500";
}

function messageStatusLabel(status: string | null) {
  if (status === "read") return "Letto";
  if (status === "delivered") return "Consegnato";
  if (status === "sent") return "Inviato";
  if (status === "failed") return "Fallito";
  if (status === "received") return "Ricevuto";
  return "In coda";
}

function templateLanguageLabel(code: string) {
  if (code === "it") return "Italiano";
  if (code === "en") return "English";
  if (code === "en_US") return "English (US)";
  return code;
}

function templateFriendlyLabel(templateName: string) {
  if (templateName.includes("aeroporto")) return "Aeroporto";
  if (templateName.includes("stazione")) return "Stazione";
  if (templateName.includes("medmar")) return "Medmar";
  if (templateName.includes("snav")) return "SNAV";
  return templateName.replace(/^its_/, "").replace(/_/g, " ");
}

function templateTone(templateName: string) {
  if (templateName.includes("aeroporto")) return "from-sky-500/20 via-cyan-500/10 to-white";
  if (templateName.includes("stazione")) return "from-amber-500/20 via-orange-500/10 to-white";
  if (templateName.includes("medmar")) return "from-indigo-500/20 via-blue-500/10 to-white";
  if (templateName.includes("snav")) return "from-emerald-500/20 via-teal-500/10 to-white";
  return "from-slate-400/20 via-slate-200/10 to-white";
}

function avatarColors(name: string): { bg: string; text: string } {
  const palette = [
    { bg: "bg-violet-100", text: "text-violet-700" },
    { bg: "bg-indigo-100", text: "text-indigo-700" },
    { bg: "bg-sky-100", text: "text-sky-700" },
    { bg: "bg-emerald-100", text: "text-emerald-700" },
    { bg: "bg-amber-100", text: "text-amber-700" },
    { bg: "bg-rose-100", text: "text-rose-700" },
    { bg: "bg-teal-100", text: "text-teal-700" },
    { bg: "bg-pink-100", text: "text-pink-700" },
  ];
  const hash = [...name].reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
  return palette[hash % palette.length]!;
}

function nameInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return (parts[0]![0] ?? "?").toUpperCase();
  return ((parts[0]![0] ?? "") + (parts[parts.length - 1]![0] ?? "")).toUpperCase();
}

function matchStatusBadge(status: ThreadRow["match_status"]): { bg: string; text: string; label: string } {
  switch (status) {
    case "matched":      return { bg: "bg-emerald-100", text: "text-emerald-700", label: "Associata" };
    case "unmatched":    return { bg: "bg-slate-100",   text: "text-slate-500",   label: "Non associata" };
    case "ambiguous":    return { bg: "bg-amber-100",   text: "text-amber-700",   label: "Ambigua" };
    case "needs_review": return { bg: "bg-orange-100",  text: "text-orange-700",  label: "Da verificare" };
  }
}

function threadStatusDot(thread: ThreadRow): string {
  if (thread.status === "closed") return "bg-slate-300";
  if (thread.status === "needs_review" || thread.match_status === "needs_review" || thread.match_status === "ambiguous") return "bg-amber-400";
  if (thread.match_status === "unmatched") return "bg-rose-400";
  if (thread.unread_count > 0) return "bg-emerald-400";
  return "bg-emerald-300";
}

// ─── Template data helpers ─────────────────────────────────────────────────

function buildSuggestedTemplateVariables(thread: ThreadRow | null, template: TemplateOption | null) {
  if (!thread || !template) return [];
  const customer = thread.service?.customer_name ?? thread.whatsapp_contacts?.profile_name ?? thread.phone_e164 ?? thread.wa_id;
  const date = thread.service?.date ?? "";
  const time = String(thread.service?.time ?? "").slice(0, 5);
  const hotel = thread.service?.hotels?.name ?? "";
  const vessel = thread.service?.booking_service_kind ?? "";
  const base = [customer, date, time, hotel, vessel].filter(Boolean);
  const count = template.body_parameter_count > 0 ? template.body_parameter_count : base.length;
  return base.slice(0, count);
}

async function getAccessToken() {
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

// ─── Icons ─────────────────────────────────────────────────────────────────

function IconSearch() {
  return (
    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="m21 21-4.35-4.35M16.5 10.5a6 6 0 1 1-12 0 6 6 0 0 1 12 0Z" />
    </svg>
  );
}

function IconPlus() {
  return (
    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
    </svg>
  );
}

function IconChevronLeft() {
  return (
    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" />
    </svg>
  );
}

function IconChat() {
  return (
    <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M8.625 12a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0H8.25m4.125 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0H12m4.125 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 0 1-2.555-.337A5.972 5.972 0 0 1 5.41 20.97a5.969 5.969 0 0 1-.474-.065 4.48 4.48 0 0 0 .978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25Z" />
    </svg>
  );
}

function IconInfo() {
  return (
    <svg className="h-4 w-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="m11.25 11.25.041-.02a.75.75 0 0 1 1.063.852l-.708 2.836a.75.75 0 0 0 1.063.853l.041-.021M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9-3.75h.008v.008H12V8.25Z" />
    </svg>
  );
}

function IconWarning() {
  return (
    <svg className="h-3.5 w-3.5 shrink-0" fill="currentColor" viewBox="0 0 20 20">
      <path fillRule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495ZM10 5a.75.75 0 0 1 .75.75v3.5a.75.75 0 0 1-1.5 0v-3.5A.75.75 0 0 1 10 5Zm0 9a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z" clipRule="evenodd" />
    </svg>
  );
}

// ─── Page component ────────────────────────────────────────────────────────

export default function WhatsAppInboxPage() {
  const [threads, setThreads] = useState<ThreadRow[]>([]);
  const [messages, setMessages] = useState<MessageRow[]>([]);
  const [templateOptions, setTemplateOptions] = useState<TemplateOption[]>([]);
  const [templateFetchError, setTemplateFetchError] = useState<string>("");
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [filter, setFilter] = useState<(typeof filters)[number]["value"]>("open");
  const [search, setSearch] = useState("");
  const [draft, setDraft] = useState("");
  const [composerMode, setComposerMode] = useState<"text" | "template">("text");
  const [selectedTemplateKey, setSelectedTemplateKey] = useState<string>("");
  const [templateVariablesText, setTemplateVariablesText] = useState("");
  const [newChatMode, setNewChatMode] = useState(false);
  const [newChatPhone, setNewChatPhone] = useState("");
  const [newChatName, setNewChatName] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [mobileView, setMobileView] = useState<"list" | "chat">("list");
  const [textWindowOpen, setTextWindowOpen] = useState(false);

  const selectedThread = useMemo(
    () => threads.find((thread) => thread.id === selectedThreadId) ?? null,
    [threads, selectedThreadId],
  );
  const latestFailedOutbound = useMemo(
    () =>
      [...messages]
        .reverse()
        .find((message) => message.direction === "outbound" && message.status === "failed") ?? null,
    [messages],
  );
  const latestInboundAt = useMemo(
    () => {
      const latestInbound = [...messages]
        .reverse()
        .find((message) => message.direction === "inbound");
      return latestInbound?.timestamp ?? latestInbound?.created_at ?? null;
    },
    [messages],
  );
  const selectedTemplate = useMemo(
    () => templateOptions.find((option) => option.key === selectedTemplateKey) ?? templateOptions[0] ?? null,
    [selectedTemplateKey, templateOptions],
  );
  const sortedTemplateOptions = useMemo(() => {
    const approved = templateOptions.filter((option) => option.status === "APPROVED");
    const source = approved.length > 0 ? approved : templateOptions;
    return [...source].sort((a, b) => {
      const aLang = a.language_code === "it" ? 0 : 1;
      const bLang = b.language_code === "it" ? 0 : 1;
      if (aLang !== bLang) return aLang - bLang;
      const aDefault = a.is_tenant_default ? 0 : 1;
      const bDefault = b.is_tenant_default ? 0 : 1;
      if (aDefault !== bDefault) return aDefault - bDefault;
      return a.template.localeCompare(b.template, "it");
    });
  }, [templateOptions]);
  const composerEnabled = Boolean(selectedThreadId) || newChatMode;
  const textModeUnavailable = newChatMode || !textWindowOpen;
  const templateVariables = useMemo(
    () => templateVariablesText.split(/\r?\n/).map((item) => item.trim()).filter(Boolean),
    [templateVariablesText],
  );
  const lastFailureRequiresTemplate = useMemo(() => {
    const reason = (latestFailedOutbound?.failure_reason ?? "").toLowerCase();
    return reason.includes("131047") || reason.includes("re-engagement");
  }, [latestFailedOutbound]);

  const load = useCallback(
    async (nextThreadId?: string | null) => {
      setLoading(true);
      setError("");
      const token = await getAccessToken();
      if (!token) {
        setError("Sessione non disponibile.");
        setLoading(false);
        return;
      }
      const params = new URLSearchParams({ filter, q: search });
      if (nextThreadId) params.set("thread_id", nextThreadId);
      const response = await fetch(`/api/ops/whatsapp-inbox?${params.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const body = (await response.json().catch(() => null)) as InboxPayload | null;
      if (!response.ok || !body?.ok) {
        setError(body?.error ?? "Errore caricamento WhatsApp Inbox.");
        setLoading(false);
        return;
      }
      const nextSelectedThreadId = body.selected_thread_id ?? null;
      setThreads(body.threads ?? []);
      setMessages(body.messages ?? []);
      setTemplateOptions(body.template_options ?? []);
      setTemplateFetchError(body.template_fetch_error ?? "");
      setSelectedTemplateKey((current) => {
        const available = body.template_options ?? [];
        if (available.some((item) => item.key === current)) return current;
        return available[0]?.key ?? "";
      });
      setSelectedThreadId(nextSelectedThreadId);
      if (nextSelectedThreadId !== selectedThreadId) {
        setDraft("");
        setTemplateVariablesText("");
      }
      setLoading(false);
    },
    [filter, search, selectedThreadId],
  );

  useEffect(() => {
    if (composerMode !== "template") return;
    if (!selectedTemplate || templateVariablesText.trim()) return;
    const suggested = buildSuggestedTemplateVariables(selectedThread, selectedTemplate);
    if (suggested.length === 0) return;
    const timeout = window.setTimeout(() => setTemplateVariablesText(suggested.join("\n")), 0);
    return () => window.clearTimeout(timeout);
  }, [composerMode, selectedTemplate, selectedThread, templateVariablesText]);

  useEffect(() => {
    const updateTextWindow = () => {
      if (!latestInboundAt) {
        setTextWindowOpen(false);
        return;
      }
      const inboundTime = new Date(latestInboundAt).getTime();
      setTextWindowOpen(Number.isFinite(inboundTime) && Date.now() - inboundTime <= CUSTOMER_CARE_WINDOW_MS);
    };
    updateTextWindow();
    const interval = window.setInterval(updateTextWindow, 60000);
    return () => window.clearInterval(interval);
  }, [latestInboundAt]);

  useEffect(() => {
    if (composerMode === "text" && textModeUnavailable) {
      const timeout = window.setTimeout(() => setComposerMode("template"), 0);
      return () => window.clearTimeout(timeout);
    }
  }, [composerMode, textModeUnavailable]);

  useEffect(() => {
    const timeout = window.setTimeout(() => void load(selectedThreadId), 250);
    return () => window.clearTimeout(timeout);
  }, [filter, search, selectedThreadId, load]);

  useEffect(() => {
    if (!selectedThreadId) return;
    const interval = window.setInterval(() => { void load(selectedThreadId); }, 12000);
    return () => window.clearInterval(interval);
  }, [selectedThreadId, load]);

  const runAction = async (action: "mark_read" | "close" | "reopen") => {
    if (!selectedThreadId) return;
    const token = await getAccessToken();
    if (!token) return;
    setBusyAction(action);
    setError("");
    const response = await fetch("/api/ops/whatsapp-inbox", {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ thread_id: selectedThreadId, action }),
    });
    const body = (await response.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
    if (!response.ok || !body?.ok) {
      setError(body?.error ?? "Azione non riuscita.");
    } else {
      await load(selectedThreadId);
    }
    setBusyAction(null);
  };

  const deleteChat = async () => {
    if (!selectedThreadId) return;
    const confirmed = window.confirm("Vuoi eliminare questa chat? Verranno rimossi thread e messaggi dallo storico.");
    if (!confirmed) return;
    const token = await getAccessToken();
    if (!token) return;
    setBusyAction("delete");
    setError("");
    const response = await fetch("/api/ops/whatsapp-inbox", {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ thread_id: selectedThreadId, action: "delete" }),
    });
    const body = (await response.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
    if (!response.ok || !body?.ok) {
      setError(body?.error ?? "Eliminazione chat non riuscita.");
    } else {
      setDraft("");
      setSelectedThreadId(null);
      setMobileView("list");
      await load(null);
    }
    setBusyAction(null);
  };

  const sendReply = async () => {
    if (!composerEnabled) return;
    const text = draft.trim();
    if (composerMode === "text" && !text) { setError("Inserisci un messaggio prima di inviare."); return; }
    if (composerMode === "text" && textModeUnavailable) { setError("Per inviare ora devi usare un template approvato."); return; }
    if (composerMode === "template" && !selectedTemplate) { setError("Seleziona un template prima di inviare."); return; }
    const token = await getAccessToken();
    if (!token) { setError("Sessione non disponibile."); return; }
    setBusyAction("reply");
    setError("");
    const response = await fetch("/api/ops/whatsapp-inbox", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(
        newChatMode
          ? composerMode === "template"
            ? { mode: "template", phone: newChatPhone, profile_name: newChatName, template_name: selectedTemplate?.template, template_language: selectedTemplate?.language_code, template_variables: templateVariables }
            : { mode: "text", phone: newChatPhone, profile_name: newChatName, text }
          : composerMode === "template"
            ? { mode: "template", thread_id: selectedThreadId, template_name: selectedTemplate?.template, template_language: selectedTemplate?.language_code, template_variables: templateVariables }
            : { mode: "text", thread_id: selectedThreadId, text },
      ),
    });
    const body = (await response.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
    if (!response.ok || !body?.ok) {
      setError(body?.error ?? "Invio messaggio non riuscito.");
    } else {
      setDraft("");
      setTemplateVariablesText("");
      if (newChatMode) {
        setNewChatMode(false);
        setNewChatPhone("");
        setNewChatName("");
        await load(null);
      } else {
        await load(selectedThreadId);
      }
    }
    setBusyAction(null);
  };

  const appendEmoji = (emoji: (typeof quickEmojis)[number]) => setDraft((c) => `${c}${emoji}`);
  const applyQuickReply = (text: (typeof quickReplies)[number]) => setDraft(text);

  const loadSuggestedTemplateVariables = () => {
    const suggested = buildSuggestedTemplateVariables(selectedThread, selectedTemplate);
    if (suggested.length === 0) { setError("Nessun suggerimento disponibile per questa conversazione."); return; }
    setError("");
    setTemplateVariablesText(suggested.join("\n"));
  };

  // ─── Render ───────────────────────────────────────────────────────────────

  const showChat = Boolean(selectedThread) || newChatMode;

  return (
    <section className="page-section">

      {/* ── Compact page header ── */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="mb-1 flex items-center gap-1.5 text-xs text-slate-400">
            <span>Operazioni</span>
            <span>/</span>
            <span className="font-medium text-slate-600">WhatsApp</span>
          </div>
          <h1 className="text-xl font-bold text-slate-900">Inbox WhatsApp</h1>
          <p className="mt-0.5 text-sm text-slate-500">Risposte clienti ricevute da WhatsApp Business Platform.</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <div className="relative">
            <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-slate-400">
              <IconSearch />
            </span>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="input-saas w-full pl-9 sm:w-72"
              placeholder="Cerca nome, telefono, hotel…"
            />
          </div>
          <button
            type="button"
            onClick={() => {
              setNewChatMode(true);
              setSelectedThreadId(null);
              setDraft("");
              setComposerMode("template");
              setTemplateVariablesText("");
              setError("");
              setMobileView("chat");
            }}
            className="flex shrink-0 items-center gap-1.5 rounded-xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-emerald-700"
          >
            <IconPlus />
            Nuovo
          </button>
        </div>
      </div>

      {/* ── Filter tabs ── */}
      <div className="flex flex-wrap gap-1.5">
        {filters.map((item) => {
          const active = filter === item.value;
          return (
            <button
              key={item.value}
              type="button"
              onClick={() => setFilter(item.value)}
              className={`flex items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-xs font-semibold transition ${
                active
                  ? "border-indigo-600 bg-indigo-600 text-white shadow-sm"
                  : "border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:bg-slate-50"
              }`}
            >
              {item.label}
              {active && !loading && (
                <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-white/25 px-1 text-[10px] font-bold text-white">
                  {threads.length}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* ── Error banner ── */}
      {error && (
        <div className="flex items-center gap-2 rounded-xl border border-rose-200 bg-rose-50 px-4 py-2.5 text-sm text-rose-700">
          <svg className="h-4 w-4 shrink-0" fill="currentColor" viewBox="0 0 20 20">
            <path fillRule="evenodd" d="M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16ZM8.28 7.22a.75.75 0 0 0-1.06 1.06L8.94 10l-1.72 1.72a.75.75 0 1 0 1.06 1.06L10 11.06l1.72 1.72a.75.75 0 1 0 1.06-1.06L11.06 10l1.72-1.72a.75.75 0 0 0-1.06-1.06L10 8.94 8.28 7.22Z" clipRule="evenodd" />
          </svg>
          {error}
        </div>
      )}

      {/* ── Main layout ── */}
      <div className="grid min-h-[640px] gap-2 rounded-2xl bg-slate-100 p-2 lg:grid-cols-[340px_1fr]">

        {/* ── LEFT: Thread list ── */}
        <div className={`flex flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm ${mobileView === "chat" ? "hidden lg:flex" : "flex"}`}>
          <div className="flex shrink-0 items-center justify-between border-b border-slate-100 px-4 py-3">
            <div>
              <p className="text-sm font-semibold text-slate-900">Conversazioni</p>
              <p className="text-xs text-slate-400">
                {loading ? "Caricamento…" : `${threads.length} thread`}
              </p>
            </div>
            {loading && (
              <div className="h-4 w-4 animate-spin rounded-full border-2 border-indigo-200 border-t-indigo-600" />
            )}
          </div>

          <div className="flex-1 overflow-y-auto">
            {threads.map((thread) => {
              const active = thread.id === selectedThreadId;
              const name =
                thread.whatsapp_contacts?.profile_name ||
                thread.service?.customer_name ||
                thread.phone_e164 ||
                thread.wa_id;
              const { bg: avBg, text: avText } = avatarColors(name);
              const inits = nameInitials(name);
              const dot = threadStatusDot(thread);
              const badge = matchStatusBadge(thread.match_status);

              return (
                <button
                  key={thread.id}
                  type="button"
                  onClick={() => {
                    setNewChatMode(false);
                    void load(thread.id);
                    setMobileView("chat");
                  }}
                  className={`relative block w-full border-b border-slate-100 px-4 py-3 text-left transition-colors last:border-b-0 ${
                    active
                      ? "border-l-4 border-l-indigo-600 bg-indigo-50 pl-3"
                      : "border-l-4 border-l-transparent hover:bg-slate-50"
                  }`}
                >
                  <div className="flex items-start gap-3">
                    {/* Avatar */}
                    <div className="relative shrink-0">
                      <div className={`flex h-9 w-9 items-center justify-center rounded-full text-xs font-bold ${avBg} ${avText}`}>
                        {inits}
                      </div>
                      <span className={`absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-white ${dot}`} />
                    </div>

                    {/* Content */}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-start justify-between gap-2">
                        <span className={`truncate text-sm font-semibold ${active ? "text-indigo-900" : "text-slate-900"}`}>
                          {name}
                        </span>
                        <span className={`shrink-0 text-[10px] tabular-nums ${active ? "text-indigo-400" : "text-slate-400"}`}>
                          {formatThreadDate(thread.last_message_at)}
                        </span>
                      </div>
                      <p className={`mt-0.5 truncate text-xs ${active ? "text-indigo-600" : "text-slate-500"}`}>
                        {thread.last_message_preview ?? "Nessun messaggio"}
                      </p>
                      <div className="mt-1.5 flex items-center gap-1.5">
                        <span className={`rounded-full px-2 py-0.5 text-[9px] font-semibold ${badge.bg} ${badge.text}`}>
                          {badge.label}
                        </span>
                        {thread.unread_count > 0 && (
                          <span className="inline-flex min-w-4 items-center justify-center rounded-full bg-emerald-500 px-1.5 py-0.5 text-[9px] font-bold text-white">
                            {thread.unread_count > 99 ? "99+" : thread.unread_count}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                </button>
              );
            })}

            {/* Empty state */}
            {!loading && threads.length === 0 && (
              <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
                <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-slate-100 text-slate-400">
                  <IconChat />
                </div>
                <p className="text-sm font-medium text-slate-600">Nessuna conversazione</p>
                <p className="mt-1 text-xs text-slate-400">Non ci sono thread per questo filtro.</p>
              </div>
            )}
          </div>
        </div>

        {/* ── RIGHT: Chat panel ── */}
        <div className={`flex flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm ${mobileView === "list" ? "hidden lg:flex" : "flex"}`}>
          {showChat ? (
            <>
              {/* Chat header */}
              <div className="shrink-0 border-b border-slate-100 px-4 py-3">
                <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
                  <div className="flex items-start gap-3">
                    {/* Mobile back button */}
                    <button
                      type="button"
                      onClick={() => setMobileView("list")}
                      className="mt-0.5 flex shrink-0 items-center gap-1 rounded-lg border border-slate-200 px-2 py-1 text-xs font-medium text-slate-500 hover:bg-slate-50 lg:hidden"
                    >
                      <IconChevronLeft />
                      Indietro
                    </button>
                    <div className="min-w-0">
                      <p className="truncate text-base font-bold text-slate-900">
                        {newChatMode
                          ? "Nuovo messaggio WhatsApp"
                          : selectedThread?.whatsapp_contacts?.profile_name ||
                            selectedThread?.phone_e164 ||
                            selectedThread?.wa_id}
                      </p>
                      <p className="mt-0.5 truncate text-xs text-slate-500">
                        {newChatMode
                          ? "Invia un messaggio a un numero che non ha ancora scritto in chat."
                          : selectedThread?.service
                            ? `${selectedThread.service.customer_name ?? "Cliente"} · ${selectedThread.service.date ?? ""} ${String(selectedThread.service.time ?? "").slice(0, 5)}`
                            : "Nessuna prenotazione associata"}
                      </p>
                      {!newChatMode && selectedThread && (
                        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                          {(() => {
                            const b = matchStatusBadge(selectedThread.match_status);
                            return (
                              <span className={`rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${b.bg} ${b.text}`}>
                                {b.label}
                              </span>
                            );
                          })()}
                          {selectedThread.phone_e164 && (
                            <span className="font-mono text-[11px] text-slate-400">{selectedThread.phone_e164}</span>
                          )}
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Action buttons */}
                  {!newChatMode && selectedThread ? (
                    <div className="flex flex-wrap items-center gap-2">
                      {/* Primary action */}
                      <button
                        type="button"
                        disabled
                        title="Associazione manuale — prossimo step"
                        className="flex items-center gap-1.5 rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-1.5 text-xs font-semibold text-emerald-700 opacity-60"
                      >
                        <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M13.19 8.688a4.5 4.5 0 0 1 1.242 7.244l-4.5 4.5a4.5 4.5 0 0 1-6.364-6.364l1.757-1.757m13.35-.622 1.757-1.757a4.5 4.5 0 0 0-6.364-6.364l-4.5 4.5a4.5 4.5 0 0 0 1.242 7.244" />
                        </svg>
                        Associa a prenotazione
                      </button>

                      {/* Divider */}
                      <span className="h-5 w-px bg-slate-200" />

                      {/* Secondary actions */}
                      <button
                        type="button"
                        onClick={() => void runAction("mark_read")}
                        disabled={busyAction !== null}
                        className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-50"
                      >
                        {busyAction === "mark_read" ? "…" : "Segna letto"}
                      </button>
                      <button
                        type="button"
                        onClick={() => void runAction(selectedThread.status === "closed" ? "reopen" : "close")}
                        disabled={busyAction !== null}
                        className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-50"
                      >
                        {busyAction === "close" || busyAction === "reopen" ? "…" : selectedThread.status === "closed" ? "Ripristina" : "Archivia"}
                      </button>

                      {/* Divider */}
                      <span className="h-5 w-px bg-slate-200" />

                      {/* Destructive */}
                      <button
                        type="button"
                        onClick={() => void deleteChat()}
                        disabled={busyAction !== null}
                        className="rounded-lg border border-rose-200 px-3 py-1.5 text-xs font-semibold text-rose-600 hover:bg-rose-50 disabled:opacity-50"
                      >
                        {busyAction === "delete" ? "…" : "Elimina"}
                      </button>
                    </div>
                  ) : newChatMode ? (
                    <button
                      type="button"
                      onClick={() => {
                        setNewChatMode(false);
                        setNewChatPhone("");
                        setNewChatName("");
                        setDraft("");
                        setTemplateVariablesText("");
                        setMobileView("list");
                      }}
                      className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50"
                    >
                      Annulla
                    </button>
                  ) : null}
                </div>

                {/* Unmatched banner */}
                {!newChatMode && selectedThread?.match_status !== "matched" && (
                  <div className="mt-3 flex items-start gap-3 rounded-xl border-l-4 border-l-amber-400 bg-amber-50 px-3 py-2.5">
                    <span className="mt-0.5 text-amber-500"><IconInfo /></span>
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-semibold text-amber-800">
                        Conversazione non associata con certezza
                      </p>
                      {(selectedThread?.match_suggestions?.length ?? 0) > 0 ? (
                        <div className="mt-1.5 flex flex-wrap gap-1.5">
                          <span className="text-xs text-amber-700">Suggerimenti:</span>
                          {(selectedThread!.match_suggestions as Array<{ id?: string; customer_name?: string }>).map((s, i) => (
                            <span
                              key={i}
                              className="rounded-full border border-amber-200 bg-white px-2 py-0.5 text-[11px] font-semibold text-amber-800"
                            >
                              {s.customer_name ?? s.id ?? `#${i + 1}`}
                            </span>
                          ))}
                        </div>
                      ) : (
                        <p className="mt-0.5 text-xs text-amber-700">Nessun suggerimento disponibile.</p>
                      )}
                    </div>
                  </div>
                )}
              </div>

              {/* Messages area */}
              <div className="flex-1 space-y-3 overflow-y-auto bg-slate-50 px-4 py-4">
                {messages.map((message) => {
                  const inbound = message.direction === "inbound";
                  const failed = !inbound && message.status === "failed";
                  return (
                    <div key={message.id} className={`flex items-end gap-2 ${inbound ? "justify-start" : "justify-end"}`}>
                      {/* Inbound avatar stub */}
                      {inbound && (
                        <div className="mb-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-slate-200 text-[9px] font-bold text-slate-500">
                          {selectedThread
                            ? nameInitials(
                                selectedThread.whatsapp_contacts?.profile_name ||
                                selectedThread.service?.customer_name ||
                                selectedThread.phone_e164 ||
                                selectedThread.wa_id,
                              )
                            : "?"}
                        </div>
                      )}

                      <div
                        className={`max-w-[78%] px-3.5 py-2.5 shadow-sm ${
                          failed
                            ? "rounded-2xl rounded-br-sm border border-dashed border-rose-400 bg-rose-50"
                            : inbound
                              ? "rounded-2xl rounded-bl-sm border border-slate-200 bg-white"
                              : "rounded-2xl rounded-br-sm border border-indigo-200 bg-indigo-50"
                        }`}
                      >
                        <p className={`whitespace-pre-wrap text-sm leading-relaxed ${inbound ? "text-slate-800" : failed ? "text-rose-800" : "text-indigo-900"}`}>
                          {message.text_body || `[${message.message_type ?? "messaggio"}]`}
                        </p>
                        {message.media_id && (
                          <p className="mt-1 text-[11px] text-slate-400">
                            Allegato: {message.media_mime_type ?? message.media_id}
                          </p>
                        )}
                        <div className={`mt-1.5 flex flex-wrap items-center gap-1.5 ${inbound ? "" : "justify-end"}`}>
                          <p className="text-[10px] text-slate-400">{formatDate(message.timestamp ?? message.created_at)}</p>
                          {!inbound && (
                            <span className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold ${messageStatusTone(message.status)}`}>
                              {failed && <span className="text-rose-500"><IconWarning /></span>}
                              {messageStatusLabel(message.status)}
                            </span>
                          )}
                        </div>
                        {failed && message.failure_reason && (
                          <p className="mt-1 text-[11px] text-rose-600">
                            {message.failure_reason}
                          </p>
                        )}
                      </div>
                    </div>
                  );
                })}
                {messages.length === 0 && (
                  <div className="flex flex-col items-center justify-center py-16 text-center">
                    <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-slate-100 text-slate-300">
                      <IconChat />
                    </div>
                    <p className="text-sm text-slate-400">
                      {newChatMode ? "La nuova conversazione apparirà qui dopo il primo invio." : "Seleziona una conversazione dalla lista."}
                    </p>
                  </div>
                )}
              </div>

              {/* Composer */}
              <div className="shrink-0 border-t border-slate-100 bg-white px-4 py-3">
                <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3">
                  {/* New chat inputs */}
                  {newChatMode && (
                    <div className="mb-3 grid gap-3 md:grid-cols-2">
                      <label className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                        Numero WhatsApp
                        <input
                          data-no-uppercase
                          value={newChatPhone}
                          onChange={(e) => setNewChatPhone(e.target.value)}
                          placeholder="+39 333 1234567"
                          className="input-saas mt-2 w-full"
                        />
                      </label>
                      <label className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                        Nome contatto
                        <input
                          data-no-uppercase
                          value={newChatName}
                          onChange={(e) => setNewChatName(e.target.value)}
                          placeholder="Nome cliente"
                          className="input-saas mt-2 w-full"
                        />
                      </label>
                    </div>
                  )}

                  {/* Failed message warning */}
                  {latestFailedOutbound && (
                    <div className="mb-3 flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
                      <span className="mt-0.5 text-rose-500"><IconWarning /></span>
                      <span className="flex-1">
                        Ultima risposta non consegnata: {latestFailedOutbound.failure_reason ?? "verifica numero o configurazione WhatsApp."}
                      </span>
                      {lastFailureRequiresTemplate && (
                        <button
                          type="button"
                          onClick={() => setComposerMode("template")}
                          className="shrink-0 rounded-full border border-rose-300 bg-white px-2 py-0.5 text-[11px] font-semibold text-rose-700 hover:bg-rose-100"
                        >
                          Usa template
                        </button>
                      )}
                    </div>
                  )}

                  {textModeUnavailable && (
                    <div className="mb-3 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                      <span className="mt-0.5 text-amber-600"><IconWarning /></span>
                      <span className="flex-1">
                        {newChatMode
                          ? "Per aprire una nuova conversazione WhatsApp serve un template approvato."
                          : "La finestra di risposta libera e scaduta: usa un template approvato per scrivere al cliente."}
                      </span>
                    </div>
                  )}

                  {/* Mode toggle */}
                  <div className="mb-3 flex flex-wrap gap-2">
                    {[
                      { value: "text", label: "Messaggio" },
                      { value: "template", label: "Template" },
                    ].map((mode) => (
                      <button
                        key={mode.value}
                        type="button"
                        onClick={() => setComposerMode(mode.value as "text" | "template")}
                        disabled={busyAction === "reply" || (mode.value === "text" && textModeUnavailable)}
                        className={`rounded-full border px-3 py-1.5 text-xs font-semibold transition disabled:cursor-not-allowed disabled:bg-slate-100 ${
                          composerMode === mode.value
                            ? "border-emerald-600 bg-emerald-600 text-white"
                            : "border-slate-200 bg-white text-slate-700 hover:border-emerald-300 hover:bg-emerald-50"
                        }`}
                      >
                        {mode.label}
                      </button>
                    ))}
                  </div>

                  {/* Template studio — unchanged ─────────────────────────── */}
                  {composerMode === "template" ? (
                    <div className="space-y-3">
                      <div className="overflow-hidden rounded-[28px] border border-slate-200 bg-white shadow-sm">
                        <div className="border-b border-slate-200 bg-[linear-gradient(135deg,rgba(255,255,255,1),rgba(240,253,250,1))] px-4 py-4">
                          <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
                            <div>
                              <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-emerald-700">Template Studio</p>
                              <h3 className="mt-1 text-lg font-semibold text-slate-900">Selezione rapida, preview immediata</h3>
                              <p className="mt-1 text-sm text-slate-600">Template approvati ordinati per priorità operativa, con focus sul contenuto vero del messaggio.</p>
                            </div>
                            <div className="grid grid-cols-3 gap-2 text-center text-xs">
                              <div className="rounded-2xl border border-emerald-100 bg-white px-3 py-2">
                                <div className="font-semibold text-slate-900">{sortedTemplateOptions.length}</div>
                                <div className="text-slate-500">Visibili</div>
                              </div>
                              <div className="rounded-2xl border border-emerald-100 bg-white px-3 py-2">
                                <div className="font-semibold text-slate-900">{sortedTemplateOptions.filter((o) => o.language_code === "it").length}</div>
                                <div className="text-slate-500">Italiano</div>
                              </div>
                              <div className="rounded-2xl border border-emerald-100 bg-white px-3 py-2">
                                <div className="font-semibold text-slate-900">{sortedTemplateOptions.filter((o) => o.status === "APPROVED").length}</div>
                                <div className="text-slate-500">Approved</div>
                              </div>
                            </div>
                          </div>
                        </div>
                        <div className="grid gap-4 p-4 xl:grid-cols-[minmax(0,1.15fr)_minmax(320px,0.85fr)]">
                          <div className="space-y-2">
                            {sortedTemplateOptions.map((option) => {
                              const active = selectedTemplate?.key === option.key;
                              return (
                                <button
                                  key={option.key}
                                  type="button"
                                  onClick={() => setSelectedTemplateKey(option.key)}
                                  disabled={busyAction === "reply"}
                                  className={`group flex w-full items-start gap-4 rounded-[22px] border px-4 py-4 text-left transition ${
                                    active
                                      ? "border-emerald-500 bg-emerald-50 shadow-[0_14px_40px_-28px_rgba(16,185,129,0.65)]"
                                      : "border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50"
                                  }`}
                                >
                                  <div className={`mt-0.5 h-11 w-11 shrink-0 rounded-2xl bg-gradient-to-br ${templateTone(option.template)} ring-1 ring-black/5`} />
                                  <div className="min-w-0 flex-1">
                                    <div className="flex flex-wrap items-center gap-2">
                                      <span className="text-sm font-semibold text-slate-900">{templateFriendlyLabel(option.template)}</span>
                                      <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${option.language_code === "it" ? "bg-emerald-600 text-white" : "bg-slate-900 text-white"}`}>
                                        {option.language_code.toUpperCase()}
                                      </span>
                                      {option.is_tenant_default && (
                                        <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-700">Default</span>
                                      )}
                                    </div>
                                    <div className="mt-1 text-[11px] font-medium uppercase tracking-[0.16em] text-slate-400">{option.template}</div>
                                    <div className="mt-3 flex flex-wrap gap-2 text-[10px] font-semibold uppercase tracking-[0.12em]">
                                      <span className="rounded-full bg-slate-100 px-2 py-1 text-slate-700">{option.status}</span>
                                      {option.category && <span className="rounded-full bg-slate-100 px-2 py-1 text-slate-700">{option.category}</span>}
                                      <span className="rounded-full bg-slate-100 px-2 py-1 text-slate-700">{option.body_parameter_count} variabili</span>
                                    </div>
                                  </div>
                                  <div className={`pt-1 text-[11px] font-semibold ${active ? "text-emerald-700" : "text-slate-400 group-hover:text-slate-700"}`}>
                                    {active ? "Attivo" : "Apri"}
                                  </div>
                                </button>
                              );
                            })}
                          </div>
                          {selectedTemplate && (
                            <div className="rounded-[24px] border border-slate-200 bg-[linear-gradient(180deg,rgba(15,23,42,1),rgba(30,41,59,0.98))] p-5 text-slate-100 shadow-[0_20px_60px_-36px_rgba(15,23,42,0.85)]">
                              <div className="flex items-start justify-between gap-4">
                                <div>
                                  <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-emerald-300">Template Preview</p>
                                  <h4 className="mt-2 text-lg font-semibold text-white">{templateFriendlyLabel(selectedTemplate.template)}</h4>
                                  <p className="mt-1 text-sm text-slate-300">{selectedTemplate.template} · {templateLanguageLabel(selectedTemplate.language_code)}</p>
                                </div>
                                <span className="rounded-full border border-emerald-400/30 bg-emerald-400/10 px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-emerald-200">
                                  {selectedTemplate.status}
                                </span>
                              </div>
                              <div className="mt-4 grid grid-cols-2 gap-2 text-xs">
                                <div className="rounded-2xl border border-white/10 bg-white/5 px-3 py-2">
                                  <div className="text-slate-400">Variabili BODY</div>
                                  <div className="mt-1 text-lg font-semibold text-white">{selectedTemplate.body_parameter_count}</div>
                                </div>
                                <div className="rounded-2xl border border-white/10 bg-white/5 px-3 py-2">
                                  <div className="text-slate-400">Header</div>
                                  <div className="mt-1 text-sm font-semibold text-white">{selectedTemplate.header_format ?? "Nessuno"}</div>
                                </div>
                              </div>
                              <div className="mt-4 rounded-2xl border border-white/10 bg-white/5 px-4 py-3">
                                <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.22em] text-emerald-300">Body Meta</p>
                                <p className="whitespace-pre-wrap text-sm leading-6 text-slate-100">
                                  {selectedTemplate.body_text ?? "Preview del body non disponibile."}
                                </p>
                              </div>
                              <div className="mt-4 flex flex-wrap gap-2 text-[10px] font-semibold uppercase tracking-[0.12em]">
                                {selectedTemplate.category && <span className="rounded-full bg-white/10 px-2 py-1 text-slate-200">{selectedTemplate.category}</span>}
                                {selectedTemplate.is_tenant_default && <span className="rounded-full bg-amber-400/15 px-2 py-1 text-amber-200">Default tenant</span>}
                                {selectedTemplate.is_tenant_arrival && <span className="rounded-full bg-sky-400/15 px-2 py-1 text-sky-200">Arrivi tenant</span>}
                              </div>
                            </div>
                          )}
                        </div>
                      </div>
                      {templateFetchError && (
                        <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
                          Template Meta non caricati: {templateFetchError}
                        </div>
                      )}
                      <label htmlFor="whatsapp-template-vars" className="block text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">
                        Variabili template
                      </label>
                      <textarea
                        id="whatsapp-template-vars"
                        data-no-uppercase
                        value={templateVariablesText}
                        onChange={(e) => setTemplateVariablesText(e.target.value)}
                        placeholder={"Una variabile per riga\nMario Rossi\n2026-05-03\n14:30"}
                        rows={5}
                        disabled={busyAction === "reply"}
                        className="min-h-[120px] w-full rounded-2xl border border-slate-200 bg-white px-3 py-3 text-sm text-slate-800 outline-none transition placeholder:text-slate-400 focus:border-emerald-300 focus:ring-2 focus:ring-emerald-100 disabled:cursor-not-allowed disabled:bg-slate-100"
                      />
                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          onClick={loadSuggestedTemplateVariables}
                          disabled={busyAction === "reply" || !selectedThread}
                          className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 transition hover:border-emerald-300 hover:bg-emerald-50 disabled:cursor-not-allowed disabled:bg-slate-100"
                        >
                          Compila suggerite
                        </button>
                        <button
                          type="button"
                          onClick={() => setTemplateVariablesText("")}
                          disabled={busyAction === "reply"}
                          className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 transition hover:border-emerald-300 hover:bg-emerald-50 disabled:cursor-not-allowed disabled:bg-slate-100"
                        >
                          Svuota variabili
                        </button>
                      </div>
                    </div>
                  ) : (
                    /* Text composer ─────────────────────────────────────── */
                    <>
                      <label htmlFor="whatsapp-reply" className="mb-2 block text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">
                        Rispondi su WhatsApp
                      </label>
                      <textarea
                        id="whatsapp-reply"
                        data-no-uppercase
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        placeholder="Scrivi la risposta al cliente…"
                        rows={4}
                        disabled={busyAction === "reply"}
                        autoCapitalize="sentences"
                        autoCorrect="on"
                        spellCheck
                        className="min-h-[104px] w-full rounded-2xl border border-slate-200 bg-white px-3 py-3 text-sm text-slate-800 outline-none transition placeholder:text-slate-400 focus:border-emerald-300 focus:ring-2 focus:ring-emerald-100 disabled:cursor-not-allowed disabled:bg-slate-100"
                      />
                      <div className="mt-3 flex flex-wrap gap-2">
                        {quickReplies.map((reply) => (
                          <button
                            key={reply}
                            type="button"
                            onClick={() => applyQuickReply(reply)}
                            disabled={busyAction === "reply"}
                            className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 transition hover:border-emerald-300 hover:bg-emerald-50 disabled:cursor-not-allowed disabled:bg-slate-100"
                          >
                            {reply}
                          </button>
                        ))}
                      </div>
                      <div className="mt-3 flex flex-wrap gap-2">
                        {quickEmojis.map((emoji) => (
                          <button
                            key={emoji}
                            type="button"
                            onClick={() => appendEmoji(emoji)}
                            disabled={busyAction === "reply"}
                            className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-base transition hover:border-emerald-300 hover:bg-emerald-50 disabled:cursor-not-allowed disabled:bg-slate-100"
                            aria-label={`Inserisci ${emoji}`}
                          >
                            {emoji}
                          </button>
                        ))}
                      </div>
                    </>
                  )}

                  {/* Send bar */}
                  <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                    <p className="text-xs text-slate-500">
                      {composerMode === "template"
                        ? "Il template viene inviato al numero WhatsApp della conversazione e salvato nello storico."
                        : "Il messaggio viene inviato al numero WhatsApp della conversazione e salvato nello storico."}
                    </p>
                    <button
                      type="button"
                      onClick={() => void sendReply()}
                      disabled={
                        busyAction !== null ||
                        (composerMode === "text" ? !draft.trim() : !selectedTemplate) ||
                        (newChatMode && !newChatPhone.trim())
                      }
                      className="rounded-xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:bg-slate-300"
                    >
                      {busyAction === "reply" ? "Invio…" : composerMode === "template" ? "Invia template" : "Invia risposta"}
                    </button>
                  </div>
                </div>
              </div>
            </>
          ) : (
            /* Empty state — no thread selected */
            <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
              <div className="flex h-14 w-14 items-center justify-center rounded-full bg-slate-100 text-slate-300">
                <IconChat />
              </div>
              <div>
                <p className="text-sm font-medium text-slate-600">Nessuna conversazione selezionata</p>
                <p className="mt-1 text-xs text-slate-400">Scegli un thread dalla lista per visualizzare i messaggi.</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
