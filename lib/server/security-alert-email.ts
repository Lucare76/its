interface SecurityAlertInput {
  type: 'rate_limit_exceeded' | 'multiple_failed_logins' | 'suspicious_activity';
  email?: string;
  ip_address?: string;
  details?: Record<string, unknown>;
  tenant_id?: string;
}

interface SecurityAlertResult {
  status: 'sent' | 'failed' | 'skipped';
  error: string | null;
}

function buildSecurityAlertHtml(input: SecurityAlertInput): string {
  let title = '';
  let message = '';

  if (input.type === 'rate_limit_exceeded') {
    title = 'Avviso: Limite di richieste superato';
    message = `
      <p>Sono stati rilevati troppi tentativi da:</p>
      <ul>
        <li><strong>Email:</strong> ${input.email || 'non disponibile'}</li>
        <li><strong>IP:</strong> ${input.ip_address || 'non disponibile'}</li>
      </ul>
      <p>L'indirizzo IP è stato temporaneamente limitato. Se è legittimo, contatta l'utente.</p>
    `;
  } else if (input.type === 'multiple_failed_logins') {
    title = 'Avviso: Multipli tentativi di login falliti';
    message = `
      <p>Rilevati ${input.details?.attemptCount || 'N'} tentativi di login falliti per:</p>
      <ul>
        <li><strong>Email:</strong> ${input.email || 'non disponibile'}</li>
        <li><strong>IP:</strong> ${input.ip_address || 'non disponibile'}</li>
      </ul>
      <p>Potrebbe trattarsi di un tentativo di accesso non autorizzato (brute force).</p>
    `;
  } else if (input.type === 'suspicious_activity') {
    title = 'Avviso: Attività sospetta rilevata';
    message = `
      <p>Attività insolita nel tuo tenant:</p>
      <p>${input.details?.description || 'Dettagli non disponibili'}</p>
    `;
  }

  return `
    <h2>${title}</h2>
    ${message}
    <p style="color: #666; font-size: 12px;">
      Timestamp: ${new Date().toISOString()}<br>
      Questo è un avviso automatico. Se non hai richiesto questa azione, contatta il supporto.
    </p>
  `;
}

function buildSecurityAlertText(input: SecurityAlertInput): string {
  let title = '';
  let message = '';

  if (input.type === 'rate_limit_exceeded') {
    title = 'Avviso: Limite di richieste superato';
    message = `
Sono stati rilevati troppi tentativi da:
Email: ${input.email || 'non disponibile'}
IP: ${input.ip_address || 'non disponibile'}

L'indirizzo IP è stato temporaneamente limitato. Se è legittimo, contatta l'utente.
    `;
  } else if (input.type === 'multiple_failed_logins') {
    title = 'Avviso: Multipli tentativi di login falliti';
    message = `
Rilevati ${input.details?.attemptCount || 'N'} tentativi di login falliti per:
Email: ${input.email || 'non disponibile'}
IP: ${input.ip_address || 'non disponibile'}

Potrebbe trattarsi di un tentativo di accesso non autorizzato (brute force).
    `;
  } else if (input.type === 'suspicious_activity') {
    title = 'Avviso: Attività sospetta rilevata';
    message = `
Attività insolita nel tuo tenant:
${input.details?.description || 'Dettagli non disponibili'}
    `;
  }

  return `${title}\n\n${message}\n\nTimestamp: ${new Date().toISOString()}\nQuesto è un avviso automatico.`;
}

export async function sendSecurityAlert(input: SecurityAlertInput): Promise<SecurityAlertResult> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.AGENCY_BOOKING_FROM_EMAIL;
  if (!apiKey || !from) {
    return { status: 'skipped', error: 'Provider email non configurato.' };
  }

  // Get admin emails from environment or database
  const adminEmailEnv = process.env.SECURITY_ALERT_EMAIL;
  if (!adminEmailEnv) {
    return { status: 'skipped', error: 'Admin email destinatario non configurato (SECURITY_ALERT_EMAIL).' };
  }

  const adminEmails = adminEmailEnv.split(',').map((e) => e.trim());

  const subject = `[SECURITY ALERT] ${input.type.replace(/_/g, ' ').toUpperCase()}`;

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from,
      to: adminEmails,
      subject,
      html: buildSecurityAlertHtml(input),
      text: buildSecurityAlertText(input)
    })
  });

  if (!response.ok) {
    const bodyText = await response.text().catch(() => '');
    return {
      status: 'failed',
      error: `Invio alert fallito (${response.status}). ${bodyText.slice(0, 240)}`
    };
  }

  return { status: 'sent', error: null };
}
