const nodemailer = require('nodemailer');

function hasSmtpConfig() {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_PORT && process.env.SMTP_USER && process.env.SMTP_PASS);
}

function createTransporter() {
  if (!hasSmtpConfig()) return null;

  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT),
    secure: String(process.env.SMTP_SECURE || 'false') === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}

async function sendPasswordResetEmail({ to, resetUrl }) {
  const transporter = createTransporter();
  const supportEmail = process.env.SUPPORT_EMAIL || 'lucarenna76@gmail.com';
  const logoUrl = process.env.MAIL_LOGO_URL || '';
  const subject = 'ITS - Recupero password';
  const text = [
    'Ischia Transfer Service - Recupero password',
    '',
    'Abbiamo ricevuto una richiesta di reset password per il tuo account.',
    `Usa questo link: ${resetUrl}`,
    '',
    'Il link è valido per 30 minuti.',
    `Supporto: ${supportEmail}`,
    `Contatto diretto: mailto:${supportEmail}`,
  ].join('\n');
  const html = `
    <!doctype html>
    <html>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="color-scheme" content="light dark" />
        <meta name="supported-color-schemes" content="light dark" />
        <style>
          body {
            margin: 0;
            padding: 0;
            background: #f6f8fb;
            font-family: Arial, sans-serif;
            color: #111827;
          }
          .wrapper {
            padding: 24px;
            background: #f6f8fb;
          }
          .card {
            max-width: 600px;
            margin: 0 auto;
            background: #ffffff;
            border: 1px solid #e5e7eb;
            border-radius: 10px;
            overflow: hidden;
          }
          .header {
            background: #0f2f56;
            color: #ffffff;
            padding: 16px 20px;
            font-size: 18px;
            font-weight: bold;
          }
          .content {
            padding: 24px 20px;
            color: #111827;
          }
          .button {
            display: inline-block;
            background: #0f2f56;
            color: #ffffff !important;
            text-decoration: none;
            padding: 10px 16px;
            border-radius: 6px;
            font-weight: bold;
          }
          .muted {
            color: #6b7280;
            font-size: 12px;
            line-height: 1.4;
          }
          .small {
            color: #4b5563;
            font-size: 13px;
          }
          @media (max-width: 640px) {
            .wrapper {
              padding: 10px;
            }
            .content {
              padding: 18px 14px;
            }
            .header {
              font-size: 16px;
              padding: 14px;
            }
          }
          @media (prefers-color-scheme: dark) {
            body, .wrapper {
              background: #0b1220 !important;
              color: #e5e7eb !important;
            }
            .card {
              background: #111827 !important;
              border-color: #1f2937 !important;
            }
            .content {
              color: #e5e7eb !important;
            }
            .small,
            .muted {
              color: #cbd5e1 !important;
            }
          }
        </style>
      </head>
      <body>
        <div class="wrapper">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" class="card">
            <tr>
              <td class="header">
                ${logoUrl
                  ? `<img src="${logoUrl}" alt="ITS" style="height:40px;vertical-align:middle;margin-right:10px;" />`
                  : ''}
                <span style="vertical-align:middle;">ITS • Ischia Transfer Service</span>
              </td>
            </tr>
            <tr>
              <td class="content">
                <h2 style="margin:0 0 12px 0;font-size:20px;">Recupero password</h2>
                <p style="margin:0 0 14px 0;line-height:1.5;">Abbiamo ricevuto una richiesta di reset password per il tuo account.</p>
                <p style="margin:0 0 18px 0;line-height:1.5;">Clicca il pulsante qui sotto per impostare una nuova password. Il link è valido per 30 minuti.</p>
                <p style="margin:0 0 20px 0;">
                  <a href="${resetUrl}" class="button">Reimposta password</a>
                </p>
                <p class="small" style="margin:0 0 8px 0;">Se il pulsante non funziona, copia questo link:</p>
                <p style="margin:0 0 16px 0;word-break:break-all;font-size:13px;"><a href="${resetUrl}">${resetUrl}</a></p>
                <p class="muted" style="margin:0 0 8px 0;">Supporto: <a href="mailto:${supportEmail}">${supportEmail}</a></p>
                <p class="muted" style="margin:0;">Messaggio automatico ITS. Se non hai richiesto il reset password, ignora questa email.</p>
              </td>
            </tr>
          </table>
        </div>
      </body>
    </html>
  `;

  if (!transporter) {
    console.log(`[SMTP DISABLED] Reset URL for ${to}: ${resetUrl}`);
    return { delivered: false };
  }

  const from = process.env.MAIL_FROM || process.env.SUPPORT_EMAIL || 'no-reply@its.local';
  await transporter.sendMail({
    from,
    to,
    subject,
    text,
    html,
  });

  return { delivered: true };
}

async function sendPasswordChangedEmail({ to, userName }) {
  const transporter = createTransporter();
  const supportEmail = process.env.SUPPORT_EMAIL || 'lucarenna76@gmail.com';
  const subject = 'ITS - Password aggiornata';
  const text = [
    `Ciao ${userName || ''},`.trim(),
    '',
    'La password del tuo account ITS è stata aggiornata con successo.',
    'Se non sei stato tu, contatta subito il supporto.',
    `Supporto: ${supportEmail}`,
  ].join('\n');
  const html = `
    <div style="font-family: Arial, sans-serif; background:#f6f8fb; padding:24px;">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:600px;margin:0 auto;background:#ffffff;border-radius:10px;border:1px solid #e5e7eb;overflow:hidden;">
        <tr>
          <td style="background:#0f2f56;color:#ffffff;padding:16px 20px;font-size:18px;font-weight:bold;">ITS • Ischia Transfer Service</td>
        </tr>
        <tr>
          <td style="padding:24px 20px;color:#111827;">
            <h2 style="margin:0 0 12px 0;font-size:20px;">Password aggiornata</h2>
            <p style="margin:0 0 14px 0;line-height:1.5;">Ciao ${userName || ''}, la password del tuo account ITS è stata aggiornata con successo.</p>
            <p style="margin:0 0 16px 0;line-height:1.5;">Se non sei stato tu, contatta subito il supporto.</p>
            <p style="margin:0;color:#6b7280;font-size:12px;">Supporto: <a href="mailto:${supportEmail}">${supportEmail}</a></p>
          </td>
        </tr>
      </table>
    </div>
  `;

  if (!transporter) {
    console.log(`[SMTP DISABLED] Password changed notice for ${to}`);
    return { delivered: false };
  }

  const from = process.env.MAIL_FROM || process.env.SUPPORT_EMAIL || 'no-reply@its.local';
  await transporter.sendMail({
    from,
    to,
    subject,
    text,
    html,
  });

  return { delivered: true };
}

async function sendStatementEmail({ to, statement, pdfBuffer }) {
  const transporter = createTransporter();
  const supportEmail = process.env.SUPPORT_EMAIL || 'lucarenna76@gmail.com';
  const from = process.env.MAIL_FROM || process.env.SUPPORT_EMAIL || 'no-reply@its.local';

  const periodStart = new Date(statement.periodStart).toLocaleDateString('it-IT');
  const periodEnd = new Date(statement.periodEnd).toLocaleDateString('it-IT');

  const subject = `ITS - Estratto conto ${periodStart} - ${periodEnd}`;
  const text = [
    'Ischia Transfer Service - Estratto conto',
    `Agenzia: ${statement.agency?.name || '-'}`,
    `Periodo: ${periodStart} - ${periodEnd}`,
    `Totale lordo: ${Number(statement.grossTotal || 0).toFixed(2)} EUR`,
    '',
    'In allegato trovi il PDF dell\'estratto conto.',
    `Supporto: ${supportEmail}`,
  ].join('\n');

  const html = `
    <div style="font-family: Arial, sans-serif; background:#f6f8fb; padding:24px;">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:600px;margin:0 auto;background:#ffffff;border-radius:10px;border:1px solid #e5e7eb;overflow:hidden;">
        <tr>
          <td style="background:#0f2f56;color:#ffffff;padding:16px 20px;font-size:18px;font-weight:bold;">ITS • Ischia Transfer Service</td>
        </tr>
        <tr>
          <td style="padding:24px 20px;color:#111827;">
            <h2 style="margin:0 0 12px 0;font-size:20px;">Estratto conto</h2>
            <p style="margin:0 0 8px 0;line-height:1.5;"><strong>Agenzia:</strong> ${statement.agency?.name || '-'}</p>
            <p style="margin:0 0 8px 0;line-height:1.5;"><strong>Periodo:</strong> ${periodStart} - ${periodEnd}</p>
            <p style="margin:0 0 16px 0;line-height:1.5;"><strong>Totale lordo:</strong> ${Number(statement.grossTotal || 0).toFixed(2)} EUR</p>
            <p style="margin:0 0 16px 0;line-height:1.5;">In allegato trovi il PDF dell'estratto conto.</p>
            <p style="margin:0;color:#6b7280;font-size:12px;">Supporto: <a href="mailto:${supportEmail}">${supportEmail}</a></p>
          </td>
        </tr>
      </table>
    </div>
  `;

  if (!transporter) {
    console.log(`[SMTP DISABLED] Statement email for ${to}`);
    return { delivered: false };
  }

  await transporter.sendMail({
    from,
    to,
    subject,
    text,
    html,
    attachments: [
      {
        filename: `statement-${statement.id}.pdf`,
        content: pdfBuffer,
        contentType: 'application/pdf',
      },
    ],
  });

  return { delivered: true };
}

module.exports = {
  sendPasswordResetEmail,
  sendPasswordChangedEmail,
  sendStatementEmail,
  hasSmtpConfig,
};
