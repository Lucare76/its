"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { PageHeader } from "@/components/ui";
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
  error?: string;
};

const filters = [
  { value: "open", label: "Aperte" },
  { value: "needs_review", label: "Da rivedere" },
  { value: "associated", label: "Associate" },
  { value: "unassociated", label: "Non associate" },
  { value: "closed", label: "Chiuse" }
] as const;

const quickEmojis = ["👍", "🙏", "😊", "🎉", "🚐", "📍", "⏰", "☎️"] as const;
const quickReplies = [
  "Arriviamo tra 5 minuti.",
  "Siamo al punto d'incontro indicato.",
  "Puoi inviarci la tua posizione?",
  "Ci chiami a questo numero, grazie.",
  "Perfetto, ti aspettiamo."
] as const;

function formatDate(value: string | null) {
  if (!value) return "";
  return new Intl.DateTimeFormat("it-IT", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
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

async function getAccessToken() {
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

export default function WhatsAppInboxPage() {
  const [threads, setThreads] = useState<ThreadRow[]>([]);
  const [messages, setMessages] = useState<MessageRow[]>([]);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [filter, setFilter] = useState<(typeof filters)[number]["value"]>("open");
  const [search, setSearch] = useState("");
  const [draft, setDraft] = useState("");
  const [newChatMode, setNewChatMode] = useState(false);
  const [newChatPhone, setNewChatPhone] = useState("");
  const [newChatName, setNewChatName] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busyAction, setBusyAction] = useState<string | null>(null);

  const selectedThread = useMemo(
    () => threads.find((thread) => thread.id === selectedThreadId) ?? null,
    [threads, selectedThreadId]
  );
  const latestFailedOutbound = useMemo(
    () =>
      [...messages]
        .reverse()
        .find((message) => message.direction === "outbound" && message.status === "failed") ?? null,
    [messages]
  );
  const composerEnabled = Boolean(selectedThreadId) || newChatMode;

  const load = useCallback(async (nextThreadId?: string | null) => {
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
      headers: { Authorization: `Bearer ${token}` }
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
    setSelectedThreadId(nextSelectedThreadId);
    if (nextSelectedThreadId !== selectedThreadId) {
      setDraft("");
    }
    setLoading(false);
  }, [filter, search, selectedThreadId]);

  useEffect(() => {
    const timeout = window.setTimeout(() => void load(selectedThreadId), 250);
    return () => window.clearTimeout(timeout);
  }, [filter, search, selectedThreadId, load]);

  useEffect(() => {
    if (!selectedThreadId) return;
    const interval = window.setInterval(() => {
      void load(selectedThreadId);
    }, 12000);
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
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ thread_id: selectedThreadId, action })
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
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ thread_id: selectedThreadId, action: "delete" })
    });
    const body = (await response.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
    if (!response.ok || !body?.ok) {
      setError(body?.error ?? "Eliminazione chat non riuscita.");
    } else {
      setDraft("");
      setSelectedThreadId(null);
      await load(null);
    }
    setBusyAction(null);
  };

  const sendReply = async () => {
    if (!composerEnabled) return;
    const text = draft.trim();
    if (!text) {
      setError("Inserisci un messaggio prima di inviare.");
      return;
    }
    const token = await getAccessToken();
    if (!token) {
      setError("Sessione non disponibile.");
      return;
    }
    setBusyAction("reply");
    setError("");
    const response = await fetch("/api/ops/whatsapp-inbox", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(
        newChatMode
          ? { phone: newChatPhone, profile_name: newChatName, text }
          : { thread_id: selectedThreadId, text }
      )
    });
    const body = (await response.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
    if (!response.ok || !body?.ok) {
      setError(body?.error ?? "Invio messaggio non riuscito.");
    } else {
      setDraft("");
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

  const appendEmoji = (emoji: (typeof quickEmojis)[number]) => {
    setDraft((current) => `${current}${emoji}`);
  };

  const applyQuickReply = (text: (typeof quickReplies)[number]) => {
    setDraft(text);
  };

  return (
    <section className="page-section">
      <PageHeader
        title="Inbox WhatsApp"
        subtitle="Risposte clienti ricevute da WhatsApp Business Platform."
        breadcrumbs={[{ label: "Operazioni", href: "/dashboard" }, { label: "WhatsApp" }]}
      />

      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-wrap gap-2">
          {filters.map((item) => (
            <button
              key={item.value}
              type="button"
              onClick={() => setFilter(item.value)}
              className={`rounded-lg border px-3 py-1.5 text-xs font-semibold transition ${
                filter === item.value
                  ? "border-slate-900 bg-slate-900 text-white"
                  : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
        <div className="flex w-full flex-col gap-2 lg:w-auto lg:flex-row">
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            className="input-saas w-full lg:w-80"
            placeholder="Cerca nome, telefono, pratica, hotel"
          />
          <button
            type="button"
            onClick={() => {
              setNewChatMode(true);
              setSelectedThreadId(null);
              setDraft("");
              setError("");
            }}
            className="rounded-xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-emerald-700"
          >
            Nuovo messaggio
          </button>
        </div>
      </div>

      {error ? (
        <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p>
      ) : null}

      <div className="grid min-h-[640px] gap-4 lg:grid-cols-[360px_1fr]">
        <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
          <div className="border-b border-slate-100 px-4 py-3">
            <p className="text-sm font-semibold text-slate-900">Conversazioni</p>
            <p className="text-xs text-slate-400">{loading ? "Caricamento..." : `${threads.length} thread`}</p>
          </div>
          <div className="max-h-[580px] overflow-y-auto">
            {threads.map((thread) => {
              const active = thread.id === selectedThreadId;
              const name = thread.whatsapp_contacts?.profile_name || thread.service?.customer_name || thread.phone_e164 || thread.wa_id;
              return (
                <button
                  key={thread.id}
                  type="button"
                  onClick={() => {
                    setNewChatMode(false);
                    void load(thread.id);
                  }}
                  className={`block w-full border-b border-slate-100 px-4 py-3 text-left transition ${
                    active ? "bg-slate-900 text-white" : "bg-white hover:bg-slate-50"
                  }`}
                >
                  <span className="flex items-start justify-between gap-3">
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-semibold">{name}</span>
                      <span className={`mt-0.5 block truncate text-xs ${active ? "text-slate-300" : "text-slate-500"}`}>
                        {thread.last_message_preview ?? "Nessun messaggio"}
                      </span>
                    </span>
                    {thread.unread_count > 0 ? (
                      <span className="inline-flex min-w-6 items-center justify-center rounded-full bg-emerald-500 px-1.5 py-0.5 text-[10px] font-bold text-white">
                        {thread.unread_count > 99 ? "99+" : thread.unread_count}
                      </span>
                    ) : null}
                  </span>
                  <span className={`mt-2 flex flex-wrap items-center gap-2 text-[10px] font-semibold uppercase ${active ? "text-slate-300" : "text-slate-400"}`}>
                    <span>{thread.match_status === "matched" ? "Associata" : "Da verificare"}</span>
                    <span>{formatDate(thread.last_message_at)}</span>
                  </span>
                </button>
              );
            })}
            {!loading && threads.length === 0 ? (
              <div className="px-4 py-10 text-center text-sm text-slate-400">Nessuna conversazione per questo filtro.</div>
            ) : null}
          </div>
        </div>

        <div className="flex min-h-0 flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white">
          {selectedThread || newChatMode ? (
            <>
              <div className="border-b border-slate-100 px-4 py-3">
                <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
                  <div>
                    <p className="text-sm font-semibold text-slate-900">
                      {newChatMode
                        ? "Nuovo messaggio WhatsApp"
                        : selectedThread?.whatsapp_contacts?.profile_name || selectedThread?.phone_e164 || selectedThread?.wa_id}
                    </p>
                    <p className="text-xs text-slate-500">
                      {newChatMode
                        ? "Invia un messaggio a un numero che non ha ancora scritto in chat."
                        : selectedThread?.service
                          ? `${selectedThread.service.customer_name ?? "Cliente"} · ${selectedThread.service.date ?? ""} ${String(selectedThread.service.time ?? "").slice(0, 5)}`
                          : "Nessuna prenotazione associata"}
                    </p>
                  </div>
                  {!newChatMode && selectedThread ? (
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => void runAction("mark_read")}
                        disabled={busyAction !== null}
                        className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-50"
                      >
                        Segna come letto
                      </button>
                      <button
                        type="button"
                        onClick={() => void runAction(selectedThread.status === "closed" ? "reopen" : "close")}
                        disabled={busyAction !== null}
                        className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-50"
                      >
                        {selectedThread.status === "closed" ? "Ripristina" : "Archivia"}
                      </button>
                      <button
                        type="button"
                        onClick={() => void deleteChat()}
                        disabled={busyAction !== null}
                        className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-1.5 text-xs font-semibold text-rose-700 hover:bg-rose-100 disabled:opacity-50"
                      >
                        Elimina
                      </button>
                      <button
                        type="button"
                        disabled
                        title="TODO: associazione manuale in step successivo"
                        className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-1.5 text-xs font-semibold text-amber-700 opacity-70"
                      >
                        Associa a prenotazione
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        setNewChatMode(false);
                        setNewChatPhone("");
                        setNewChatName("");
                        setDraft("");
                      }}
                      className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50"
                    >
                      Annulla nuovo
                    </button>
                  )}
                </div>
                {!newChatMode && selectedThread?.match_status !== "matched" ? (
                  <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                    Messaggio non associato con certezza. Suggerimenti: {selectedThread?.match_suggestions?.length ?? 0}.
                  </div>
                ) : null}
              </div>

              <div className="flex-1 space-y-3 overflow-y-auto bg-slate-50 px-4 py-4">
                {messages.map((message) => {
                  const inbound = message.direction === "inbound";
                  return (
                    <div key={message.id} className={`flex ${inbound ? "justify-start" : "justify-end"}`}>
                      <div className={`max-w-[82%] rounded-2xl border px-3 py-2 shadow-sm ${
                        inbound ? "border-slate-200 bg-white text-slate-800" : "border-emerald-200 bg-emerald-50 text-emerald-900"
                      }`}>
                        <p className="whitespace-pre-wrap text-sm">{message.text_body || `[${message.message_type ?? "messaggio"}]`}</p>
                        {message.media_id ? (
                          <p className="mt-1 text-[11px] text-slate-400">Allegato: {message.media_mime_type ?? message.media_id}</p>
                        ) : null}
                        <div className="mt-2 flex flex-wrap items-center gap-2">
                          <p className="text-[10px] text-slate-400">{formatDate(message.timestamp ?? message.created_at)}</p>
                          {!inbound ? (
                            <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${messageStatusTone(message.status)}`}>
                              {messageStatusLabel(message.status)}
                            </span>
                          ) : null}
                        </div>
                        {!inbound && message.status === "failed" ? (
                          <p className="mt-1 text-[11px] text-rose-600">
                            {message.failure_reason ?? "Messaggio non consegnato. Verifica il numero o i permessi WhatsApp."}
                          </p>
                        ) : null}
                      </div>
                    </div>
                  );
                })}
                {messages.length === 0 ? (
                  <div className="py-16 text-center text-sm text-slate-400">
                    {newChatMode ? "La nuova conversazione apparira qui dopo il primo invio." : "Seleziona una conversazione."}
                  </div>
                ) : null}
              </div>

              <div className="border-t border-slate-100 bg-white px-4 py-3">
                <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3">
                  {newChatMode ? (
                    <div className="mb-3 grid gap-3 md:grid-cols-2">
                      <label className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                        Numero WhatsApp
                        <input
                          data-no-uppercase
                          value={newChatPhone}
                          onChange={(event) => setNewChatPhone(event.target.value)}
                          placeholder="+39 333 1234567"
                          className="input-saas mt-2 w-full"
                        />
                      </label>
                      <label className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                        Nome contatto
                        <input
                          data-no-uppercase
                          value={newChatName}
                          onChange={(event) => setNewChatName(event.target.value)}
                          placeholder="Nome cliente"
                          className="input-saas mt-2 w-full"
                        />
                      </label>
                    </div>
                  ) : null}
                  {latestFailedOutbound ? (
                    <div className="mb-3 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
                      Ultima risposta non consegnata: {latestFailedOutbound.failure_reason ?? "verifica numero o configurazione WhatsApp."}
                    </div>
                  ) : null}
                  <label htmlFor="whatsapp-reply" className="mb-2 block text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">
                    Rispondi su WhatsApp
                  </label>
                  <textarea
                    id="whatsapp-reply"
                    data-no-uppercase
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    placeholder="Scrivi la risposta al cliente..."
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
                  <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                    <p className="text-xs text-slate-500">
                      Il messaggio viene inviato al numero WhatsApp della conversazione e salvato nello storico.
                    </p>
                    <button
                      type="button"
                      onClick={() => void sendReply()}
                      disabled={busyAction !== null || !draft.trim() || (newChatMode && !newChatPhone.trim())}
                      className="rounded-xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:bg-slate-300"
                    >
                      {busyAction === "reply" ? "Invio..." : "Invia risposta"}
                    </button>
                  </div>
                </div>
              </div>
            </>
          ) : (
            <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-slate-400">
              {newChatMode ? "Inserisci numero e messaggio per avviare una nuova conversazione WhatsApp." : "Nessuna conversazione selezionata."}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
