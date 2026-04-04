/**
 * Wrapper HTML per tutte le email transazionali.
 * Design professionale con logo grande, header navy, layout moderno.
 */

import { getLogoDataUri } from "@/lib/server/logo";

export function emailHtml(body: string, options?: { title?: string; preheader?: string }): string {
  const logo = getLogoDataUri();
  const logoBlock = logo
    ? `<img src="${logo}" alt="Ischia Transfer Service" style="width:100%;height:auto;display:block;" />`
    : `<div style="font-size:26px;font-weight:800;color:#ffffff;letter-spacing:-0.5px;text-align:center;">Ischia Transfer Service</div>`;

  const preheader = options?.preheader
    ? `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">${options.preheader}</div>`
    : "";

  return `<!DOCTYPE html>
<html lang="it">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width,initial-scale=1.0" />
<meta name="color-scheme" content="light" />
${options?.title ? `<title>${options.title}</title>` : ""}
</head>
<body style="margin:0;padding:0;background-color:#eef2f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
${preheader}

<!-- Wrapper -->
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#eef2f7;padding:40px 16px;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;">

  <!-- HEADER con logo -->
  <tr>
    <td style="background:linear-gradient(135deg,#0f2744 0%,#1e3a5f 60%,#1a4a7a 100%);border-radius:20px 20px 0 0;padding:0;text-align:center;">
      ${logoBlock}
    </td>
  </tr>

  <!-- BODY -->
  <tr>
    <td style="background:#ffffff;padding:44px 48px;font-size:15px;line-height:1.7;color:#1e293b;">
      ${body}
    </td>
  </tr>

  <!-- FOOTER -->
  <tr>
    <td style="background:#f8fafc;border-radius:0 0 20px 20px;border-top:1px solid #e2e8f0;padding:28px 48px;text-align:center;">
      <div style="font-size:13px;font-weight:600;color:#1e3a5f;margin-bottom:6px;">
        Ischia Transfer Service
      </div>
      <div style="font-size:12px;color:#94a3b8;line-height:1.8;">
        Via Cilento 14/C, 80077 Ischia (NA)<br />
        <a href="mailto:info@ischiatransferservice.it" style="color:#3b82f6;text-decoration:none;">info@ischiatransferservice.it</a>
        &nbsp;·&nbsp;
        <a href="tel:+39081900000" style="color:#3b82f6;text-decoration:none;">+39 081 90 00 00</a>
      </div>
      <div style="margin-top:16px;font-size:11px;color:#cbd5e1;">
        Messaggio generato automaticamente — si prega di non rispondere a questa email.
      </div>
    </td>
  </tr>

</table>
</td></tr>
</table>

</body>
</html>`;
}

/** Bottone CTA stilizzato da usare nelle email */
export function emailButton(label: string, href: string, color = "#1e3a5f"): string {
  return `<table cellpadding="0" cellspacing="0" border="0" style="margin:28px 0;">
<tr><td style="border-radius:12px;background:${color};">
<a href="${href}" style="display:inline-block;padding:16px 32px;font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:12px;letter-spacing:0.01em;">${label}</a>
</td></tr></table>`;
}

/** Box evidenziato (es. codice OTP, dato importante) */
export function emailHighlightBox(content: string, bg = "#f0f6ff", border = "#bfdbfe"): string {
  return `<div style="background:${bg};border:2px solid ${border};border-radius:14px;padding:20px 24px;margin:20px 0;text-align:center;">
${content}
</div>`;
}

/** Tabella dati chiave-valore */
export function emailDataTable(rows: Array<[string, string]>): string {
  const trs = rows.map(([k, v]) => `
    <tr>
      <td style="padding:10px 16px;background:#f8fafc;border:1px solid #e2e8f0;font-size:13px;font-weight:600;color:#64748b;width:160px;">${k}</td>
      <td style="padding:10px 16px;border:1px solid #e2e8f0;font-size:14px;color:#1e293b;">${v}</td>
    </tr>`).join("");
  return `<table width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;margin:20px 0;border-radius:12px;overflow:hidden;">${trs}</table>`;
}
