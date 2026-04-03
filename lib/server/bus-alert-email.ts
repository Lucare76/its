const ALERT_TO = "info@ischiatransferservice.it";

export interface BusLowSeatAlertInput {
  busLabel: string;
  lineName: string;
  remainingSeats: number;
  threshold: number;
  date?: string;
}

export async function sendBusLowSeatAlertEmail(input: BusLowSeatAlertInput): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.AGENCY_BOOKING_FROM_EMAIL;
  if (!apiKey || !from) return;

  const subject = `Attenzione: bus quasi pieno — ${input.busLabel} (${input.remainingSeats} posti rimasti)`;
  const detail = input.date ? ` per il giorno ${input.date}` : "";
  const text = [
    `Il bus ${input.busLabel} (${input.lineName}) ha raggiunto la soglia di attenzione${detail}.`,
    ``,
    `Posti liberi rimasti: ${input.remainingSeats}`,
    `Soglia configurata: ${input.threshold}`,
    ``,
    `Accedi alla gestione bus per verificare le allocazioni o redistribuire i passeggeri.`
  ].join("\n");

  const html = [
    `<p>Il bus <strong>${input.busLabel}</strong> (${input.lineName}) ha raggiunto la soglia di attenzione${detail}.</p>`,
    `<ul>`,
    `<li><strong>Posti liberi rimasti:</strong> ${input.remainingSeats}</li>`,
    `<li><strong>Soglia configurata:</strong> ${input.threshold}</li>`,
    `</ul>`,
    `<p>Accedi alla gestione bus per verificare le allocazioni o redistribuire i passeggeri.</p>`
  ].join("");

  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to: [ALERT_TO], subject, html, text })
  }).catch(() => {
    // Non-blocking: email failure should not break the allocation
  });
}
