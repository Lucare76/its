/**
 * GET /api/ops/piano-giorno/driver-sheet?date=YYYY-MM-DD&profile_id=XXX
 * Restituisce HTML print-ready per il foglio singolo autista (formato A4/A5 compatto).
 *
 * Contiene: orario, categoria, pickup → destinazione, clienti, pax, telefono, note.
 * Progettato per essere stampato dall'autista in macchina tra un servizio e l'altro.
 */
import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { getPianoServiceDisplay } from "@/lib/piano-service-display";

export const runtime = "nodejs";

function esc(s: string | null | undefined) {
  return (s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmt5(t: string | null | undefined) {
  return (t ?? "").slice(0, 5) || "—";
}

export function customerFullName(r: { customer_name: string; customer_first_name?: string | null; customer_last_name?: string | null }) {
  return [r.customer_first_name, r.customer_last_name].filter(Boolean).join(" ") || r.customer_name;
}

function categoryBadge(cat: string) {
  const colors: Record<string, string> = {
    ARRIVO: "#1d4ed8",
    PARTENZA: "#b45309",
    NAVETTA: "#059669",
    ESCURSIONE: "#7c3aed",
    "DA_VERIFICARE": "#6b7280",
  };
  const color = colors[cat] ?? "#6b7280";
  return `<span style="background:${color};color:#fff;padding:1px 6px;border-radius:3px;font-size:10px;font-weight:700">${esc(cat)}</span>`;
}

export async function GET(req: NextRequest) {
  try {
    const auth = await authorizePricingRequest(req, ["admin", "operator", "supervisor"]);
    if (auth instanceof NextResponse) return auth;

    const tenantId = auth.membership.tenant_id;
    const { searchParams } = req.nextUrl;
    const date = searchParams.get("date") ?? new Date().toISOString().slice(0, 10);
    const profileId = searchParams.get("profile_id");
    const userId = searchParams.get("user_id");

    if (!profileId && !userId) {
      return NextResponse.json({ error: "profile_id o user_id richiesto" }, { status: 400 });
    }

    // Carica il piano completo del giorno + dati autista
    const [servicesRes, hotelsRes, membershipsRes, tripGroupsRes] = await Promise.all([
      auth.admin
        .from("services")
        .select("id, time, direction, customer_name, customer_first_name, customer_last_name, pax, hotel_id, vessel, notes, meeting_point, pickup_hotel, booking_service_kind, service_type_code, phone, pickup_time, arrival_time, departure_time, ferry_details, excursion_details, tour_name, barca_compagnia, orario_barca")
        .eq("tenant_id", tenantId)
        .eq("date", date)
        .neq("status", "cancelled")
        .neq("is_draft", true)
        .order("time"),
      auth.admin
        .from("hotels")
        .select("id, name, zone")
        .eq("tenant_id", tenantId),
      auth.admin
        .from("memberships")
        .select("user_id, profile_id, full_name")
        .eq("tenant_id", tenantId),
      auth.admin
        .from("trip_groups")
        .select("id, driver_user_id, driver_profile_id, vehicle_label, vehicle_capacity")
        .eq("tenant_id", tenantId)
        .eq("date", date)
        .eq("status", "active"),
    ]);

    if (servicesRes.error) throw new Error(servicesRes.error.message);

    const services = servicesRes.data ?? [];
    const hotelMap = new Map((hotelsRes.data ?? []).map((h) => [h.id as string, h]));
    const memberMap = new Map((membershipsRes.data ?? []).map((m) => [m.user_id as string, m]));
    const tripGroups = tripGroupsRes.data ?? [];

    // Trova il trip group dell'autista
    const driverGroups = tripGroups.filter((g) => {
      if (profileId && g.driver_profile_id === profileId) return true;
      if (userId && g.driver_user_id === userId) return true;
      return false;
    });

    // Trova l'utente dell'autista
    const driverMember = userId
      ? memberMap.get(userId)
      : membershipsRes.data?.find((m) => m.profile_id === profileId);

    const driverName = driverMember?.full_name ?? profileId ?? userId ?? "Autista";

    // Carica assignments per i group dell'autista
    const groupIds = driverGroups.map((g) => g.id as string);
    const assignmentsRes = groupIds.length > 0
      ? await auth.admin
          .from("assignments")
          .select("service_id, group_id, vehicle_label")
          .eq("tenant_id", tenantId)
          .in("group_id", groupIds)
      : { data: [] as Array<{ service_id: string; group_id: string; vehicle_label: string | null }> };

    const assignments = assignmentsRes.data ?? [];
    const myServiceIds = new Set(assignments.map((a) => a.service_id));

    // Servizi di questo autista, ordinati per orario operativo
    type Svc = typeof services[number] & { hotel_id: string | null; ferry_details?: unknown; excursion_details?: unknown };
    const myServices = (services as Svc[])
      .filter((s) => myServiceIds.has(s.id))
      .sort((a, b) => {
        const ta = (a.direction === "departure" ? (a.pickup_hotel ?? a.time) : a.time) ?? "00:00";
        const tb = (b.direction === "departure" ? (b.pickup_hotel ?? b.time) : b.time) ?? "00:00";
        return ta.localeCompare(tb);
      });

    // Mezzo dell'autista (primo gruppo)
    const vehicleLabel = driverGroups[0]?.vehicle_label ?? "—";

    // Formatta data in italiano
    const dateIt = new Date(date + "T12:00:00Z").toLocaleDateString("it-IT", {
      weekday: "long",
      day: "2-digit",
      month: "long",
      year: "numeric",
    });

    // Costruisci le righe del foglio
    const rows = myServices.map((svc) => {
      const hotel = svc.hotel_id ? hotelMap.get(svc.hotel_id) : null;
      const display = getPianoServiceDisplay(svc as Parameters<typeof getPianoServiceDisplay>[0], hotel as Parameters<typeof getPianoServiceDisplay>[1]);
      const ora = display.primaryTime ?? fmt5(svc.direction === "departure" ? (svc.pickup_hotel ?? svc.time) : svc.time);
      const clienti = customerFullName(svc);
      const telefono = display.phoneLabel ?? svc.phone ?? null;
      const connessione = [display.connectionLabel, display.transportRef, display.ferryLabel].filter(Boolean).join(" · ") || null;
      const note = [display.noteLabel, display.importTag].filter(Boolean).join(" · ") || null;
      const pickup = display.pickupLabel ?? "—";
      const destination = display.destinationLabel ?? "—";

      return { ora, cat: display.macroCategory, pickup, destination, clienti, pax: svc.pax, telefono, connessione, note };
    });

    // Genera HTML
    const rowsHtml = rows.map((r) => `
      <tr>
        <td style="font-weight:700;font-size:15px;white-space:nowrap;padding:5px 8px">${esc(r.ora)}</td>
        <td style="padding:5px 4px">${categoryBadge(r.cat)}</td>
        <td style="padding:5px 8px">
          <div style="font-weight:600;font-size:12px">${esc(r.pickup)} → ${esc(r.destination)}</div>
          ${r.connessione ? `<div style="font-size:10px;color:#555;margin-top:1px">${esc(r.connessione)}</div>` : ""}
        </td>
        <td style="padding:5px 8px">
          <div style="font-size:12px;font-weight:600">${esc(r.clienti)}</div>
          ${r.telefono ? `<div style="font-size:10px;color:#1d4ed8">📞 ${esc(r.telefono)}</div>` : ""}
          ${r.note ? `<div style="font-size:10px;color:#b45309;margin-top:1px">${esc(r.note)}</div>` : ""}
        </td>
        <td style="text-align:center;font-weight:700;padding:5px 6px">${r.pax}</td>
      </tr>
    `).join("");

    const html = `<!DOCTYPE html>
<html lang="it">
<head>
  <meta charset="UTF-8">
  <title>${esc(driverName)} — ${esc(dateIt)}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: Arial, sans-serif; font-size: 12px; color: #111; background: #fff; }
    @page { size: A4 portrait; margin: 12mm; }
    .header { background: #1e3a5f; color: #fff; padding: 10px 14px; display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
    .header .name { font-size: 18px; font-weight: 700; }
    .header .info { font-size: 12px; opacity: 0.85; text-align: right; }
    table { width: 100%; border-collapse: collapse; }
    th { background: #1e3a5f; color: #fff; font-size: 10px; padding: 4px 8px; text-align: left; }
    tr:nth-child(even) { background: #f0f4f8; }
    td { border-bottom: 1px solid #e2e8f0; vertical-align: top; }
    .footer { margin-top: 10px; font-size: 9px; color: #888; text-align: center; }
    @media print {
      body { font-size: 11px; }
    }
  </style>
</head>
<body>
  <div class="header">
    <div class="name">${esc(driverName)}</div>
    <div class="info">
      <div>${esc(dateIt)}</div>
      <div>Mezzo: <strong>${esc(vehicleLabel)}</strong></div>
      <div>${myServices.length} servizi</div>
    </div>
  </div>
  <table>
    <thead>
      <tr>
        <th>Ora</th>
        <th>Tipo</th>
        <th>Percorso</th>
        <th>Cliente / Note</th>
        <th>Pax</th>
      </tr>
    </thead>
    <tbody>
      ${rowsHtml || '<tr><td colspan="5" style="padding:12px;text-align:center;color:#888">Nessun servizio assegnato per questa data</td></tr>'}
    </tbody>
  </table>
  <div class="footer">Generato da ITS · ${esc(new Date().toLocaleString("it-IT"))}</div>
</body>
</html>`;

    return new NextResponse(html, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Errore" },
      { status: 500 }
    );
  }
}
