/**
 * Fase delivery — ricerca del PDF biglietto Medmar nella mailbox
 * (info@ischiatransferservice.it) via POP3 READ-ONLY.
 *
 * Comandi POP3 usati: USER, PASS, STAT, TOP, RETR, QUIT (+ UIDL come
 * identificatore stabile del messaggio). MAI `DELE`: questo modulo non
 * cancella e non muta MAI lo stato della mailbox — verificato per design
 * (nessuna funzione qui emette il comando DELE, la sessione si chiude
 * sempre con QUIT).
 *
 * Matching forte: il PDF va accettato SOLO se (a) il filename dell'allegato
 * corrisponde a `Prenotazione<id_prenotazione>.pdf` (case-insensitive) E (b)
 * il testo grezzo del messaggio contiene il codice Medmar (es.
 * "AG1908926B000438457"). Un solo segnale non basta: il filename da solo
 * potrebbe combaciare per coincidenza numerica, il codice Medmar da solo
 * potrebbe comparire in un messaggio non pertinente.
 */
import { createHash } from "node:crypto";
import net from "node:net";

export class MedmarPdfMailboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MedmarPdfMailboxError";
  }
}

export type MedmarPdfMailboxConfig = {
  host: string;
  port: number;
  user: string;
  password: string;
};

function readMailboxConfig(): MedmarPdfMailboxConfig | null {
  const host = (process.env.MEDMAR_MAILBOX_HOST ?? "").trim();
  const user = (process.env.MEDMAR_MAILBOX_USER ?? "").trim();
  const password = (process.env.MEDMAR_MAILBOX_PASSWORD ?? "").trim();
  const port = Number(process.env.MEDMAR_MAILBOX_PORT ?? "110");
  if (!host || !user || !password || !Number.isFinite(port)) return null;
  return { host, port, user, password };
}

type PdfCandidate = {
  messageNumber: number;
  messageUid: string;
  filename: string;
  bytes: Buffer;
  sha256: string;
};

export type MedmarPdfLookupInput = {
  idPrenotazione: string;
  medmarNumero: string;
  /** Quanti messaggi recenti scansionare (dal più recente), default 400. */
  maxMessagesToScan?: number;
};

export type MedmarPdfLookupResult =
  | { kind: "found"; pdfBytes: Buffer; filename: string; messageUid: string; sha256: string }
  | { kind: "not_found" }
  | { kind: "ambiguous"; candidates: Array<{ filename: string; messageUid: string; sha256: string }> };

class Pop3Session {
  private socket: net.Socket;
  private buffer = "";
  private waiters: Array<{ terminator: "line" | "multiline"; resolve: (v: string) => void; reject: (e: Error) => void }> = [];

  constructor(socket: net.Socket) {
    this.socket = socket;
    socket.on("data", (chunk) => this.onData(chunk));
    socket.on("error", (err) => this.failAll(err));
    socket.on("close", () => this.failAll(new MedmarPdfMailboxError("Connessione mailbox chiusa inaspettatamente.")));
  }

  private failAll(err: Error) {
    while (this.waiters.length > 0) this.waiters.shift()!.reject(err);
  }

  private onData(chunk: Buffer) {
    this.buffer += chunk.toString("latin1");
    this.tryResolve();
  }

  private tryResolve() {
    while (this.waiters.length > 0) {
      const w = this.waiters[0]!;
      if (w.terminator === "line") {
        const idx = this.buffer.indexOf("\r\n");
        if (idx === -1) return;
        const line = this.buffer.slice(0, idx);
        this.buffer = this.buffer.slice(idx + 2);
        this.waiters.shift();
        w.resolve(line);
      } else {
        const idx = this.buffer.indexOf("\r\n.\r\n");
        if (idx === -1) return;
        const body = this.buffer.slice(0, idx + 2);
        this.buffer = this.buffer.slice(idx + 5);
        this.waiters.shift();
        w.resolve(body);
      }
    }
  }

  private readLine(): Promise<string> {
    return new Promise((resolve, reject) => {
      this.waiters.push({ terminator: "line", resolve, reject });
      this.tryResolve();
    });
  }

  /** Consuma il greeting iniziale inviato spontaneamente dal server alla connessione (nessun comando scritto sul socket). */
  readGreeting(): Promise<string> {
    return this.readLine();
  }

  private readMultiline(): Promise<string> {
    return new Promise((resolve, reject) => {
      this.waiters.push({ terminator: "multiline", resolve, reject });
      this.tryResolve();
    });
  }

  async cmdLine(cmd: string): Promise<string> {
    this.socket.write(cmd + "\r\n");
    return this.readLine();
  }

  /** Legge una risposta multilinea (terminata da "\r\n.\r\n"), de-stuffando i punti raddoppiati a inizio riga. */
  async cmdMultiline(cmd: string): Promise<string> {
    this.socket.write(cmd + "\r\n");
    const first = await this.readLine();
    if (!first.startsWith("+OK")) throw new MedmarPdfMailboxError(`Comando POP3 fallito (${cmd}): ${first}`);
    const rest = await this.readMultiline();
    return rest
      .split("\r\n")
      .map((l) => (l.startsWith("..") ? l.slice(1) : l))
      .join("\r\n");
  }

  quit(): void {
    this.socket.write("QUIT\r\n");
    this.socket.end();
  }
}

function extractPdfAttachments(rawMessage: string): Array<{ filename: string; bytes: Buffer }> {
  const boundaryMatch = rawMessage.match(/boundary="?([^"\r\n;]+)"?/i);
  if (!boundaryMatch) return [];
  const boundary = boundaryMatch[1]!;
  const parts = rawMessage.split(`--${boundary}`);
  const attachments: Array<{ filename: string; bytes: Buffer }> = [];
  for (const part of parts) {
    const filenameMatch = part.match(/filename="?([^"\r\n;]+\.pdf)"?/i);
    if (!filenameMatch) continue;
    const bodyStart = part.indexOf("\r\n\r\n");
    if (bodyStart === -1) continue;
    const base64 = part.slice(bodyStart + 4).trim().replace(/\r\n/g, "");
    if (!base64) continue;
    attachments.push({ filename: filenameMatch[1]!, bytes: Buffer.from(base64, "base64") });
  }
  return attachments;
}

/**
 * Cerca il PDF del biglietto Medmar nella mailbox, in read-only. Non
 * cancella mai nulla (nessun DELE). Ritorna `not_found` / `ambiguous` /
 * `found` — mai un match parziale/incerto silenziosamente accettato.
 */
export async function findMedmarTicketPdf(input: MedmarPdfLookupInput): Promise<MedmarPdfLookupResult> {
  const config = readMailboxConfig();
  if (!config) {
    throw new MedmarPdfMailboxError(
      "Configurazione mailbox Medmar mancante (MEDMAR_MAILBOX_HOST/PORT/USER/PASSWORD)."
    );
  }
  const idPrenotazione = input.idPrenotazione.trim();
  const medmarNumero = input.medmarNumero.trim();
  if (!idPrenotazione || !medmarNumero) {
    throw new MedmarPdfMailboxError("idPrenotazione e medmarNumero sono obbligatori per la ricerca del PDF.");
  }
  const maxScan = input.maxMessagesToScan ?? 400;

  const socket = net.connect({ host: config.host, port: config.port });
  socket.setTimeout(30_000);
  socket.on("timeout", () => socket.destroy(new Error("Timeout connessione mailbox Medmar.")));
  const session = new Pop3Session(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", () => resolve());
    socket.once("error", reject);
  });

  try {
    const greeting = await session.readGreeting();
    if (!greeting.startsWith("+OK")) {
      throw new MedmarPdfMailboxError(`Greeting POP3 inatteso: ${greeting}`);
    }
    const userResp = await session.cmdLine(`USER ${config.user}`);
    if (!userResp.startsWith("+OK")) throw new MedmarPdfMailboxError(`USER rifiutato: ${userResp}`);
    const passResp = await session.cmdLine(`PASS ${config.password}`);
    if (!passResp.startsWith("+OK")) throw new MedmarPdfMailboxError(`PASS rifiutato: ${passResp}`);

    const stat = await session.cmdLine("STAT");
    const statMatch = stat.match(/^\+OK\s+(\d+)/);
    if (!statMatch) throw new MedmarPdfMailboxError(`Risposta STAT inattesa: ${stat}`);
    const count = parseInt(statMatch[1]!, 10);

    const candidates: PdfCandidate[] = [];
    const seenHashes = new Set<string>();
    const lower = Math.max(1, count - maxScan + 1);

    for (let messageNumber = count; messageNumber >= lower; messageNumber--) {
      let headerPreview: string;
      try {
        headerPreview = await session.cmdMultiline(`TOP ${messageNumber} 80`);
      } catch {
        continue;
      }
      // Prefiltro leggero: l'id_prenotazione compare tipicamente nel filename
      // dell'allegato, gia' visibile entro le prime righe MIME multipart.
      if (!headerPreview.includes(idPrenotazione)) continue;

      let fullMessage: string;
      try {
        fullMessage = await session.cmdMultiline(`RETR ${messageNumber}`);
      } catch {
        continue;
      }
      if (!fullMessage.includes(medmarNumero)) continue;

      const attachments = extractPdfAttachments(fullMessage);
      for (const attachment of attachments) {
        const filenameMatchesIdPrenotazione = new RegExp(`Prenotazione0*${idPrenotazione}\\.pdf$`, "i").test(attachment.filename);
        if (!filenameMatchesIdPrenotazione) continue;
        const sha256 = createHash("sha256").update(attachment.bytes).digest("hex");
        if (seenHashes.has(sha256)) continue; // stesso contenuto già visto (es. re-inoltro identico)
        seenHashes.add(sha256);

        let messageUid = `msg-${messageNumber}`;
        try {
          const uidlResp = await session.cmdLine(`UIDL ${messageNumber}`);
          const uidlMatch = uidlResp.match(/^\+OK\s+\d+\s+(\S+)/);
          if (uidlMatch) messageUid = uidlMatch[1]!;
        } catch {
          // UIDL non supportato dal server: fallback sul numero di sessione, accettabile solo come identificatore diagnostico.
        }

        candidates.push({ messageNumber, messageUid, filename: attachment.filename, bytes: attachment.bytes, sha256 });
      }
    }

    if (candidates.length === 0) return { kind: "not_found" };
    if (candidates.length > 1) {
      return {
        kind: "ambiguous",
        candidates: candidates.map((c) => ({ filename: c.filename, messageUid: c.messageUid, sha256: c.sha256 })),
      };
    }
    const only = candidates[0]!;
    return { kind: "found", pdfBytes: only.bytes, filename: only.filename, messageUid: only.messageUid, sha256: only.sha256 };
  } finally {
    // Chiusura pulita — MAI DELE prima di QUIT: nessuna mutazione della mailbox.
    session.quit();
  }
}
