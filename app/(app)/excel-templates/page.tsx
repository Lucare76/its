import Link from "next/link";
import { PageHeader, SectionCard } from "@/components/ui";
import { EXCEL_TEMPLATES, excelTemplatesByCategory } from "@/lib/excel-templates";

export const metadata = {
  title: "Template Excel",
};

export default function ExcelTemplatesPage() {
  const groups = excelTemplatesByCategory();

  return (
    <div className="space-y-6 pb-12">
      <PageHeader
        title="Template Excel"
        subtitle="Modelli ufficiali ITS da utilizzare per importazioni e operazioni massive."
        breadcrumbs={[{ label: "Strumenti" }, { label: "Template Excel" }]}
      />

      {EXCEL_TEMPLATES.length === 0 ? (
        <SectionCard title="Nessun template disponibile">
          <p className="text-sm text-muted">Non è ancora stato registrato alcun template Excel ufficiale.</p>
        </SectionCard>
      ) : (
        groups.map((group) => (
          <SectionCard key={group.category} title={group.category}>
            <div className="grid gap-4 sm:grid-cols-2">
              {group.templates.map((template) => (
                <div
                  key={template.id}
                  className="flex flex-col rounded-lg border border-slate-200 bg-white p-4"
                >
                  <div className="flex items-start gap-3">
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-slate-50 text-lg" aria-hidden>
                      📊
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold text-slate-800">{template.name}</p>
                      <p className="mt-0.5 text-xs text-slate-600">{template.description}</p>
                    </div>
                  </div>

                  <dl className="mt-3 space-y-1 text-xs text-slate-500">
                    <div className="flex gap-1">
                      <dt className="font-medium text-slate-600">File:</dt>
                      <dd className="truncate font-mono">{template.fileName}</dd>
                    </div>
                    <div className="flex gap-1">
                      <dt className="font-medium text-slate-600">Categoria:</dt>
                      <dd>{template.category}</dd>
                    </div>
                    {template.version && (
                      <div className="flex gap-1">
                        <dt className="font-medium text-slate-600">Versione:</dt>
                        <dd>{template.version}</dd>
                      </div>
                    )}
                  </dl>

                  <div className="mt-4 flex flex-wrap gap-2">
                    <a
                      href={template.href}
                      download={template.fileName}
                      className="btn-primary inline-flex items-center gap-2 text-xs"
                    >
                      ⬇️ Scarica Excel
                    </a>
                    {template.moduleHref && (
                      <Link href={template.moduleHref} className="btn-secondary inline-flex items-center text-xs">
                        Apri modulo
                      </Link>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </SectionCard>
        ))
      )}
    </div>
  );
}
