// Meta WhatsApp template parameter builder for MEDMAR convocations.
// Kept isolated from Excel parsing (lib/medmar-convocation-parse.ts) so the
// preview shown in the UI and the payload actually sent to Meta are always
// built from the exact same function — no drift between preview and send.
//
// Definitive Meta template: "partenze_medmar" (WHATSAPP_MEDMAR_CONVOCATION_TEMPLATE).
// Exactly 6 ordered parameters: {{1}} nome cliente, {{2}} data partenza
// formattata, {{3}} hotel, {{4}} pax, {{5}} ora prelevamento, {{6}} ora nave.

export const MEDMAR_TEMPLATE_PARAM_COUNT = 6;

export const DEFAULT_MEDMAR_CONVOCATION_TEMPLATE =
  process.env.WHATSAPP_MEDMAR_CONVOCATION_TEMPLATE?.trim() || "partenze_medmar";

export type MedmarTemplateRow = {
  customerName: string;
  departureDateLabel: string;
  hotel: string;
  passengers: string;
  pickupTime: string;
  vesselTime: string;
};

// Ordered {{1}}..{{6}} params sent to the Meta template API.
export function buildMedmarConvocationTemplateParams(row: MedmarTemplateRow): Record<string, string> {
  return {
    "1": row.customerName || "",
    "2": row.departureDateLabel || "",
    "3": row.hotel || "",
    "4": row.passengers || "",
    "5": row.pickupTime || "",
    "6": row.vesselTime || "",
  };
}

// Guards the "never send with a wrong parameter count" requirement: exactly
// 6 non-empty {{1}}..{{6}} keys, nothing more, nothing less.
export function hasValidMedmarTemplateParamCount(params: Record<string, string>): boolean {
  const keys = Object.keys(params);
  return keys.length === MEDMAR_TEMPLATE_PARAM_COUNT && keys.every((k) => /^[1-6]$/.test(k));
}

const MEDMAR_TEMPLATE_TEXT = `Ciao {{1}} 👋

🚢 PROGRAMMA DELLA TUA PARTENZA – {{2}}

🏨 Hotel: {{3}}
👥 Passeggeri: {{4}}

🧳 Ti ricordiamo che il prelevamento con bagagli è previsto all’esterno dell’hotel alle ore {{5}}.

⛴️ Successivamente, imbarco con nave MEDMAR delle ore {{6}}.

🎫 Ricorda di portare con te i biglietti del traghetto: saranno necessari per accedere all’imbarco.

Ti consigliamo di essere pronto qualche minuto prima dell’orario indicato. 😊

Buon viaggio!
Ischia Transfer Service 🚐🌊`;

// Renders the exact text a customer will see, from the same params used
// for the Meta payload — this is what the preview UI must display, and it
// must be byte-for-byte the approved "partenze_medmar" template body.
export function buildMedmarConvocationPreviewText(row: MedmarTemplateRow): string {
  const params = buildMedmarConvocationTemplateParams(row);
  return MEDMAR_TEMPLATE_TEXT
    .replace("{{1}}", params["1"])
    .replace("{{2}}", params["2"])
    .replace("{{3}}", params["3"])
    .replace("{{4}}", params["4"])
    .replace("{{5}}", params["5"])
    .replace("{{6}}", params["6"]);
}
