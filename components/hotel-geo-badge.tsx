import type { HotelGeoEvaluation, HotelGeoStatus } from "@/lib/hotel-geocoding";

const badgeClasses: Record<HotelGeoStatus, string> = {
  missing: "border-rose-200 bg-rose-50 text-rose-700",
  generic: "border-orange-200 bg-orange-50 text-orange-700",
  approximate: "border-sky-200 bg-sky-50 text-sky-700",
  verified: "border-emerald-200 bg-emerald-50 text-emerald-700"
};

export function HotelGeoBadge({ evaluation }: { evaluation: HotelGeoEvaluation }) {
  return (
    <div className="space-y-1" title={evaluation.tooltipLines.join("\n")}>
      <span className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-semibold ${badgeClasses[evaluation.status]}`}>
        {evaluation.label}
      </span>
      <p className={evaluation.outsideIschia ? "text-xs font-semibold text-rose-700" : "text-xs text-slate-500"}>
        {evaluation.helper}
      </p>
    </div>
  );
}
