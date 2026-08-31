/**
 * FASE A.4 — POLICY CONVERSAZIONALE OPERATIVA per Assistente Mario.
 *
 * Modulo CENTRALE e DETERMINISTICO. Non contiene regex per singole frasi:
 * classifica l'operazione conversazionale, decide quali campi servono DAVVERO
 * prima di una preview (business rule, non solo schema MCP), applica i vincoli
 * pax, e costruisce gli arguments MCP scartando i campi non supportati.
 *
 * Divisione dei ruoli (§26):
 *   - LLM → intent classification, slot extraction, interpretazione semantica,
 *     rilevamento ambiguità.
 *   - QUESTA policy → campi obbligatori, readiness business, vincoli pax,
 *     mapping tool consentito, tool argument builder.
 * Se il modello dice `missing: []` ma la policy dice `["serviceDate"]`, VINCE
 * la policy (§27).
 *
 * NON tocca lo schema DB, il confirmation HMAC, il cost tracking, la UI.
 * L'ultimo giudice resta comunque la inputSchema MCP in `runTool` (§42).
 */

export type MarioOperationKey =
  | "create_generic_booking_group"
  | "create_bus_group"
  | "create_exclusive_bus_group"
  | "add_booking_group_stop"
  | "add_booking_group_passengers"
  | "reserve_bus_for_group"
  | "update_group_ferry"
  | "operationalize_group"
  | "assign_driver"
  | "update_service_status";

export type MarioOperationPolicy = {
  operation: MarioOperationKey;
  description: string;
  /** Tool MCP "preview_" corrispondente. */
  mcpTool: string;
  /** Campi che DEVONO essere presenti prima di mostrare la preview
   *  (business rule conversazionale — può essere più stretta dello schema). */
  requiredBeforePreview: string[];
  /** Campi opzionali da conservare nel draft anche se non finiscono negli
   *  arguments del tool (es. `origin` per la creazione gruppo). */
  optionalPreserved: string[];
  /** Slot che il draft può accettare (superset). */
  supportedDraftFields: string[];
  /** Slot che il tool argument builder invia effettivamente allo schema MCP. */
  toolArgumentFields: string[];
  /** `kind` forzato per questa operazione (booking group), se applicabile. */
  forcedKind?: string;
  postCreateHints?: string[];
  ambiguityRules?: string[];
};

const CREATE_TOOL = "its.preview_create_booking_group";
const CREATE_ARG_FIELDS = ["name", "expectedPax", "serviceDate", "kind", "status", "contactName", "contactPhone", "agencyId", "hotelId", "notes"];
const CREATE_PRESERVED = ["origin", "pickupPoint", "agency", "hotel", "contact", "notes", "kind", "serviceDate"];

export const MARIO_OPERATION_POLICIES: Record<MarioOperationKey, MarioOperationPolicy> = {
  create_generic_booking_group: {
    operation: "create_generic_booking_group",
    description: "Contenitore commerciale generico: l'utente sta creando solo il gruppo, non un servizio bus operativo.",
    mcpTool: CREATE_TOOL,
    requiredBeforePreview: ["name", "expectedPax"], // §4 — data opzionale
    optionalPreserved: CREATE_PRESERVED,
    supportedDraftFields: ["name", "expectedPax", "serviceDate", "kind", "origin", "agency", "hotel", "contact", "notes"],
    toolArgumentFields: CREATE_ARG_FIELDS,
  },
  create_bus_group: {
    operation: "create_bus_group",
    description: "Gruppo bus operativo (bus / pullman / autobus): un servizio con data.",
    mcpTool: CREATE_TOOL,
    requiredBeforePreview: ["name", "expectedPax", "serviceDate"], // §5 — data obbligatoria (business rule)
    optionalPreserved: CREATE_PRESERVED,
    supportedDraftFields: ["name", "expectedPax", "serviceDate", "kind", "origin", "pickupPoint", "agency", "hotel", "contact", "notes"],
    toolArgumentFields: CREATE_ARG_FIELDS,
    forcedKind: "bus_group",
    postCreateHints: ["if origin present and no stop exists -> propose add_booking_group_stop for origin"],
  },
  create_exclusive_bus_group: {
    operation: "create_exclusive_bus_group",
    description: "Bus esclusivo / mezzo dedicato al gruppo: servizio operativo con data.",
    mcpTool: CREATE_TOOL,
    requiredBeforePreview: ["name", "expectedPax", "serviceDate"],
    optionalPreserved: CREATE_PRESERVED,
    supportedDraftFields: ["name", "expectedPax", "serviceDate", "kind", "origin", "pickupPoint", "agency", "hotel", "contact", "notes"],
    toolArgumentFields: CREATE_ARG_FIELDS,
    forcedKind: "bus_exclusive",
    postCreateHints: ["if origin present and no stop exists -> propose add_booking_group_stop for origin"],
  },
  add_booking_group_stop: {
    operation: "add_booking_group_stop",
    description: "Fermata pianificata di un gruppo: città + pax che salgono lì + direzione.",
    mcpTool: "its.preview_add_booking_group_stop",
    // §12 — lo schema reale richiede anche expectedPax e direction: sono
    // obbligatori operativamente, non solo tecnicamente.
    requiredBeforePreview: ["bookingGroupId", "city", "expectedPax", "direction"],
    optionalPreserved: ["notes"],
    supportedDraftFields: ["bookingGroupId", "city", "pickupPoint", "expectedPax", "direction", "sortOrder", "notes"],
    toolArgumentFields: ["bookingGroupId", "city", "pickupPoint", "expectedPax", "direction", "sortOrder", "notes"],
  },
  add_booking_group_passengers: {
    operation: "add_booking_group_passengers",
    description: "Nominativi (servizi bozza) per una fermata del gruppo.",
    mcpTool: "its.preview_add_booking_group_passengers",
    requiredBeforePreview: ["bookingGroupId", "bookingGroupStopId", "passengers"],
    optionalPreserved: [],
    supportedDraftFields: ["bookingGroupId", "bookingGroupStopId", "passengers"],
    toolArgumentFields: ["bookingGroupId", "bookingGroupStopId", "passengers"],
  },
  reserve_bus_for_group: {
    operation: "reserve_bus_for_group",
    description: "Riserva di un mezzo fisico (tenant_bus_units) per un gruppo in una data.",
    mcpTool: "its.preview_reserve_booking_group_bus",
    requiredBeforePreview: ["bookingGroupId", "busUnitId", "serviceDate", "reservedPax"],
    optionalPreserved: ["notes"],
    supportedDraftFields: ["bookingGroupId", "busUnitId", "serviceDate", "reservedPax", "exclusive", "notes"],
    toolArgumentFields: ["bookingGroupId", "busUnitId", "serviceDate", "reservedPax", "exclusive", "notes"],
    ambiguityRules: ["'bus' + capacità/targa/posti -> mezzo fisico (questa op); 'bus' + pax + nome gruppo -> create_bus_group"],
  },
  update_group_ferry: {
    operation: "update_group_ferry",
    description: "Override traghetto del gruppo (andata/ritorno). Distinto dalla regola ferry_pickup_rules globale.",
    mcpTool: "its.preview_update_booking_group_ferry",
    // Serve almeno un campo ferry E sapere se andata o ritorno (§14/§38).
    requiredBeforePreview: ["bookingGroupId", "ferryDirection", "ferryField"],
    optionalPreserved: [],
    supportedDraftFields: ["bookingGroupId", "ferryDirection", "ferryCompany", "ferryTime", "ferryPort"],
    toolArgumentFields: ["bookingGroupId", "ferry"],
    ambiguityRules: ["se non è chiaro andata/ritorno -> chiedi SOLO quello"],
  },
  operationalize_group: {
    operation: "operationalize_group",
    description: "Rende operativi i servizi bozza pronti di un gruppo. La readiness la valuta il tool stesso.",
    mcpTool: "its.preview_booking_group_operationalization",
    requiredBeforePreview: ["bookingGroupId"], // §15 — non chiedere campi a mano
    optionalPreserved: [],
    supportedDraftFields: ["bookingGroupId"],
    toolArgumentFields: ["bookingGroupId"],
  },
  assign_driver: {
    operation: "assign_driver",
    description: "Assegna autista (+mezzo) a un servizio. Nessun lookup autista-per-nome nel catalogo: servono gli ID.",
    mcpTool: "its.preview_assign_driver",
    requiredBeforePreview: ["serviceId", "driverId"],
    optionalPreserved: ["vehicleId"],
    supportedDraftFields: ["serviceId", "driverId", "vehicleId"],
    toolArgumentFields: ["serviceId", "driverId", "vehicleId"],
    ambiguityRules: ["mai scegliere un autista tra più plausibili senza un tool/regola"],
  },
  update_service_status: {
    operation: "update_service_status",
    description: "Transizione di stato di un servizio.",
    mcpTool: "its.preview_update_service_status",
    requiredBeforePreview: ["serviceId", "targetStatus"],
    optionalPreserved: [],
    supportedDraftFields: ["serviceId", "targetStatus"],
    toolArgumentFields: ["serviceId", "targetStatus"],
  },
};

// §5/§11 — segnali di "contesto bus operativo". Categorie, non frasi.
const BUS_CONTEXT_RE = /\b(bus|pullman|autobus|corriera|torpedone)\b/i;
const EXCLUSIVE_RE = /\b(esclusiv\w*|dedicat\w*|riservat\w*|solo per (?:il|questo) gruppo|mezzo riservato)\b/i;
// §11 — segnali di "mezzo fisico" (reservation), non gruppo commerciale.
// "posti" = capienza mezzo; "pax"/"persone" = dimensione gruppo (NON qui).
const PHYSICAL_BUS_RE = /(\b\d{1,3}\s*posti\b|\btarga\b|\bcapacità\b|\bcapienza\b|\bmezzo\s*n\.?\s*\d+|\bbus\s*n\.?\s*\d+)/i;

// FIX A.4.3 — estrattori CONSERVATIVI di slot "evidenti" per il fallback
// deterministico quando il router LLM omette `operation` su una clarification
// operativa (§A.4.2). Pattern SEMANTICI generali (unità di misura/parole
// chiave), MAI per nome specifico. In caso di dubbio: nessuna estrazione,
// mai un valore indovinato (§2/§6 spec fix).
//
// PAX: solo se il numero è esplicitamente legato a "persone/pax/passeggeri"
// o alla frase "gruppo di N" — MAI un numero seguito da "posti" (quello è
// capacità del MEZZO FISICO: "bus da 54 posti" != expectedPax=54, §4 spec).
const PAX_RE = /\b(\d{1,4})\s*(?:persone|pax|passeggeri)\b|\bgruppo\s+di\s+(\d{1,4})\b/iu;
// ORIGIN: solo con un marcatore esplicito "partenza da"/"parte da" (§6 —
// "da Rimini a Napoli" da solo, senza questo marcatore, resta ambiguo e non
// va estratto). Cattura fino al primo separatore/parola di stop (fermata
// successiva, destinazione, o riferimento al gruppo).
const ORIGIN_RE =
  /\b(?:partenza\s+da|parte\s+da)\s+([\p{L}][\p{L}'’ -]{1,60}?)(?=\s*[,.;!?]|$|\s+(?:a|per|con|gruppo|prenotazione)\b)/iu;

/**
 * FIX A.4.3 — estrae SOLO slot ad alta confidenza per le operazioni di
 * creazione gruppo. Non chiamata su nessun'altra operazione (add_stop,
 * reserve_bus, ecc. — quei campi richiedono ID/lookup, non estrazione da
 * testo libero). Ogni campo assente resta assente: la policy (non questo
 * estrattore) decide poi cosa è ancora `missing` (§2 spec — mai inventare).
 */
export function extractMarioDraftSlotsFromMessage(
  message: string,
  operation: MarioOperationKey,
): { name?: string; expectedPax?: number; origin?: string } {
  const out: { name?: string; expectedPax?: number; origin?: string } = {};
  if (operation !== "create_generic_booking_group" && operation !== "create_bus_group" && operation !== "create_exclusive_bus_group") {
    return out;
  }

  const paxMatch = PAX_RE.exec(message);
  if (paxMatch) {
    const raw = paxMatch[1] ?? paxMatch[2];
    const n = raw ? Number(raw) : NaN;
    if (Number.isFinite(n) && n > 0 && n <= 2000) out.expectedPax = n;
  }

  // §4 — un segnale di MEZZO FISICO ("54 posti", "targa", "capacità"…) nello
  // stesso messaggio rende l'intero messaggio ambiguo tra gruppo commerciale
  // e reservation: non si estrae origin in quel caso (resta a un turno
  // successivo/chiarimento esplicito, mai una scelta arbitraria).
  if (!mentionsPhysicalBus(message)) {
    const originMatch = ORIGIN_RE.exec(message);
    if (originMatch?.[1]) {
      const origin = originMatch[1].trim();
      if (origin.length >= 2) out.origin = origin;
    }
  }

  return out;
}

export type ClassifySignal = {
  /** Tool scelto dal router / dal flusso. */
  toolName?: string;
  /** `type`/`operation` fornito dal router nell'oggetto `operation`. */
  rawType?: string;
  /** `kind` già negli slot/arguments (bus_exclusive | bus_group | …). */
  kind?: string;
  /** Testo utente (per i segnali di categoria, mai per-frase). */
  message?: string;
};

/** Classifica l'operazione conversazionale (§3). Deterministica. */
export function classifyMarioOperation(signal: ClassifySignal): MarioOperationKey {
  const raw = signal.rawType?.trim();
  if (raw && raw in MARIO_OPERATION_POLICIES) return raw as MarioOperationKey;

  const tool = signal.toolName;
  if (tool === "its.preview_add_booking_group_stop") return "add_booking_group_stop";
  if (tool === "its.preview_add_booking_group_passengers") return "add_booking_group_passengers";
  if (tool === "its.preview_reserve_booking_group_bus") return "reserve_bus_for_group";
  if (tool === "its.preview_update_booking_group_ferry") return "update_group_ferry";
  if (tool === "its.preview_booking_group_operationalization") return "operationalize_group";
  if (tool === "its.preview_assign_driver") return "assign_driver";
  if (tool === "its.preview_update_service_status") return "update_service_status";

  // create_* : kind esplicito vince, altrimenti segnali di categoria nel testo.
  if (signal.kind === "bus_exclusive") return "create_exclusive_bus_group";
  if (signal.kind === "bus_group") return "create_bus_group";
  const msg = signal.message ?? "";
  // "esclusivo / dedicato / mezzo riservato / solo per il gruppo" è un segnale
  // di bus esclusivo anche senza la parola "bus" (§5).
  if (EXCLUSIVE_RE.test(msg)) return "create_exclusive_bus_group";
  if (BUS_CONTEXT_RE.test(msg)) return "create_bus_group";
  return "create_generic_booking_group";
}

/** §11/§37 — true se il messaggio indica un MEZZO FISICO (reservation),
 *  non un gruppo bus commerciale. */
export function mentionsPhysicalBus(message: string): boolean {
  return PHYSICAL_BUS_RE.test(message);
}

export type PolicyEvalInput = {
  operation: MarioOperationKey;
  collected: Record<string, unknown>;
  /** Contesto opzionale per i vincoli pax delle fermate (§9/§36). */
  groupExpectedPax?: number;
  plannedPaxOtherStops?: number;
};

export type PolicyEvalResult = {
  readyForPreview: boolean;
  missingRequired: string[];
  preservedFields: Record<string, unknown>;
  /** Codici (non frasi): il router/UI produce il testo. */
  warnings: string[];
  /** Primo campo mancante — il router/UI chiede "Per quale <campo>?". */
  nextQuestionField?: string;
};

function isEmpty(v: unknown): boolean {
  return v == null || v === "" || (Array.isArray(v) && v.length === 0);
}

/**
 * §24 — API PURA. Decide SE ci sono abbastanza dati per la preview.
 * Non genera la frase finale: restituisce `nextQuestionField` (label).
 */
export function evaluateMarioOperationPolicy(input: PolicyEvalInput): PolicyEvalResult {
  const policy = MARIO_OPERATION_POLICIES[input.operation];
  const collected = input.collected ?? {};

  const missingRequired = policy.requiredBeforePreview.filter((f) => isEmpty(collected[f]));
  const warnings: string[] = [];

  // §9/§36 — vincolo somma pax fermate.
  if (input.operation === "add_booking_group_stop" && typeof input.groupExpectedPax === "number") {
    const thisStop = Number(collected.expectedPax ?? 0);
    const others = Number(input.plannedPaxOtherStops ?? 0);
    if (Number.isFinite(thisStop) && thisStop > 0 && others + thisStop > input.groupExpectedPax) {
      warnings.push("stop_pax_exceeds_group_total");
    }
  }

  const preservedFields: Record<string, unknown> = {};
  for (const f of policy.optionalPreserved) {
    if (!isEmpty(collected[f])) preservedFields[f] = collected[f];
  }

  const readyForPreview = missingRequired.length === 0 && warnings.length === 0;
  return {
    readyForPreview,
    missingRequired,
    preservedFields,
    warnings,
    nextQuestionField: missingRequired[0],
  };
}

/**
 * §28 — TOOL ARGUMENT BUILDER deterministico: draft/policy → arguments MCP.
 * Invia SOLO i campi previsti dallo schema del tool (mai `origin`, mai
 * `pickupPoint` come `city`, ecc.). Applica `forcedKind` se non specificato.
 */
export function buildMcpArguments(operation: MarioOperationKey, collected: Record<string, unknown>): Record<string, unknown> {
  const policy = MARIO_OPERATION_POLICIES[operation];
  const args: Record<string, unknown> = {};

  for (const field of policy.toolArgumentFields) {
    if (field === "kind" || field === "ferry") continue; // gestiti sotto
    const v = collected[field];
    if (!isEmpty(v)) args[field] = v;
  }

  if (policy.toolArgumentFields.includes("kind")) {
    const explicit = typeof collected.kind === "string" ? collected.kind : undefined;
    const kind = explicit ?? policy.forcedKind;
    if (kind) args.kind = kind;
  }

  // update_group_ferry: costruisce l'oggetto `ferry` dai singoli slot.
  if (operation === "update_group_ferry") {
    const dir = collected.ferryDirection === "return" ? "return" : "outbound";
    const ferry: Record<string, unknown> = {};
    if (!isEmpty(collected.ferryCompany)) ferry[`${dir}_ferry_company`] = collected.ferryCompany;
    if (!isEmpty(collected.ferryTime)) ferry[`${dir}_ferry_time`] = collected.ferryTime;
    if (!isEmpty(collected.ferryPort)) ferry[`${dir}_departure_port`] = collected.ferryPort;
    args.ferry = ferry;
  }

  return args;
}

/** §36 — warning di preview che NON vanno confermati silenziosamente:
 *  l'orchestrator li converte in clarification invece di "Confermi?". */
export const BLOCKING_PREVIEW_WARNINGS: ReadonlySet<string> = new Set([
  "planned_pax_exceeds_group_expected",
  "stop_pax_overbooked",
]);

/**
 * §24 — presentazione co-locata con la policy (NON logica sparsa
 * nell'orchestrator): dato il codice del campo mancante restituito da
 * `evaluateMarioOperationPolicy`, la domanda breve da porre all'utente. La
 * business rule ("serve la data") resta nel catalogo; qui c'è solo il testo.
 */
const MARIO_FIELD_QUESTIONS: Record<string, string> = {
  // FIX A.4.4 §1/§11 — mai il formato interno YYYY-MM-DD mostrato all'utente:
  // solo un esempio nel formato utente DD-MM-YYYY.
  serviceDate: "Per quale data? (es. 13-09-2026)",
  name: "Come si chiama il gruppo?",
  expectedPax: "Quante persone?",
  city: "Da quale città parte / a quale città si riferisce la fermata?",
  direction: "È in arrivo a Ischia o in partenza da Ischia?",
  bookingGroupId: "Di quale gruppo prenotazione si tratta?",
  bookingGroupStopId: "Per quale fermata del gruppo?",
  passengers: "Quali nominativi devo aggiungere?",
  busUnitId: "Quale mezzo devo riservare?",
  reservedPax: "Per quanti posti?",
  ferryDirection: "Si tratta dell'andata o del ritorno?",
  ferryField: "Cosa devo impostare del traghetto (compagnia, orario, porto)?",
  serviceId: "Di quale servizio si tratta?",
  driverId: "Quale autista devo assegnare?",
  targetStatus: "A quale stato devo portarlo?",
};

export function questionForMissingField(field: string | undefined): string {
  if (!field) return "Mi serve qualche informazione in più per procedere.";
  return MARIO_FIELD_QUESTIONS[field] ?? `Mi serve anche: ${field}.`;
}
