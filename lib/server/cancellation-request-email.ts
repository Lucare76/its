import { sendEmail, type SendEmailResult } from "@/lib/server/send-email";
import { emailHtml, emailDataTable, emailButton } from "@/lib/server/email-layout";

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, char => ({"&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;"}[char]!));
}

export async function sendCancellationRequestEmail(input: {
  customerName: string;
  cancelLegs: "arrival" | "departure" | "both";
  requestId: string;
}): Promise<SendEmailResult> {
  const to = process.env.OPS_NOTIFY_EMAIL?.trim() || "info@ischiatransferservice.it";
  const appUrl = process.env.NEXT_PUBLIC_APP_URL?.trim().replace(/\/$/, "") || "https://ischia-transfer.vercel.app";
  const leg = input.cancelLegs === "both" ? "Intero servizio" : input.cancelLegs === "arrival" ? "Solo andata" : "Solo ritorno";
  try {
    return await sendEmail({
      to,
      subject: `Richiesta cancellazione — ${input.customerName}`,
      html: emailHtml(`
        <h2 style="color:#0f172a;">Richiesta di cancellazione</h2>
        <p>Un’agenzia ha richiesto la cancellazione di un servizio. La richiesta attende la valutazione dell’operatore.</p>
        ${emailDataTable([["Cliente", escapeHtml(input.customerName)], ["Tratta", leg], ["Riferimento richiesta", escapeHtml(input.requestId)]])}
        ${emailButton("Gestisci richiesta", `${appUrl}/cancellazioni`)}
      `, {title:"Richiesta cancellazione"}),
      text: `Richiesta di cancellazione\nCliente: ${input.customerName}\nTratta: ${leg}\nRiferimento: ${input.requestId}\nGestisci: ${appUrl}/cancellazioni`,
    });
  } catch {
    return {ok:false,error:"Invio notifica cancellazione fallito."};
  }
}
