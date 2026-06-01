"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/lib/supabase/client";
import { getWhatsAppConversationWindowState } from "@/lib/whatsapp-conversation-window";

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
  reply_to_wa_message_id?: string | null;
  direction: "inbound" | "outbound";
  message_type: string | null;
  template_name?: string | null;
  text_body: string | null;
  media_id: string | null;
  media_mime_type: string | null;
  media_filename?: string | null;
  status: string | null;
  failure_reason?: string | null;
  timestamp: string | null;
  created_at: string;
  booking_id: string | null;
  reply_to_message?: {
    id: string | null;
    wa_message_id: string | null;
    direction: "inbound" | "outbound" | null;
    message_type: string | null;
    template_name: string | null;
    preview: string;
  } | null;
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

type SendReplyPayload = {
  ok?: boolean;
  error?: string;
  thread_id?: string | null;
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

type ServiceSearchResult = {
  id: string;
  customer_name?: string | null;
  phone?: string | null;
  phone_e164?: string | null;
  date?: string | null;
  time?: string | null;
  booking_service_kind?: string | null;
  hotels?: { name?: string | null } | null;
};

const filters = [
  { value: "open", label: "Aperte" },
  { value: "needs_review", label: "Da rivedere" },
  { value: "associated", label: "Associate" },
  { value: "unassociated", label: "Non associate" },
  { value: "closed", label: "Chiuse" },
] as const;

const unsupportedManualHeaderFormats = new Set(["IMAGE", "VIDEO", "DOCUMENT", "LOCATION"]);

function isManualTemplateSupported(option: TemplateOption) {
  return !option.header_format || !unsupportedManualHeaderFormats.has(option.header_format.toUpperCase());
}

const quickEmojis = ["👍", "🙏", "😊", "🎉", "🚐", "📍", "⏰", "☎️"] as const;
const quickReplies = [
  "Arriviamo tra 5 minuti.",
  "Siamo al punto d'incontro indicato.",
  "Puoi inviarci la tua posizione?",
  "Ci chiami a questo numero, grazie.",
  "Perfetto, ti aspettiamo.",
] as const;

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

function fillTemplatePreview(bodyText: string, variables: string[]): string {
  let result = bodyText;
  for (let i = 0; i < Math.max(variables.length, 9); i++) {
    const val = variables[i]?.trim();
    result = result.replace(
      new RegExp(`\\{\\{${i + 1}\\}\\}`, "g"),
      val ? val : `{{${i + 1}}}`,
    );
  }
  return result;
}

async function getAccessToken() {
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

async function fetchWhatsAppMediaBlob(messageId: string) {
  const token = await getAccessToken();
  if (!token) throw new Error("Sessione non disponibile.");
  const response = await fetch(`/api/ops/whatsapp-media/${messageId}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(body?.error ?? "Impossibile aprire l'allegato WhatsApp.");
  }
  const blob = await response.blob();
  return {
    blob,
    contentType: response.headers.get("content-type") ?? blob.type ?? "application/octet-stream",
  };
}

function messageTypeLabel(message: MessageRow) {
  if (message.media_filename?.trim()) return message.media_filename.trim();
  if (message.message_type === "image") return "Foto ricevuta";
  if (message.message_type === "document") return "Documento ricevuto";
  if (message.message_type === "video") return "Video ricevuto";
  if (message.message_type === "audio") return "Audio ricevuto";
  return message.media_mime_type ?? message.media_id ?? "Allegato WhatsApp";
}

function attachmentKind(message: MessageRow) {
  if (message.media_mime_type?.startsWith("image/")) return "image";
  if (message.media_mime_type?.includes("pdf")) return "pdf";
  if (message.media_mime_type?.startsWith("audio/")) return "audio";
  if (message.media_mime_type?.startsWith("video/")) return "video";
  return "file";
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

function IconPaperclip() {
  return (
    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="m18.375 12.739-6.315 6.316a4.5 4.5 0 1 1-6.364-6.364l8.485-8.485a3 3 0 0 1 4.243 4.243l-8.486 8.485a1.5 1.5 0 1 1-2.121-2.121l7.425-7.425" />
    </svg>
  );
}

function IconImage() {
  return (
    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 7.5A2.25 2.25 0 0 1 6 5.25h12A2.25 2.25 0 0 1 20.25 7.5v9A2.25 2.25 0 0 1 18 18.75H6a2.25 2.25 0 0 1-2.25-2.25v-9Z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="m3.75 15.75 4.72-4.72a1.5 1.5 0 0 1 2.12 0l2.16 2.16a1.5 1.5 0 0 0 2.12 0l3.38-3.38a1.5 1.5 0 0 1 2.12 0" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 9h.008v.008h-.008V9Z" />
    </svg>
  );
}

function IconDocument() {
  return (
    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-8.25a2.25 2.25 0 0 0-2.25-2.25H8.25A2.25 2.25 0 0 0 6 6v12a2.25 2.25 0 0 0 2.25 2.25h6.75" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 3.75v4.5a.75.75 0 0 0 .75.75h4.5" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M15 18.75h6m-3-3v6" />
    </svg>
  );
}

function IconVolume() {
  return (
    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M11.25 5.25 6.75 9H4.5A1.5 1.5 0 0 0 3 10.5v3A1.5 1.5 0 0 0 4.5 15h2.25l4.5 3.75V5.25Z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 8.25a5.25 5.25 0 0 1 0 7.5M18.75 6a8.25 8.25 0 0 1 0 12" />
    </svg>
  );
}

function IconVideo() {
  return (
    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 10.5 20.25 7.5v9l-4.5-3m-9.75 4.5h9a2.25 2.25 0 0 0 2.25-2.25v-7.5A2.25 2.25 0 0 0 15 6h-9A2.25 2.25 0 0 0 3.75 8.25v7.5A2.25 2.25 0 0 0 6 18Z" />
    </svg>
  );
}

function IconDownload() {
  return (
    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v12m0 0 4.5-4.5M12 15l-4.5-4.5M4.5 19.5h15" />
    </svg>
  );
}

function WhatsAppMediaAttachment({
  message,
  onError,
}: {
  message: MessageRow;
  onError: (message: string) => void;
}) {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [blobMimeType, setBlobMimeType] = useState<string | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [busyAction, setBusyAction] = useState<"open" | "download" | null>(null);
  const [pdfViewerOpen, setPdfViewerOpen] = useState(false);
  const kind = attachmentKind(message);
  const isImage = kind === "image";
  const isPdf = kind === "pdf";
  const isAudio = kind === "audio";
  const isVideo = kind === "video";

  useEffect(() => {
    let active = true;

    async function loadPreview() {
      if (!message.media_id || (!isImage && !isAudio)) return;
      setLoadingPreview(true);
      try {
        const media = await fetchWhatsAppMediaBlob(message.id);
        if (!active) return;
        const nextUrl = URL.createObjectURL(media.blob);
        if (isImage) setPreviewUrl(nextUrl);
        setBlobUrl((current) => current ?? nextUrl);
        setBlobMimeType(media.contentType);
      } catch (error) {
        if (!active) return;
        console.warn("[whatsapp] media preview unavailable", {
          messageId: message.id,
          error: error instanceof Error ? error.message : "Impossibile caricare il media."
        });
      } finally {
        if (active) setLoadingPreview(false);
      }
    }

    void loadPreview();
    return () => {
      active = false;
    };
  }, [isAudio, isImage, message.id, message.media_id, onError]);

  useEffect(() => () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    if (blobUrl && blobUrl !== previewUrl) URL.revokeObjectURL(blobUrl);
  }, [blobUrl, previewUrl]);

  const ensureBlobUrl = useCallback(async () => {
    if (blobUrl) {
      return {
        url: blobUrl,
        mimeType: blobMimeType ?? message.media_mime_type ?? "application/octet-stream",
      };
    }
    const media = await fetchWhatsAppMediaBlob(message.id);
    const nextUrl = URL.createObjectURL(media.blob);
    setBlobUrl(nextUrl);
    setBlobMimeType(media.contentType);
    return { url: nextUrl, mimeType: media.contentType };
  }, [blobMimeType, blobUrl, message.id, message.media_mime_type]);

  const openAttachment = useCallback(async () => {
    if (!message.media_id || busyAction) return;
    setBusyAction("open");
    try {
      if (previewUrl && isImage) {
        window.open(previewUrl, "_blank", "noopener,noreferrer");
        return;
      }
      const media = await ensureBlobUrl();
      if (isPdf) {
        setPdfViewerOpen(true);
        return;
      }
      window.open(media.url, "_blank", "noopener,noreferrer");
    } catch (error) {
      onError(error instanceof Error ? error.message : "Impossibile aprire l'allegato WhatsApp.");
    } finally {
      setBusyAction(null);
    }
  }, [busyAction, ensureBlobUrl, isImage, isPdf, message.media_id, onError, previewUrl]);

  const downloadAttachment = useCallback(async () => {
    if (!message.media_id || busyAction) return;
    setBusyAction("download");
    try {
      const media = await ensureBlobUrl();
      const link = document.createElement("a");
      link.href = media.url;
      link.download = messageTypeLabel(message);
      document.body.appendChild(link);
      link.click();
      link.remove();
    } catch (error) {
      onError(error instanceof Error ? error.message : "Impossibile scaricare l'allegato WhatsApp.");
    } finally {
      setBusyAction(null);
    }
  }, [busyAction, ensureBlobUrl, message, onError]);

  if (!message.media_id) return null;

  const pillTone = isImage
    ? "bg-emerald-50 text-emerald-700"
    : isPdf
      ? "bg-rose-50 text-rose-700"
      : isAudio
        ? "bg-amber-50 text-amber-700"
        : isVideo
          ? "bg-violet-50 text-violet-700"
          : "bg-slate-100 text-slate-700";

  const AttachmentIcon = isImage ? IconImage : isPdf ? IconDocument : isAudio ? IconVolume : isVideo ? IconVideo : IconPaperclip;

  return (
    <div className="mt-2 rounded-2xl border border-slate-200/80 bg-slate-50/90 p-2.5">
      {pdfViewerOpen && blobUrl ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/55 p-4">
          <div className="flex h-[85vh] w-full max-w-5xl flex-col overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-2xl">
            <div className="flex items-center justify-between gap-3 border-b border-slate-100 px-5 py-4">
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-slate-900">{messageTypeLabel(message)}</p>
                <p className="mt-1 text-xs text-slate-500">Anteprima PDF WhatsApp</p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void downloadAttachment()}
                  className="rounded-full border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50"
                >
                  Scarica
                </button>
                <button
                  type="button"
                  onClick={() => setPdfViewerOpen(false)}
                  className="rounded-full border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50"
                >
                  Chiudi
                </button>
              </div>
            </div>
            <iframe src={blobUrl} title={messageTypeLabel(message)} className="min-h-0 flex-1 bg-slate-100" />
          </div>
        </div>
      ) : null}

      {isImage ? (
        <button
          type="button"
          onClick={() => void openAttachment()}
          className="group block w-full overflow-hidden rounded-xl border border-slate-200 bg-white"
        >
          {previewUrl ? (
            <img
              src={previewUrl}
              alt={message.text_body?.trim() || "Immagine WhatsApp"}
              className="max-h-72 w-full object-cover transition-transform duration-200 group-hover:scale-[1.01]"
            />
          ) : (
            <div className="flex h-32 items-center justify-center text-xs text-slate-400">
              {loadingPreview ? "Caricamento anteprima..." : "Apri immagine"}
            </div>
          )}
        </button>
      ) : null}

      {isAudio ? (
        <div className="rounded-xl border border-amber-100 bg-amber-50/60 px-3 py-2.5">
          <div className="flex items-center gap-2 mb-2">
            <span className="inline-flex rounded-full p-1.5 bg-amber-100 text-amber-600">
              <IconVolume />
            </span>
            <p className="text-xs font-semibold text-amber-800">Messaggio vocale</p>
          </div>
          {blobUrl ? (
            <audio controls src={blobUrl} className="w-full" style={{ accentColor: "#d97706" }} />
          ) : (
            <div className="flex items-center gap-2 rounded-lg border border-amber-200 bg-white px-3 py-2 text-xs text-amber-600">
              <div className="h-3 w-3 animate-spin rounded-full border-2 border-amber-200 border-t-amber-500 shrink-0" />
              Caricamento vocale…
            </div>
          )}
        </div>
      ) : !isImage ? (
        <div className="rounded-xl border border-slate-200 bg-white px-3 py-2">
          <div className="flex items-start gap-2">
            <span className={`mt-0.5 inline-flex rounded-full p-1.5 ${pillTone}`}>
              <AttachmentIcon />
            </span>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-slate-800">{messageTypeLabel(message)}</p>
              <p className="mt-0.5 text-[11px] text-slate-400">
                {message.media_mime_type ?? "Allegato WhatsApp"}
              </p>
            </div>
          </div>
        </div>
      ) : null}

      <div className={`flex flex-wrap items-center gap-2 ${isImage ? "mt-2" : "mt-2.5"}`}>
        <span className={`inline-flex items-center gap-1 rounded-full px-2 py-1 text-[11px] font-medium ${pillTone}`}>
          <AttachmentIcon />
          {isImage ? "Foto" : isPdf ? "PDF" : isAudio ? "Audio" : isVideo ? "Video" : "File"}
        </span>
        {!isAudio && (
        <button
          type="button"
          onClick={() => void openAttachment()}
          disabled={Boolean(busyAction)}
          className="rounded-full border border-sky-200 bg-sky-50 px-2.5 py-1 text-[11px] font-semibold text-sky-700 hover:bg-sky-100 disabled:opacity-50"
        >
          {busyAction === "open" ? "Apertura..." : isPdf ? "Apri PDF" : "Apri allegato"}
        </button>
        )}
        <button
          type="button"
          onClick={() => void downloadAttachment()}
          disabled={Boolean(busyAction)}
          className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-white px-2.5 py-1 text-[11px] font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
        >
          <IconDownload />
          {busyAction === "download" ? "Scaricamento..." : "Scarica"}
        </button>
      </div>
    </div>
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
  const [associateMode, setAssociateMode] = useState(false);
  const [associateQuery, setAssociateQuery] = useState("");
  const [associateResults, setAssociateResults] = useState<ServiceSearchResult[]>([]);
  const [associateLoading, setAssociateLoading] = useState(false);
  const [phoneEditThreadId, setPhoneEditThreadId] = useState<string | null>(null);
  const [phoneDraft, setPhoneDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notifPermission, setNotifPermission] = useState<NotificationPermission>(
    typeof Notification !== "undefined" ? Notification.permission : "default",
  );
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [mobileView, setMobileView] = useState<"list" | "chat">("list");
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const messagesContainerRef = useRef<HTMLDivElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const shouldStickToBottomRef = useRef(true);
  const lastRenderedMessageKeyRef = useRef<string>("");
  const prevThreadLastMsgRef = useRef<Map<string, string>>(new Map());

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
  const conversationWindow = useMemo(
    () => getWhatsAppConversationWindowState(latestInboundAt),
    [latestInboundAt],
  );
  const selectedTemplate = useMemo(
    () => templateOptions.find((option) => option.key === selectedTemplateKey) ?? templateOptions[0] ?? null,
    [selectedTemplateKey, templateOptions],
  );
  const sortedTemplateOptions = useMemo(() => {
    const approved = templateOptions.filter((option) => option.status === "APPROVED");
    const source = approved.length > 0 ? approved : templateOptions;
    return [...source].sort((a, b) => {
      const aSupported = isManualTemplateSupported(a) ? 0 : 1;
      const bSupported = isManualTemplateSupported(b) ? 0 : 1;
      if (aSupported !== bSupported) return aSupported - bSupported;
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
  const textModeUnavailable = newChatMode || !conversationWindow.isOpen;
  const templateVariables = useMemo(() => {
    if (!selectedTemplate?.body_parameter_count) return [];
    const lines = templateVariablesText.split(/\r?\n/);
    return Array.from({ length: selectedTemplate.body_parameter_count }, (_, index) => (lines[index] ?? "").trim());
  }, [selectedTemplate?.body_parameter_count, templateVariablesText]);
  const selectedTemplateHasUnsupportedHeader = Boolean(
    selectedTemplate?.header_format &&
    unsupportedManualHeaderFormats.has(selectedTemplate.header_format.toUpperCase()),
  );
  const selectedTemplateHasMissingVariables = selectedTemplate?.body_parameter_count
    ? templateVariables.some((value) => !value)
    : false;
  const lastFailureRequiresTemplate = useMemo(() => {
    const reason = (latestFailedOutbound?.failure_reason ?? "").toLowerCase();
    return reason.includes("131047") || reason.includes("re-engagement");
  }, [latestFailedOutbound]);
  const latestMessageKey = useMemo(
    () => (messages.length > 0 ? `${messages[messages.length - 1]?.id}:${messages.length}` : "empty"),
    [messages],
  );
  const windowStatusText = useMemo(() => {
    if (newChatMode) {
      return "Per aprire una nuova conversazione WhatsApp serve un template approvato.";
    }
    if (!latestInboundAt) {
      return "Non risultano messaggi ricevuti dal cliente in questa conversazione. Per scrivere devi usare un template approvato.";
    }
    if (!conversationWindow.isOpen) {
      return "Sono passate più di 24 ore dall’ultimo messaggio del cliente. Per poter scrivere devi usare un template approvato.";
    }
    return "Puoi rispondere con messaggio libero.";
  }, [conversationWindow.isOpen, latestInboundAt, newChatMode]);

  const scrollToLatestMessage = useCallback((behavior: ScrollBehavior = "smooth") => {
    shouldStickToBottomRef.current = true;
    setShowJumpToLatest(false);
    bottomRef.current?.scrollIntoView({ behavior, block: "end" });
  }, []);

  const updateScrollState = useCallback(() => {
    const container = messagesContainerRef.current;
    if (!container) return;
    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    const nearBottom = distanceFromBottom <= 96;
    shouldStickToBottomRef.current = nearBottom;
    if (nearBottom) {
      setShowJumpToLatest(false);
    }
  }, []);

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
      const keepNewChatDraft = newChatMode && !nextThreadId;
      const nextSelectedThreadId = keepNewChatDraft ? null : body.selected_thread_id ?? null;
      const prevMsgMap = prevThreadLastMsgRef.current;
      for (const thread of (body.threads ?? [])) {
        const prevLastAt = prevMsgMap.get(thread.id);
        const currentLastAt = thread.last_message_at ?? "";
        if (prevLastAt !== undefined && prevLastAt !== currentLastAt && thread.unread_count > 0 &&
            (document.hidden || thread.id !== nextSelectedThreadId)) {
          if (typeof Notification !== "undefined" && Notification.permission === "granted") {
            const name = thread.whatsapp_contacts?.profile_name || thread.service?.customer_name || thread.phone_e164 || thread.wa_id || "Cliente";
            new Notification("Nuovo messaggio WhatsApp", {
              body: `${name}: ${thread.last_message_preview ?? "Messaggio ricevuto"}`,
              icon: "/favicon.ico",
              tag: `wa-thread-${thread.id}`,
              renotify: true,
            } as unknown as NotificationOptions);
          }
        }
        prevMsgMap.set(thread.id, currentLastAt);
      }
      setThreads(body.threads ?? []);
      setMessages(keepNewChatDraft ? [] : body.messages ?? []);
      setTemplateOptions(body.template_options ?? []);
      setTemplateFetchError(body.template_fetch_error ?? "");
      setSelectedTemplateKey((current) => {
        const available = body.template_options ?? [];
        if (available.some((item) => item.key === current)) return current;
        return available.find((item) => item.status === "APPROVED" && isManualTemplateSupported(item))?.key
          ?? available.find(isManualTemplateSupported)?.key
          ?? available[0]?.key
          ?? "";
      });
      setSelectedThreadId(nextSelectedThreadId);
      if (nextSelectedThreadId !== selectedThreadId) {
        setDraft("");
        setTemplateVariablesText("");
      }
      setLoading(false);
    },
    [filter, newChatMode, search, selectedThreadId],
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
    const params = new URLSearchParams(window.location.search);
    const threadParam = params.get("thread") ?? params.get("thread_id");
    const newPhoneParam = params.get("new");
    const nameParam = params.get("name");
    if (newPhoneParam) {
      setNewChatMode(true);
      setSelectedThreadId(null);
      setNewChatPhone(newPhoneParam);
      setNewChatName(nameParam ?? "");
      setComposerMode("template");
      setTemplateVariablesText("");
      setMobileView("chat");
      return;
    }
    if (threadParam) {
      setNewChatMode(false);
      setSelectedThreadId(threadParam);
      setMobileView("chat");
    }
  }, []);

  useEffect(() => {
    if (typeof Notification === "undefined") return;
    const timeout = window.setTimeout(() => setNotifPermission(Notification.permission), 0);
    if (Notification.permission === "default") {
      void Notification.requestPermission().then((perm) => setNotifPermission(perm));
    }
    return () => window.clearTimeout(timeout);
  }, []);

  useEffect(() => {
    const timeout = window.setTimeout(() => void load(selectedThreadId), 250);
    return () => window.clearTimeout(timeout);
  }, [filter, search, selectedThreadId, load]);

  useEffect(() => {
    if (!selectedThreadId) return;
    const interval = window.setInterval(() => { void load(selectedThreadId); }, 12000);
    return () => window.clearInterval(interval);
  }, [selectedThreadId, load]);

  useEffect(() => {
    if (selectedThreadId) return;
    const interval = window.setInterval(() => { void load(null); }, 20000);
    return () => window.clearInterval(interval);
  }, [selectedThreadId, load]);

  useEffect(() => {
    shouldStickToBottomRef.current = true;
    const frame = window.requestAnimationFrame(() => setShowJumpToLatest(false));
    return () => window.cancelAnimationFrame(frame);
  }, [selectedThreadId, newChatMode]);

  useEffect(() => {
    if (mobileView !== "chat") return;
    if (!selectedThreadId && !newChatMode) return;
    shouldStickToBottomRef.current = true;
    let secondFrame = 0;
    const firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => {
        const container = messagesContainerRef.current;
        if (container) {
          container.scrollTop = container.scrollHeight;
        }
        scrollToLatestMessage("auto");
      });
    });
    return () => {
      window.cancelAnimationFrame(firstFrame);
      if (secondFrame) window.cancelAnimationFrame(secondFrame);
    };
  }, [mobileView, newChatMode, scrollToLatestMessage, selectedThreadId]);

  useEffect(() => {
    const changed = lastRenderedMessageKeyRef.current !== latestMessageKey;
    lastRenderedMessageKeyRef.current = latestMessageKey;
    if (!changed) return;
    const frame = window.requestAnimationFrame(() => {
      if (shouldStickToBottomRef.current) {
        scrollToLatestMessage(messages.length > 1 ? "smooth" : "auto");
      } else if (messages.length > 0) {
        setShowJumpToLatest(true);
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [latestMessageKey, messages.length, scrollToLatestMessage]);

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
    const body = (await response.json().catch(() => null)) as SendReplyPayload | null;
    if (!response.ok || !body?.ok) {
      setError(body?.error ?? "Azione non riuscita.");
    } else {
      await load(selectedThreadId);
    }
    setBusyAction(null);
  };

  const saveThreadPhone = async () => {
    if (!selectedThreadId) return;
    const nextPhone = phoneDraft.trim();
    if (nextPhone.length < 6) {
      setError("Inserisci un numero di telefono valido.");
      return;
    }
    const token = await getAccessToken();
    if (!token) return;
    setBusyAction("update_phone");
    setError("");
    try {
      const response = await fetch("/api/ops/whatsapp-inbox", {
        method: "PATCH",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ thread_id: selectedThreadId, action: "update_phone", phone: nextPhone }),
      });
      const body = (await response.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      if (!response.ok || !body?.ok) {
        setError(body?.error ?? "Aggiornamento numero non riuscito.");
      } else {
        setPhoneEditThreadId(null);
        await load(selectedThreadId);
      }
    } finally {
      setBusyAction(null);
    }
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
    const body = (await response.json().catch(() => null)) as SendReplyPayload | null;
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

  const searchServicesForAssociation = async (queryOverride?: string) => {
    const q = (queryOverride ?? associateQuery).trim();
    if (q.length < 2) {
      setAssociateResults([]);
      return;
    }
    const token = await getAccessToken();
    if (!token) return;
    setAssociateLoading(true);
    setError("");
    try {
      const response = await fetch(`/api/ops/whatsapp-inbox/search-services?q=${encodeURIComponent(q)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const body = (await response.json().catch(() => null)) as { services?: ServiceSearchResult[]; error?: string } | null;
      if (!response.ok) {
        setError(body?.error ?? "Ricerca prenotazioni non riuscita.");
        setAssociateResults([]);
      } else {
        setAssociateResults(body?.services ?? []);
      }
    } finally {
      setAssociateLoading(false);
    }
  };

  const associateBooking = async (bookingId: string | null) => {
    if (!selectedThreadId) return;
    const token = await getAccessToken();
    if (!token) return;
    setBusyAction("associate");
    setError("");
    try {
      const response = await fetch("/api/ops/whatsapp-inbox", {
        method: "PATCH",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ thread_id: selectedThreadId, action: "associate", booking_id: bookingId }),
      });
      const body = (await response.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      if (!response.ok || !body?.ok) {
        setError(body?.error ?? "Associazione prenotazione non riuscita.");
      } else {
        setAssociateMode(false);
        setAssociateResults([]);
        await load(selectedThreadId);
      }
    } finally {
      setBusyAction(null);
    }
  };

  const sendReply = async () => {
    if (!composerEnabled) return;
    const text = draft.trim();
    if (composerMode === "text" && !text) { setError("Inserisci un messaggio prima di inviare."); return; }
    if (composerMode === "text" && textModeUnavailable) {
      setError("La finestra WhatsApp di 24 ore è chiusa. Usa un template approvato per contattare il cliente.");
      return;
    }
    if (composerMode === "template" && !selectedTemplate) { setError("Seleziona un template prima di inviare."); return; }
    if (composerMode === "template" && selectedTemplateHasUnsupportedHeader) {
      setError("Questo template richiede un header media. Usa un template solo testo per l'invio manuale dalla inbox.");
      return;
    }
    if (composerMode === "template" && selectedTemplateHasMissingVariables) {
      setError("Compila tutte le variabili richieste dal template prima di inviare.");
      return;
    }
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
    const body = (await response.json().catch(() => null)) as SendReplyPayload | null;
    if (!response.ok || !body?.ok) {
      setError(body?.error ?? "Invio messaggio non riuscito.");
    } else {
      shouldStickToBottomRef.current = true;
      setDraft("");
      setTemplateVariablesText("");
      if (newChatMode) {
        setNewChatMode(false);
        setNewChatPhone("");
        setNewChatName("");
        await load(body.thread_id ?? null);
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
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="mb-1 flex items-center gap-1.5 text-xs text-slate-400">
              <span>Operazioni</span>
              <span>/</span>
              <span className="font-medium text-slate-600">WhatsApp</span>
            </div>
            <h1 className="text-xl font-bold text-slate-900">Inbox WhatsApp</h1>
            <p className="mt-0.5 text-sm text-slate-500">Risposte clienti ricevute da WhatsApp Business Platform.</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => {
              setNewChatMode(true);
              setSelectedThreadId(null);
              setMessages([]);
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

          {/* Notification status pill */}
          {notifPermission === "granted" ? (
            <span className="flex shrink-0 items-center gap-1.5 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-700">
              <svg className="h-3.5 w-3.5" fill="currentColor" viewBox="0 0 20 20">
                <path d="M10 2a6 6 0 0 0-6 6v3.586l-.707.707A1 1 0 0 0 4 14h12a1 1 0 0 0 .707-1.707L16 11.586V8a6 6 0 0 0-6-6ZM10 18a3 3 0 0 1-2.83-2h5.66A3 3 0 0 1 10 18Z" />
              </svg>
              Notifiche attive
            </span>
          ) : (
            <button
              type="button"
              onClick={() => {
                if (typeof Notification === "undefined") return;
                if (Notification.permission === "denied") {
                  alert("Le notifiche sono bloccate dal browser.\n\nClicca sull'icona 🔒 (o ⚠️) a sinistra della barra URL → Impostazioni sito → Notifiche → Consenti.\nPoi ricarica la pagina.");
                  return;
                }
                void Notification.requestPermission().then((perm) => setNotifPermission(perm));
              }}
              className="flex shrink-0 items-center gap-1.5 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-700 transition hover:bg-amber-100"
            >
              <svg className="h-3.5 w-3.5" fill="currentColor" viewBox="0 0 20 20">
                <path d="M10 2a6 6 0 0 0-6 6v3.586l-.707.707A1 1 0 0 0 4 14h12a1 1 0 0 0 .707-1.707L16 11.586V8a6 6 0 0 0-6-6ZM10 18a3 3 0 0 1-2.83-2h5.66A3 3 0 0 1 10 18Z" />
              </svg>
              {notifPermission === "denied" ? "Notifiche bloccate" : "Abilita notifiche"}
            </button>
          )}
          </div>
        </div>

        {/* ── Filter tabs + search ── */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-slate-400">
              <IconSearch />
            </span>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="input-saas w-48 pl-9 sm:w-56"
              placeholder="Cerca nome, telefono…"
            />
          </div>
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
                    setComposerMode("text");
                    shouldStickToBottomRef.current = true;
                    setShowJumpToLatest(false);
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
                          {phoneEditThreadId === selectedThread.id ? (
                            <div className="flex flex-wrap items-center gap-1.5">
                              <input
                                data-no-uppercase
                                type="tel"
                                value={phoneDraft}
                                onChange={(e) => setPhoneDraft(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") void saveThreadPhone();
                                  if (e.key === "Escape") {
                                    setPhoneDraft(selectedThread.phone_e164 ?? selectedThread.wa_id ?? "");
                                    setPhoneEditThreadId(null);
                                  }
                                }}
                                placeholder="+49 172 5404319"
                                disabled={busyAction !== null}
                                className="h-7 w-44 rounded-lg border border-slate-200 bg-white px-2 font-mono text-[11px] text-slate-700 outline-none transition focus:border-emerald-300 focus:ring-2 focus:ring-emerald-100 disabled:bg-slate-100"
                                aria-label="Numero WhatsApp internazionale"
                                title="Inserisci il numero con prefisso internazionale, es. +49 172 5404319"
                              />
                              <button
                                type="button"
                                onClick={() => void saveThreadPhone()}
                                disabled={busyAction !== null || !phoneDraft.trim()}
                                className="rounded-lg bg-emerald-600 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:bg-slate-300"
                              >
                                {busyAction === "update_phone" ? "..." : "Salva"}
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  setPhoneDraft(selectedThread.phone_e164 ?? selectedThread.wa_id ?? "");
                                  setPhoneEditThreadId(null);
                                }}
                                disabled={busyAction !== null}
                                className="rounded-lg border border-slate-200 px-2.5 py-1 text-[11px] font-semibold text-slate-500 hover:bg-slate-50 disabled:opacity-50"
                              >
                                Annulla
                              </button>
                            </div>
                          ) : (
                            <button
                              type="button"
                              onClick={() => {
                                setPhoneDraft(selectedThread.phone_e164 ?? selectedThread.wa_id ?? "");
                                setPhoneEditThreadId(selectedThread.id);
                              }}
                              disabled={busyAction !== null}
                              className="rounded-lg border border-slate-200 bg-white px-2 py-1 font-mono text-[11px] text-slate-500 transition hover:border-emerald-300 hover:bg-emerald-50 hover:text-emerald-700 disabled:opacity-50"
                              title="Modifica numero WhatsApp"
                            >
                              {selectedThread.phone_e164 ?? selectedThread.wa_id ?? "Aggiungi numero"}
                            </button>
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
                        onClick={() => {
                          const initialQuery =
                            selectedThread.service?.customer_name ||
                            selectedThread.phone_e164 ||
                            selectedThread.whatsapp_contacts?.profile_name ||
                            selectedThread.wa_id;
                          setAssociateMode((current) => !current);
                          setAssociateQuery(initialQuery ?? "");
                          if (initialQuery) void searchServicesForAssociation(initialQuery);
                        }}
                        disabled={busyAction !== null}
                        title="Cerca e associa una prenotazione"
                        className="flex items-center gap-1.5 rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-1.5 text-xs font-semibold text-emerald-700 hover:bg-emerald-100 disabled:opacity-50"
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

                {!newChatMode && selectedThread && associateMode && (
                  <div className="mt-3 rounded-xl border border-emerald-200 bg-emerald-50/60 p-3">
                    <div className="flex flex-col gap-2 sm:flex-row">
                      <input
                        data-no-uppercase
                        value={associateQuery}
                        onChange={(e) => setAssociateQuery(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") void searchServicesForAssociation();
                        }}
                        placeholder="Cerca per nome, telefono o numero prenotazione"
                        className="input-saas flex-1"
                      />
                      <button
                        type="button"
                        onClick={() => void searchServicesForAssociation()}
                        disabled={associateLoading || associateQuery.trim().length < 2}
                        className="rounded-lg bg-emerald-600 px-3 py-2 text-xs font-semibold text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:bg-slate-300"
                      >
                        {associateLoading ? "Ricerca..." : "Cerca"}
                      </button>
                      {selectedThread.booking_id && (
                        <button
                          type="button"
                          onClick={() => void associateBooking(null)}
                          disabled={busyAction !== null}
                          className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-50"
                        >
                          Rimuovi
                        </button>
                      )}
                    </div>
                    <div className="mt-2 max-h-44 overflow-y-auto rounded-lg border border-emerald-100 bg-white">
                      {associateResults.length > 0 ? associateResults.map((service) => (
                        <button
                          key={service.id}
                          type="button"
                          onClick={() => void associateBooking(service.id)}
                          disabled={busyAction !== null}
                          className="flex w-full items-center justify-between gap-3 border-b border-slate-100 px-3 py-2 text-left text-xs last:border-b-0 hover:bg-emerald-50 disabled:opacity-50"
                        >
                          <span className="min-w-0">
                            <span className="block truncate font-semibold text-slate-800">{service.customer_name ?? "Cliente senza nome"}</span>
                            <span className="block truncate text-slate-500">
                              {[service.date, String(service.time ?? "").slice(0, 5), service.hotels?.name, service.phone_e164 ?? service.phone].filter(Boolean).join(" · ")}
                            </span>
                          </span>
                          <span className="shrink-0 rounded-full bg-emerald-100 px-2 py-1 font-semibold text-emerald-700">Associa</span>
                        </button>
                      )) : (
                        <p className="px-3 py-3 text-xs text-slate-500">
                          {associateQuery.trim().length >= 2 ? "Nessuna prenotazione trovata." : "Inserisci almeno 2 caratteri."}
                        </p>
                      )}
                    </div>
                  </div>
                )}
              </div>

              {/* Messages area */}
              <div className="relative border-b border-slate-100 bg-slate-50">
                <div
                  ref={messagesContainerRef}
                  onScroll={updateScrollState}
                  className="h-[42vh] min-h-[280px] overflow-y-auto px-4 py-4 lg:h-[48vh]"
                  style={{ scrollbarGutter: "stable" }}
                >
                  <div className="space-y-3">
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
                        {inbound && message.reply_to_wa_message_id && (
                          <div className="mb-2 rounded-lg border-l-2 border-emerald-400 bg-emerald-50/80 px-2.5 py-1.5">
                            <p className="text-[10px] font-semibold uppercase tracking-wide text-emerald-700">
                              In risposta a {message.reply_to_message?.template_name ? `template ${message.reply_to_message.template_name}` : "messaggio"}
                            </p>
                            <p className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-emerald-900">
                              {message.reply_to_message?.preview || "Messaggio originale non trovato"}
                            </p>
                          </div>
                        )}
                        <p className={`whitespace-pre-wrap text-sm leading-relaxed ${inbound ? "text-slate-800" : failed ? "text-rose-800" : "text-indigo-900"}`}>
                          {message.text_body || `[${message.message_type ?? "messaggio"}]`}
                        </p>
                        {message.media_id && (
                          <WhatsAppMediaAttachment
                            message={message}
                            onError={(nextError) => setError(nextError)}
                          />
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
                    <div ref={bottomRef} />
                  </div>
                </div>
                {showJumpToLatest && messages.length > 0 && (
                  <button
                    type="button"
                    onClick={() => scrollToLatestMessage("smooth")}
                    className="absolute bottom-4 right-4 rounded-full border border-emerald-200 bg-white px-3 py-2 text-xs font-semibold text-emerald-700 shadow-lg transition hover:border-emerald-300 hover:bg-emerald-50"
                  >
                    Vai all’ultimo messaggio
                  </button>
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
                        {windowStatusText}
                      </span>
                      <button
                        type="button"
                        onClick={() => setComposerMode("template")}
                        className="shrink-0 rounded-full border border-amber-300 bg-white px-2.5 py-1 text-[11px] font-semibold text-amber-800 hover:bg-amber-100"
                      >
                        Usa template
                      </button>
                    </div>
                  )}

                  {!newChatMode && selectedThread && (
                    <div className="mb-3 flex flex-wrap items-center gap-2">
                      <span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${conversationWindow.isOpen ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-800"}`}>
                        {conversationWindow.isOpen ? "Finestra WhatsApp aperta" : "Finestra WhatsApp chiusa"}
                      </span>
                      <span className="text-xs text-slate-500">
                        {conversationWindow.isOpen
                          ? "Puoi rispondere con messaggio libero."
                          : latestInboundAt
                            ? `Ultimo messaggio cliente: ${formatDate(latestInboundAt)}`
                            : "Nessun messaggio inbound cliente disponibile."}
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
                        disabled={busyAction === "reply" || (mode.value === "text" && newChatMode)}
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

                  {/* Template studio */}
                  {composerMode === "template" ? (
                    <div className="space-y-3">
                      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
                        {/* Header compatto */}
                        <div className="flex items-center justify-between gap-4 border-b border-slate-100 bg-slate-50/60 px-4 py-3">
                          <div className="flex items-center gap-2.5">
                            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-emerald-600 text-white">
                              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 8.25h9m-9 3H12m-9.75 1.51c0 1.6 1.123 2.994 2.707 3.227 1.129.166 2.27.293 3.423.379.35.026.67.21.865.501L12 21l2.755-4.133a1.14 1.14 0 0 1 .865-.501 48.172 48.172 0 0 0 3.423-.379c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0 0 12 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018Z" />
                              </svg>
                            </div>
                            <div>
                              <p className="text-sm font-semibold text-slate-900">Template approvati</p>
                              <p className="text-[11px] text-slate-500">Seleziona e invia al cliente</p>
                            </div>
                          </div>
                          <div className="flex items-center gap-3 text-xs">
                            <span className="flex items-center gap-1 rounded-full bg-emerald-50 px-2.5 py-1 font-semibold text-emerald-700">
                              🇮🇹 {sortedTemplateOptions.filter((o) => o.language_code === "it").length}
                            </span>
                            <span className="flex items-center gap-1 rounded-full bg-slate-100 px-2.5 py-1 font-semibold text-slate-600">
                              🇬🇧 {sortedTemplateOptions.filter((o) => o.language_code !== "it").length}
                            </span>
                            <span className="rounded-full bg-slate-100 px-2.5 py-1 font-semibold text-slate-500">
                              {sortedTemplateOptions.length} tot
                            </span>
                          </div>
                        </div>

                        <div className="grid xl:grid-cols-[minmax(0,1fr)_300px]">
                          {/* Lista template */}
                          <div className="max-h-[300px] divide-y divide-slate-100 overflow-y-auto">
                            {sortedTemplateOptions.map((option) => {
                              const active = selectedTemplate?.key === option.key;
                              const accentColor = option.template.includes("aeroporto")
                                ? "bg-sky-500"
                                : option.template.includes("stazione")
                                  ? "bg-amber-500"
                                  : option.template.includes("medmar")
                                    ? "bg-indigo-500"
                                    : option.template.includes("snav")
                                      ? "bg-teal-500"
                                      : option.template.includes("reminder") || option.template.includes("48h")
                                        ? "bg-violet-500"
                                        : option.template.includes("assistenza") || option.template.includes("customer")
                                          ? "bg-rose-500"
                                          : "bg-slate-400";
                              return (
                                <button
                                  key={option.key}
                                  type="button"
                                  onClick={() => setSelectedTemplateKey(option.key)}
                                  disabled={busyAction === "reply"}
                                  className={`group relative flex w-full items-stretch gap-0 text-left transition ${
                                    active ? "bg-emerald-50" : "bg-white hover:bg-slate-50/80"
                                  }`}
                                >
                                  {/* Accent bar sinistra */}
                                  <div className={`w-1 shrink-0 rounded-none ${active ? accentColor : "bg-transparent group-hover:bg-slate-200"} transition`} />

                                  <div className="flex flex-1 items-center gap-3 px-3 py-2.5">
                                    {/* Icona tonda */}
                                    <div className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold text-white ${accentColor}`}>
                                      {templateFriendlyLabel(option.template).charAt(0).toUpperCase()}
                                    </div>

                                    <div className="min-w-0 flex-1">
                                      {/* Nome + lingua + badge */}
                                      <div className="flex flex-wrap items-center gap-1.5">
                                        <span className={`text-sm font-semibold leading-tight ${active ? "text-emerald-800" : "text-slate-800"}`}>
                                          {templateFriendlyLabel(option.template)}
                                        </span>
                                        <span className="text-xs">{option.language_code === "it" ? "🇮🇹" : "🇬🇧"}</span>
                                        {option.is_tenant_default && (
                                          <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-amber-700">Default</span>
                                        )}
                                        <span className={`rounded-full px-1.5 py-0.5 text-[9px] font-semibold ${active ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-400"}`}>
                                          {option.body_parameter_count} var
                                        </span>
                                      </div>

                                      {/* Body preview — 1 riga */}
                                      {option.body_text ? (
                                        <p className={`mt-0.5 truncate text-xs ${active ? "text-emerald-700/80" : "text-slate-500"}`}>
                                          {option.body_text.slice(0, 120)}
                                        </p>
                                      ) : (
                                        <p className="mt-0.5 font-mono text-[10px] text-slate-400 truncate">{option.template}</p>
                                      )}
                                    </div>

                                    {/* Checkmark */}
                                    <div className="shrink-0">
                                      {active ? (
                                        <div className="flex h-5 w-5 items-center justify-center rounded-full bg-emerald-500">
                                          <svg className="h-3 w-3 text-white" fill="currentColor" viewBox="0 0 20 20">
                                            <path fillRule="evenodd" d="M16.704 4.153a.75.75 0 0 1 .143 1.052l-8 10.5a.75.75 0 0 1-1.127.075l-4.5-4.5a.75.75 0 0 1 1.06-1.06l3.894 3.893 7.48-9.817a.75.75 0 0 1 1.05-.143Z" clipRule="evenodd" />
                                          </svg>
                                        </div>
                                      ) : (
                                        <div className="h-5 w-5 rounded-full border-2 border-slate-200 transition group-hover:border-emerald-300" />
                                      )}
                                    </div>
                                  </div>
                                </button>
                              );
                            })}
                          </div>

                          {/* Preview panel — stile bolla WhatsApp */}
                          {selectedTemplate && (
                            <div className="flex flex-col border-l border-slate-100 bg-[#ece5dd]">
                              <div className="flex items-center gap-2 border-b border-black/10 bg-[#075e54] px-4 py-2.5">
                                <div className="flex h-7 w-7 items-center justify-center rounded-full bg-white/20 text-xs font-bold text-white">
                                  {templateFriendlyLabel(selectedTemplate.template).charAt(0)}
                                </div>
                                <div>
                                  <p className="text-xs font-semibold text-white">{templateFriendlyLabel(selectedTemplate.template)}</p>
                                  <p className="text-[10px] text-white/70">{templateLanguageLabel(selectedTemplate.language_code)}</p>
                                </div>
                                <span className="ml-auto rounded-full bg-emerald-400/20 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wide text-emerald-200">
                                  {selectedTemplate.status}
                                </span>
                              </div>
                              <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-4">
                                {/* Bolla messaggio WhatsApp */}
                                <div className="max-w-[88%] self-start">
                                  <div className="relative rounded-2xl rounded-tl-none bg-white px-3.5 py-2.5 shadow-sm">
                                    <div className="absolute -left-1.5 top-0 h-3 w-3 overflow-hidden">
                                      <div className="absolute right-0 top-0 h-full w-full origin-top-right -rotate-45 bg-white" />
                                    </div>
                                    {selectedTemplate.header_format && selectedTemplate.header_format !== "NONE" && (
                                      <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                                        Header: {selectedTemplate.header_format}
                                      </p>
                                    )}
                                    <p className="whitespace-pre-wrap text-sm leading-relaxed text-slate-800">
                                      {fillTemplatePreview(
                                        selectedTemplate.body_text ?? "Testo del template non disponibile.",
                                        templateVariablesText.split(/\r?\n/).map((v) => v.trim()),
                                      )}
                                    </p>
                                    <p className="mt-1.5 text-right text-[10px] text-slate-400">ora ✓✓</p>
                                  </div>
                                </div>
                                {/* Metadati */}
                                <div className="mt-auto space-y-1.5 rounded-xl border border-black/10 bg-white/60 p-3 text-xs">
                                  <div className="flex justify-between text-slate-600">
                                    <span className="text-slate-400">Variabili</span>
                                    <span className="font-semibold">{selectedTemplate.body_parameter_count}</span>
                                  </div>
                                  <div className="flex justify-between text-slate-600">
                                    <span className="text-slate-400">Categoria</span>
                                    <span className="font-semibold">{selectedTemplate.category ?? "—"}</span>
                                  </div>
                                  <div className="flex justify-between text-slate-600">
                                    <span className="text-slate-400">Nome API</span>
                                    <span className="font-mono text-[10px] text-slate-500">{selectedTemplate.template}</span>
                                  </div>
                                  {(selectedTemplate.is_tenant_default || selectedTemplate.is_tenant_arrival) && (
                                    <div className="flex flex-wrap gap-1 pt-1">
                                      {selectedTemplate.is_tenant_default && <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[9px] font-bold text-amber-700">Default tenant</span>}
                                      {selectedTemplate.is_tenant_arrival && <span className="rounded-full bg-sky-100 px-2 py-0.5 text-[9px] font-bold text-sky-700">Arrivi tenant</span>}
                                    </div>
                                  )}
                                </div>
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
                      {selectedTemplate && selectedTemplate.body_parameter_count > 0 ? (
                        <div className="space-y-2">
                          <div className="flex items-center justify-between gap-2">
                            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">
                              Variabili ({selectedTemplate.body_parameter_count})
                            </p>
                            <div className="flex gap-1.5">
                              <button
                                type="button"
                                onClick={loadSuggestedTemplateVariables}
                                disabled={busyAction === "reply" || !selectedThread}
                                className="rounded-full border border-slate-200 bg-white px-2.5 py-1 text-[11px] font-semibold text-slate-700 transition hover:border-emerald-300 hover:bg-emerald-50 disabled:cursor-not-allowed disabled:opacity-50"
                              >
                                Compila suggerite
                              </button>
                              <button
                                type="button"
                                onClick={() => setTemplateVariablesText("")}
                                disabled={busyAction === "reply"}
                                className="rounded-full border border-slate-200 bg-white px-2.5 py-1 text-[11px] font-semibold text-slate-500 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                              >
                                Svuota
                              </button>
                            </div>
                          </div>
                          <div className="space-y-1.5">
                            {Array.from({ length: selectedTemplate.body_parameter_count }, (_, i) => {
                              const lines = templateVariablesText.split(/\r?\n/);
                              const value = lines[i] ?? "";
                              return (
                                <div key={i} className="flex items-center gap-2">
                                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-slate-100 text-[11px] font-bold text-slate-500">
                                    {i + 1}
                                  </span>
                                  <input
                                    data-no-uppercase
                                    value={value}
                                    onChange={(e) => {
                                      const arr = templateVariablesText.split(/\r?\n/);
                                      while (arr.length <= i) arr.push("");
                                      arr[i] = e.target.value;
                                      setTemplateVariablesText(arr.join("\n"));
                                    }}
                                    placeholder={`Variabile ${i + 1}`}
                                    disabled={busyAction === "reply"}
                                    className="input-saas flex-1 disabled:cursor-not-allowed disabled:bg-slate-100"
                                  />
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      ) : selectedTemplate ? (
                        <div className="flex items-center gap-2 rounded-xl bg-emerald-50 px-3 py-2 text-xs font-medium text-emerald-700">
                          <svg className="h-4 w-4 shrink-0" fill="currentColor" viewBox="0 0 20 20">
                            <path fillRule="evenodd" d="M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm3.857-9.809a.75.75 0 0 0-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 1 0-1.06 1.061l2.5 2.5a.75.75 0 0 0 1.137-.089l4-5.5Z" clipRule="evenodd" />
                          </svg>
                          Nessuna variabile richiesta — pronto per l&apos;invio.
                        </div>
                      ) : null}
                      {selectedTemplateHasUnsupportedHeader && (
                        <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                          Questo template richiede un header {selectedTemplate?.header_format?.toLowerCase()}. Per l&apos;invio manuale seleziona un template solo testo.
                        </div>
                      )}
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
                        placeholder={textModeUnavailable ? "Messaggio libero non disponibile fuori dalla finestra di 24 ore." : "Scrivi la risposta al cliente…"}
                        rows={4}
                        disabled={busyAction === "reply" || textModeUnavailable}
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
                        (composerMode === "text" && textModeUnavailable) ||
                        (composerMode === "text" ? !draft.trim() : !selectedTemplate || selectedTemplateHasUnsupportedHeader || selectedTemplateHasMissingVariables) ||
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
