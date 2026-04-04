/**
 * Wrapper HTML per tutte le email transazionali.
 * Include logo, layout standard e footer aziendale.
 */

import { getLogoDataUri } from "@/lib/server/logo";

export function emailHtml(body: string): string {
  const logo = getLogoDataUri();
  const logoHtml = logo
    ? `<img src="${logo}" alt="Ischia Transfer Service" style="height:52px;width:auto;display:block;" />`
    : `<span style="font-size:18px;font-weight:700;color:#1e3a5f;">Ischia Transfer Service</span>`;

  return `<!DOCTYPE html>
<html lang="it">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width,initial-scale=1.0" />
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #f1f5f9; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif; font-size: 15px; color: #1a1a1a; }
  .wrapper { max-width: 600px; margin: 32px auto; }
  .header { background: #ffffff; border-radius: 16px 16px 0 0; padding: 24px 32px; border-bottom: 1px solid #e2e8f0; }
  .body { background: #ffffff; padding: 32px; line-height: 1.65; }
  .body p { margin-bottom: 14px; }
  .body ul { margin: 8px 0 14px 20px; }
  .body li { margin-bottom: 6px; }
  .body a { color: #1e3a5f; }
  .footer { background: #f8fafc; border-radius: 0 0 16px 16px; border-top: 1px solid #e2e8f0; padding: 18px 32px; text-align: center; font-size: 12px; color: #94a3b8; }
</style>
</head>
<body>
<div class="wrapper">
  <div class="header">${logoHtml}</div>
  <div class="body">${body}</div>
  <div class="footer">
    Ischia Transfer Service &nbsp;·&nbsp; info@ischiatransferservice.it<br />
    Messaggio generato automaticamente — non rispondere a questa email.
  </div>
</div>
</body>
</html>`;
}
