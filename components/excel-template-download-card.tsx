import type { ExcelTemplate } from "@/lib/excel-templates";

type Props = {
  template: ExcelTemplate;
  /** Tighter layout for embedding inside a busy module (drops the heading). */
  compact?: boolean;
};

// Discreet "official Excel template" download box, shared by the MEDMAR and
// SNAV convocation modules (and any future module). It is a plain <a download>
// to a static file under public/templates/ — no form submit, no navigation,
// no client state, so dropping it inside an upload form never resets a
// batch already in progress.
export function ExcelTemplateDownloadCard({ template, compact = false }: Props) {
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50/60 p-4">
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-white text-lg shadow-sm" aria-hidden>
          📊
        </div>
        <div className="min-w-0 flex-1">
          {!compact && (
            <p className="text-sm font-semibold text-slate-800">Template Excel ufficiale</p>
          )}
          <p className={`text-xs text-slate-600 ${compact ? "" : "mt-0.5"}`}>
            Scarica il modello corretto prima di preparare il file da importare.
          </p>
          <a
            href={template.href}
            download={template.fileName}
            className="btn-secondary mt-3 inline-flex items-center gap-2 text-xs"
          >
            ⬇️ Scarica template Excel
          </a>
        </div>
      </div>
    </div>
  );
}
