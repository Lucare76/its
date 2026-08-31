import { describe, it, expect } from "vitest";
import {
  MARIO_OPERATION_POLICIES,
  classifyMarioOperation,
  evaluateMarioOperationPolicy,
  buildMcpArguments,
  questionForMissingField,
  mentionsPhysicalBus,
  BLOCKING_PREVIEW_WARNINGS,
} from "@/lib/server/mario-assistant/operation-policy";

describe("classifyMarioOperation — §3/§5/§11", () => {
  it("rawType già valido → passthrough", () => {
    expect(classifyMarioOperation({ rawType: "create_bus_group" })).toBe("create_bus_group");
  });
  it("gruppo generico (nessun 'bus')", () => {
    expect(classifyMarioOperation({ message: "Fammi un gruppo Juventus da 50 persone" })).toBe("create_generic_booking_group");
  });
  it("'bus' nel testo → create_bus_group", () => {
    expect(classifyMarioOperation({ message: "Creami un bus per Lucia La Marra, 50 persone" })).toBe("create_bus_group");
    expect(classifyMarioOperation({ message: "un pullman da 50" })).toBe("create_bus_group");
  });
  it("'bus esclusivo / dedicato' → create_exclusive_bus_group", () => {
    expect(classifyMarioOperation({ message: "bus esclusivo di 50 persone per La Marra" })).toBe("create_exclusive_bus_group");
    expect(classifyMarioOperation({ message: "mezzo dedicato al gruppo" })).toBe("create_exclusive_bus_group");
  });
  it("kind esplicito vince sul testo", () => {
    expect(classifyMarioOperation({ kind: "bus_exclusive", message: "gruppo generico" })).toBe("create_exclusive_bus_group");
  });
  it("tool → operazione", () => {
    expect(classifyMarioOperation({ toolName: "its.preview_add_booking_group_stop" })).toBe("add_booking_group_stop");
    expect(classifyMarioOperation({ toolName: "its.preview_booking_group_operationalization" })).toBe("operationalize_group");
  });
});

describe("evaluateMarioOperationPolicy — §4/§5/§27", () => {
  it("§4 gruppo generico: name+pax bastano (data opzionale)", () => {
    const r = evaluateMarioOperationPolicy({ operation: "create_generic_booking_group", collected: { name: "Juventus", expectedPax: 50 } });
    expect(r.readyForPreview).toBe(true);
    expect(r.missingRequired).toEqual([]);
  });
  it("§5/§27 bus group: senza data NON è pronto (vince la policy sul modello)", () => {
    const r = evaluateMarioOperationPolicy({ operation: "create_bus_group", collected: { name: "La Marra", expectedPax: 50 } });
    expect(r.readyForPreview).toBe(false);
    expect(r.missingRequired).toEqual(["serviceDate"]);
    expect(r.nextQuestionField).toBe("serviceDate");
  });
  it("§5 bus group: con data è pronto", () => {
    const r = evaluateMarioOperationPolicy({ operation: "create_bus_group", collected: { name: "La Marra", expectedPax: 50, serviceDate: "2026-09-13" } });
    expect(r.readyForPreview).toBe(true);
  });
  it("§6 origin viene riportato in preservedFields, non in missing", () => {
    const r = evaluateMarioOperationPolicy({ operation: "create_bus_group", collected: { name: "X", expectedPax: 10, serviceDate: "2026-09-13", origin: "Rimini" } });
    expect(r.preservedFields).toMatchObject({ origin: "Rimini" });
  });
  it("§9/§36 stop pax > totale gruppo → warning, non ready", () => {
    const r = evaluateMarioOperationPolicy({
      operation: "add_booking_group_stop",
      collected: { bookingGroupId: "g1", city: "Guidonia", expectedPax: 40, direction: "arrival" },
      groupExpectedPax: 50,
      plannedPaxOtherStops: 20,
    });
    expect(r.warnings).toContain("stop_pax_exceeds_group_total");
    expect(r.readyForPreview).toBe(false);
  });
  it("§9 somma sotto il totale → nessun warning", () => {
    const r = evaluateMarioOperationPolicy({
      operation: "add_booking_group_stop",
      collected: { bookingGroupId: "g1", city: "Guidonia", expectedPax: 30, direction: "arrival" },
      groupExpectedPax: 50,
      plannedPaxOtherStops: 20,
    });
    expect(r.warnings).toEqual([]);
    expect(r.readyForPreview).toBe(true);
  });
  it("§12 add stop: city da sola non basta (servono expectedPax e direction)", () => {
    const r = evaluateMarioOperationPolicy({ operation: "add_booking_group_stop", collected: { bookingGroupId: "g1", city: "Tivoli" } });
    expect(r.missingRequired).toEqual(["expectedPax", "direction"]);
  });
});

describe("buildMcpArguments — §28", () => {
  it("create bus group: solo campi dello schema, kind forzato, MAI origin/pickupPoint", () => {
    const args = buildMcpArguments("create_bus_group", { name: "La Marra", expectedPax: 50, serviceDate: "2026-09-13", origin: "Rimini", pickupPoint: "Stazione" });
    expect(args).toEqual({ name: "La Marra", expectedPax: 50, serviceDate: "2026-09-13", kind: "bus_group" });
    expect(args).not.toHaveProperty("origin");
    expect(args).not.toHaveProperty("pickupPoint");
  });
  it("create exclusive: kind bus_exclusive", () => {
    expect(buildMcpArguments("create_exclusive_bus_group", { name: "X", expectedPax: 5, serviceDate: "2026-09-13" })).toMatchObject({ kind: "bus_exclusive" });
  });
  it("create generic: nessun kind forzato se non specificato", () => {
    expect(buildMcpArguments("create_generic_booking_group", { name: "X", expectedPax: 5 })).toEqual({ name: "X", expectedPax: 5 });
  });
  it("add stop: §7 pickupPoint resta pickupPoint, mai concatenato in city", () => {
    const args = buildMcpArguments("add_booking_group_stop", { bookingGroupId: "g1", city: "Tivoli", pickupPoint: "Villa d'Este", expectedPax: 20, direction: "arrival" });
    expect(args).toEqual({ bookingGroupId: "g1", city: "Tivoli", pickupPoint: "Villa d'Este", expectedPax: 20, direction: "arrival" });
  });
  it("update ferry: costruisce l'oggetto ferry con prefisso direzione", () => {
    const args = buildMcpArguments("update_group_ferry", { bookingGroupId: "g1", ferryDirection: "outbound", ferryCompany: "SNAV", ferryTime: "09:30" });
    expect(args).toEqual({ bookingGroupId: "g1", ferry: { outbound_ferry_company: "SNAV", outbound_ferry_time: "09:30" } });
  });
});

describe("mentionsPhysicalBus — §11/§37", () => {
  it("'bus da 54 posti' → mezzo fisico", () => {
    expect(mentionsPhysicalBus("Prenotami un bus da 54 posti per La Marra")).toBe(true);
  });
  it("'bus La Marra da 50 persone' → NON mezzo fisico (pax, non posti)", () => {
    expect(mentionsPhysicalBus("Fammi il bus La Marra da 50 persone")).toBe(false);
  });
});

describe("questionForMissingField", () => {
  it("serviceDate → chiede la data", () => {
    expect(questionForMissingField("serviceDate")).toMatch(/data/i);
  });
  it("campo sconosciuto → fallback generico col nome campo", () => {
    expect(questionForMissingField("bananas")).toContain("bananas");
  });
});

describe("catalogo policy — coerenza", () => {
  it("ogni policy ha un mcpTool 'its.preview_'", () => {
    for (const p of Object.values(MARIO_OPERATION_POLICIES)) {
      expect(p.mcpTool.startsWith("its.preview_")).toBe(true);
    }
  });
  it("BLOCKING_PREVIEW_WARNINGS contiene il codice pax fermate", () => {
    expect(BLOCKING_PREVIEW_WARNINGS.has("planned_pax_exceeds_group_expected")).toBe(true);
  });
});
