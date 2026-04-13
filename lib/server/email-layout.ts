/**
 * Wrapper HTML per tutte le email transazionali.
 * Design professionale responsive mobile-first.
 */

export function emailHtml(body: string, options?: { title?: string; preheader?: string }): string {
  // Logo come URL pubblico — Gmail e la maggior parte dei client email bloccano le immagini base64.
  const appUrl = process.env.NEXT_PUBLIC_APP_URL?.trim().replace(/\/$/, "") ?? "https://ischia-transfer.vercel.app";
  const logoUrl = `${appUrl}/brand/logo-ischia-transfer-email.png`;
  const logoBlock = `<img src="${logoUrl}" alt="Ischia Transfer Service" width="220" style="width:220px;max-width:75%;height:auto;display:block;margin:-78px auto -98px auto;" />`;

  const preheader = options?.preheader
    ? `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">${options.preheader}&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;</div>`
    : "";

  return `<!DOCTYPE html>
<html lang="it" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width,initial-scale=1.0" />
<meta name="color-scheme" content="light" />
<meta name="x-apple-disable-message-reformatting" />
<!--[if !mso]><!-->
<meta http-equiv="X-UA-Compatible" content="IE=edge" />
<!--<![endif]-->
${options?.title ? `<title>${options.title}</title>` : ""}
<style>
  /* Base reset */
  * { box-sizing: border-box; }
  body { margin:0!important; padding:0!important; background-color:#eef2f7!important; }
  img { border:0; height:auto; line-height:100%; outline:none; text-decoration:none; }
  table { border-collapse:collapse!important; }

  /* Mobile responsive — supportato da Apple Mail, Outlook iOS, Samsung Mail */
  @media only screen and (max-width:620px) {
    .email-wrapper { padding:12px 6px!important; }
    .email-container { width:100%!important; max-width:100%!important; }
    .email-header { padding:0!important; overflow:hidden!important; height:45px!important; border-radius:14px 14px 0 0!important; }
    .email-body { padding:24px 16px!important; }
    .email-footer { padding:18px 16px!important; border-radius:0 0 14px 14px!important; }
    .data-table td { display:block!important; width:100%!important; box-sizing:border-box!important; }
    .data-table tr .label-cell {
      border-bottom:none!important;
      padding-bottom:2px!important;
      padding-top:10px!important;
      width:100%!important;
      white-space:normal!important;
    }
    .data-table tr .value-cell {
      padding-top:4px!important;
      border-top:none!important;
      width:100%!important;
    }
    .email-button { width:100%!important; }
    .email-button a {
      display:block!important;
      width:100%!important;
      text-align:center!important;
      padding:16px 20px!important;
      box-sizing:border-box!important;
    }
    .email-button td {
      width:100%!important;
      display:block!important;
    }
    .service-box { padding:14px 16px!important; border-radius:10px!important; }
    .service-box .service-title { font-size:17px!important; }
    img { max-width:140px!important; width:140px!important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background-color:#eef2f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;">
${preheader}

<!-- Wrapper -->
<table class="email-wrapper" width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation" style="background:#eef2f7;padding:32px 12px;">
<tr><td align="center">
<table class="email-container" cellpadding="0" cellspacing="0" border="0" role="presentation" style="max-width:600px;width:100%;">

  <!-- HEADER -->
  <tr>
    <td class="email-header" style="background:linear-gradient(135deg,#0f2744 0%,#1e3a5f 60%,#1a4a7a 100%);border-radius:20px 20px 0 0;padding:0;overflow:hidden;height:45px;line-height:0;font-size:0;text-align:center;">
      ${logoBlock}
    </td>
  </tr>

  <!-- BODY -->
  <tr>
    <td class="email-body" style="background:#ffffff;padding:32px 28px;font-size:15px;line-height:1.7;color:#1e293b;">
      ${body}
    </td>
  </tr>

  <!-- FOOTER -->
  <tr>
    <td class="email-footer" style="background:#f8fafc;border-radius:0 0 20px 20px;border-top:1px solid #e2e8f0;padding:22px 24px;text-align:center;">
      <div style="font-size:13px;font-weight:600;color:#1e3a5f;margin-bottom:6px;">
        Ischia Transfer Service
      </div>
      <div style="font-size:12px;color:#94a3b8;line-height:1.8;">
        Via Cilento 14/C, 80077 Ischia (NA)<br />
        <a href="mailto:info@ischiatransferservice.it" style="color:#3b82f6;text-decoration:none;">info@ischiatransferservice.it</a>
        &nbsp;·&nbsp;
        <a href="tel:+390813334445" style="color:#3b82f6;text-decoration:none;">+39 081 333 4445</a>
      </div>
      <div style="margin-top:14px;font-size:11px;color:#cbd5e1;">
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

/** Bottone CTA stilizzato — full width su mobile */
export function emailButton(label: string, href: string, color = "#1e3a5f"): string {
  return `<table class="email-button" cellpadding="0" cellspacing="0" border="0" role="presentation" style="margin:28px auto;width:auto;">
<tr><td align="center" style="border-radius:12px;background:${color};">
<a href="${href}" style="display:inline-block;padding:16px 36px;font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:12px;letter-spacing:0.01em;mso-padding-alt:16px 36px;white-space:nowrap;">${label}</a>
</td></tr></table>`;
}

/** Converte data ISO (YYYY-MM-DD) in formato italiano (GG/MM/AAAA) */
export function fmtDate(iso: string): string {
  if (!iso) return iso;
  const [y, m, d] = iso.split("-");
  if (!y || !m || !d) return iso;
  return `${d}/${m}/${y}`;
}

/** Box evidenziato (es. codice OTP, dato importante) */
export function emailHighlightBox(content: string, bg = "#f0f6ff", border = "#bfdbfe"): string {
  return `<div style="background:${bg};border:2px solid ${border};border-radius:14px;padding:20px 24px;margin:20px 0;text-align:center;">
${content}
</div>`;
}

/** Tabella dati chiave-valore — stacked su mobile */
export function emailDataTable(rows: Array<[string, string]>): string {
  const trs = rows.map(([k, v]) => `
    <tr>
      <td class="label-cell" style="padding:10px 16px;background:#f8fafc;border:1px solid #e2e8f0;font-size:13px;font-weight:600;color:#64748b;width:38%;min-width:110px;vertical-align:top;">${k}</td>
      <td class="value-cell" style="padding:10px 16px;border:1px solid #e2e8f0;font-size:14px;color:#1e293b;word-break:break-word;max-width:0;">${v}</td>
    </tr>`).join("");
  return `<table class="data-table" width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation" style="border-collapse:collapse;margin:20px 0;border-radius:12px;overflow:hidden;">${trs}</table>`;
}
