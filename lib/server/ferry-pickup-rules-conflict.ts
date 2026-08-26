import { NextResponse } from "next/server";
import type { FerryPickupRule } from "@/lib/ferry-pickup-rules";

/**
 * Messaggio + payload di errore condiviso tra POST e PATCH quando
 * findConflictingRule individua una regola realmente in competizione.
 */
export function conflictErrorResponse(conflict: FerryPickupRule) {
  const from = conflict.transport_from.slice(0, 5);
  const to = conflict.transport_to.slice(0, 5);
  const companyLabel = conflict.company.toUpperCase();
  const port = conflict.arrival_port === "ischia_porto" ? "Ischia Porto" : conflict.arrival_port === "casamicciola" ? "Casamicciola" : conflict.arrival_port;

  const periodParts: string[] = [];
  if (conflict.valid_from || conflict.valid_to) {
    const validFrom = conflict.valid_from ? conflict.valid_from.slice(5).replace("-", "/") : "";
    const validTo = conflict.valid_to ? conflict.valid_to.slice(5).replace("-", "/") : "";
    periodParts.push(`valida ${validFrom}→${validTo}`);
  }
  const period = periodParts.join(" ");

  const message = `Questa fascia si sovrappone a una regola già esistente: ${companyLabel} ${from}–${to}` +
    ` (${port}${period ? `, ${period}` : ""}).`;

  return NextResponse.json(
    {
      error: message,
      conflict: {
        id: conflict.id,
        agency_logic: conflict.agency_logic,
        company: conflict.company,
        transport_from: from,
        transport_to: to,
        arrival_port: conflict.arrival_port,
        valid_from: conflict.valid_from,
        valid_to: conflict.valid_to,
        days_of_week: conflict.days_of_week,
      },
    },
    { status: 409 }
  );
}
