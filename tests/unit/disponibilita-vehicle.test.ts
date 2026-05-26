import { describe, it, expect } from "vitest";
import { z } from "zod";

// ─── Schema (mirrors app/api/ops/disponibilita/route.ts) ────────────────────

const timeRe = /^\d{2}:\d{2}$/;

const saveDriverSchema = z.object({
  action: z.literal("save_driver"),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  driver_profile_id: z.string().uuid(),
  available: z.boolean(),
  available_from: z.string().regex(timeRe).nullable().optional(),
  available_to: z.string().regex(timeRe).nullable().optional(),
  notes: z.string().max(500).optional().nullable(),
  vehicle_1_id: z.string().uuid().nullable().optional(),
  vehicle_1_from: z.string().regex(timeRe).nullable().optional(),
  vehicle_1_to: z.string().regex(timeRe).nullable().optional(),
  vehicle_2_id: z.string().uuid().nullable().optional(),
  vehicle_2_from: z.string().regex(timeRe).nullable().optional(),
  vehicle_2_to: z.string().regex(timeRe).nullable().optional(),
});

// ─── emptyAvail (mirrors page.tsx) ──────────────────────────────────────────

function emptyAvail(driverId: string, userId: string | null) {
  return {
    driver_profile_id: driverId,
    driver_user_id: userId,
    available: true,
    available_from: null,
    available_to: null,
    notes: null,
    vehicle_1_id: null,
    vehicle_1_from: null,
    vehicle_1_to: null,
    vehicle_2_id: null,
    vehicle_2_from: null,
    vehicle_2_to: null,
  };
}

const DRIVER_ID = "11111111-1111-1111-1111-111111111111";
const VEHICLE_ID = "22222222-2222-2222-2222-222222222222";
const VEHICLE_2_ID = "33333333-3333-3333-3333-333333333333";
const DATE = "2026-05-27";

// ─── Schema validation ───────────────────────────────────────────────────────

describe("save_driver schema — vehicle fields", () => {
  it("accetta vehicle_1_id UUID valido", () => {
    const result = saveDriverSchema.safeParse({
      action: "save_driver",
      date: DATE,
      driver_profile_id: DRIVER_ID,
      available: true,
      vehicle_1_id: VEHICLE_ID,
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.vehicle_1_id).toBe(VEHICLE_ID);
  });

  it("accetta vehicle_1_id null (nessun mezzo assegnato)", () => {
    const result = saveDriverSchema.safeParse({
      action: "save_driver",
      date: DATE,
      driver_profile_id: DRIVER_ID,
      available: true,
      vehicle_1_id: null,
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.vehicle_1_id).toBeNull();
  });

  it("accetta payload senza campi vehicle (backward compat)", () => {
    const result = saveDriverSchema.safeParse({
      action: "save_driver",
      date: DATE,
      driver_profile_id: DRIVER_ID,
      available: true,
    });
    expect(result.success).toBe(true);
  });

  it("rifiuta vehicle_1_id non-UUID", () => {
    const result = saveDriverSchema.safeParse({
      action: "save_driver",
      date: DATE,
      driver_profile_id: DRIVER_ID,
      available: true,
      vehicle_1_id: "non-un-uuid",
    });
    expect(result.success).toBe(false);
  });

  it("accetta 2 mezzi con fasce orarie", () => {
    const result = saveDriverSchema.safeParse({
      action: "save_driver",
      date: DATE,
      driver_profile_id: DRIVER_ID,
      available: true,
      vehicle_1_id: VEHICLE_ID,
      vehicle_1_from: "08:00",
      vehicle_1_to: "13:00",
      vehicle_2_id: VEHICLE_2_ID,
      vehicle_2_from: "13:00",
      vehicle_2_to: "20:00",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.vehicle_1_id).toBe(VEHICLE_ID);
      expect(result.data.vehicle_2_id).toBe(VEHICLE_2_ID);
      expect(result.data.vehicle_1_to).toBe("13:00");
      expect(result.data.vehicle_2_from).toBe("13:00");
    }
  });

  it("rifiuta fasce orarie malformate (HH:MM non rispettato)", () => {
    const result = saveDriverSchema.safeParse({
      action: "save_driver",
      date: DATE,
      driver_profile_id: DRIVER_ID,
      available: true,
      vehicle_1_id: VEHICLE_ID,
      vehicle_1_from: "8:00",
    });
    expect(result.success).toBe(false);
  });
});

// ─── Merge logic (mirrors saveDriverAvail in page.tsx) ───────────────────────

describe("saveDriverAvail merge logic", () => {
  it("vehicle_1_id rimane nel merged quando onBlur non passa override", () => {
    const current = { ...emptyAvail(DRIVER_ID, null), vehicle_1_id: VEHICLE_ID };
    const overrides = {};
    const merged = { ...current, ...overrides };
    expect(merged.vehicle_1_id).toBe(VEHICLE_ID);
  });

  it("vehicle_1_id viene sovrascritto dall'override esplicito", () => {
    const current = { ...emptyAvail(DRIVER_ID, null), vehicle_1_id: VEHICLE_ID };
    const overrides = { vehicle_1_id: VEHICLE_2_ID };
    const merged = { ...current, ...overrides };
    expect(merged.vehicle_1_id).toBe(VEHICLE_2_ID);
  });

  it("vehicle_1_id viene azzerato da override esplicito null", () => {
    const current = { ...emptyAvail(DRIVER_ID, null), vehicle_1_id: VEHICLE_ID };
    const overrides = { vehicle_1_id: null };
    const merged = { ...current, ...overrides };
    expect(merged.vehicle_1_id).toBeNull();
  });

  it("override vehicle_1_id su emptyAvail produce merged corretto", () => {
    const current = emptyAvail(DRIVER_ID, null);
    const overrides = { vehicle_1_id: VEHICLE_ID };
    const merged = { ...current, ...overrides };
    expect(merged.vehicle_1_id).toBe(VEHICLE_ID);
    expect(merged.available).toBe(true);
    expect(merged.available_from).toBeNull();
  });

  it("entrambi i mezzi e fasce orarie presenti nel merged", () => {
    const current = emptyAvail(DRIVER_ID, null);
    const overrides = {
      vehicle_1_id: VEHICLE_ID,
      vehicle_1_from: "08:00",
      vehicle_1_to: "13:00",
      vehicle_2_id: VEHICLE_2_ID,
      vehicle_2_from: "13:00",
      vehicle_2_to: "20:00",
    };
    const merged = { ...current, ...overrides };
    expect(merged.vehicle_1_id).toBe(VEHICLE_ID);
    expect(merged.vehicle_1_to).toBe("13:00");
    expect(merged.vehicle_2_id).toBe(VEHICLE_2_ID);
    expect(merged.vehicle_2_from).toBe("13:00");
  });
});

// ─── GET response mapping (mirrors route.ts driverAvailData transform) ───────

describe("GET response mapping — vehicle fields", () => {
  function mapRow(row: Record<string, unknown>) {
    return {
      driver_profile_id: row.driver_profile_id as string,
      driver_user_id: row.driver_user_id as string | null,
      available: row.available as boolean,
      available_from: row.available_from as string | null,
      available_to: row.available_to as string | null,
      notes: row.notes as string | null,
      vehicle_1_id: (row as Record<string, unknown>).vehicle_1_id as string | null ?? null,
      vehicle_1_from: (row as Record<string, unknown>).vehicle_1_from as string | null ?? null,
      vehicle_1_to: (row as Record<string, unknown>).vehicle_1_to as string | null ?? null,
      vehicle_2_id: (row as Record<string, unknown>).vehicle_2_id as string | null ?? null,
      vehicle_2_from: (row as Record<string, unknown>).vehicle_2_from as string | null ?? null,
      vehicle_2_to: (row as Record<string, unknown>).vehicle_2_to as string | null ?? null,
    };
  }

  it("mappa vehicle_1_id dalla riga DB", () => {
    const row = {
      driver_profile_id: DRIVER_ID,
      driver_user_id: null,
      available: true,
      available_from: "08:00",
      available_to: "20:00",
      notes: null,
      vehicle_1_id: VEHICLE_ID,
      vehicle_1_from: null,
      vehicle_1_to: null,
      vehicle_2_id: null,
      vehicle_2_from: null,
      vehicle_2_to: null,
    };
    const mapped = mapRow(row);
    expect(mapped.vehicle_1_id).toBe(VEHICLE_ID);
  });

  it("restituisce null se vehicle_1_id è null nel DB (nessun mezzo salvato)", () => {
    const row = {
      driver_profile_id: DRIVER_ID,
      driver_user_id: null,
      available: true,
      available_from: null,
      available_to: null,
      notes: null,
      vehicle_1_id: null,
      vehicle_1_from: null,
      vehicle_1_to: null,
      vehicle_2_id: null,
      vehicle_2_from: null,
      vehicle_2_to: null,
    };
    const mapped = mapRow(row);
    expect(mapped.vehicle_1_id).toBeNull();
  });

  it("restituisce null se vehicle_1_id è undefined (migrazione non applicata — fallback)", () => {
    const row = {
      driver_profile_id: DRIVER_ID,
      driver_user_id: null,
      available: true,
      available_from: null,
      available_to: null,
      notes: null,
    };
    const mapped = mapRow(row);
    expect(mapped.vehicle_1_id).toBeNull();
    expect(mapped.vehicle_2_id).toBeNull();
  });

  it("mappa entrambi i mezzi con fasce orarie", () => {
    const row = {
      driver_profile_id: DRIVER_ID,
      driver_user_id: null,
      available: true,
      available_from: "08:00",
      available_to: "20:00",
      notes: null,
      vehicle_1_id: VEHICLE_ID,
      vehicle_1_from: "08:00",
      vehicle_1_to: "13:00",
      vehicle_2_id: VEHICLE_2_ID,
      vehicle_2_from: "13:00",
      vehicle_2_to: "20:00",
    };
    const mapped = mapRow(row);
    expect(mapped.vehicle_1_id).toBe(VEHICLE_ID);
    expect(mapped.vehicle_1_to).toBe("13:00");
    expect(mapped.vehicle_2_id).toBe(VEHICLE_2_ID);
    expect(mapped.vehicle_2_from).toBe("13:00");
  });
});
