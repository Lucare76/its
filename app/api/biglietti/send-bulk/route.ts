import { NextResponse } from "next/server";

/** Retired manual PDF upload: no attachments are processed and no email is sent. */
export async function POST() {
  return NextResponse.json(
    { ok: false, error: "L’invio multiplo manuale è stato rimosso. Usa Biglietti MEDMAR." },
    { status: 410 }
  );
}
