import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { statementPaymentAuth } from "@/lib/server/statement-payment-auth";
import { sendEmail } from "@/lib/server/send-email";
const schema = z.object({
  invoice_id: z.string().uuid(),
  amount_cents: z.number().int().positive().max(2147483647),
  paid_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  method: z.enum(["Bonifico", "Contanti", "Carta", "Altro"]),
  note: z.string().trim().max(1000).optional(),
  token: z.string().optional(),
});
export async function GET(request: NextRequest) {
  const auth = await statementPaymentAuth(
    request,
    request.nextUrl.searchParams.get("token") ?? undefined,
  );
  if (auth instanceof NextResponse) return auth;
  let q = auth.admin
    .from("agency_statement_payment_reports")
    .select("id,invoice_id,amount_cents,paid_on,method,note,status,created_at")
    .eq("tenant_id", auth.tenantId)
    .eq("agency_id", auth.agencyId)
    .order("created_at", { ascending: false });
  if (auth.invoiceId) q = q.eq("invoice_id", auth.invoiceId);
  const { data, error } = await q.limit(200);
  if (error)
    return NextResponse.json(
      { error: "Impossibile leggere le segnalazioni." },
      { status: 503 },
    );
  return NextResponse.json({ ok: true, reports: data ?? [] });
}
export async function POST(request: NextRequest) {
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success)
    return NextResponse.json(
      { error: "Completa i dati del pagamento." },
      { status: 400 },
    );
  const b = parsed.data;
  const auth = await statementPaymentAuth(request, b.token);
  if (auth instanceof NextResponse) return auth;
  if (auth.invoiceId && auth.invoiceId !== b.invoice_id)
    return NextResponse.json(
      { error: "Estratto non autorizzato." },
      { status: 403 },
    );
  const { data: invoice, error: readError } = await auth.admin
    .from("agency_invoices")
    .select("id,agency_name,invoice_number,total_cents,paid_cents,waived_cents")
    .eq("tenant_id", auth.tenantId)
    .eq("agency_id", auth.agencyId)
    .eq("id", b.invoice_id)
    .maybeSingle();
  if (readError || !invoice)
    return NextResponse.json(
      { error: "Estratto non trovato." },
      { status: 404 },
    );
  if (
    b.amount_cents >
    invoice.total_cents - invoice.paid_cents - invoice.waived_cents
  )
    return NextResponse.json(
      { error: "Importo superiore al residuo dell’estratto." },
      { status: 409 },
    );
  const { error } = await auth.admin
    .from("agency_statement_payment_reports")
    .insert({
      tenant_id: auth.tenantId,
      agency_id: auth.agencyId,
      invoice_id: b.invoice_id,
      amount_cents: b.amount_cents,
      paid_on: b.paid_on,
      method: b.method,
      note: b.note ?? null,
    });
  if (error)
    return NextResponse.json(
      {
        error:
          error.code === "23505"
            ? "Esiste già una segnalazione in attesa di verifica."
            : "Segnalazione non salvata. Riprova.",
      },
      { status: 409 },
    );
  let emailNotification = "failed";
  try {
    const r = await sendEmail({
      to:
        process.env.OPS_NOTIFY_EMAIL?.trim() || "info@ischiatransferservice.it",
      subject: `Pagamento da verificare — ${invoice.invoice_number}`,
      html: `<p>È stato segnalato un pagamento di € ${(b.amount_cents / 100).toFixed(2)} per l’estratto ${invoice.invoice_number}.</p><p>Apri ITS → Estratto conto per verificare l’incasso. Il saldo non è stato modificato.</p>`,
      text: `Pagamento da verificare: ${invoice.invoice_number}, EUR ${(b.amount_cents / 100).toFixed(2)}. Apri ITS, Estratto conto. Saldo invariato.`,
    });
    emailNotification = r.ok && !r.skipped ? "sent" : "failed";
  } catch {
    console.error("statement_payment_report_email_failed");
  }
  return NextResponse.json({ ok: true, email_notification: emailNotification });
}
