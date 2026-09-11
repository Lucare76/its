import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Tripwire statico per il bug 0276/0277 (RPC shuttle schedules): un mock JS
 * di `.rpc()` confronta valori con `===` e non può MAI riprodurre un errore
 * di type-checking reale di Postgres ("operator does not exist:
 * service_direction = text") — per questo il bug è arrivato fino in
 * produzione nonostante la suite unit fosse verde. La prova vera vive in
 * tests/integration/shuttle-schedules-atomic-rpc.test.ts (contro Postgres
 * reale). Questo test è un secondo livello, più economico: verifica che il
 * testo SQL della migration corrente contenga i cast espliciti necessari,
 * cosi' una regressione (qualcuno che rimuove un cast per errore) viene
 * segnalata immediatamente dalla suite unit, senza bisogno di un DB.
 */

const MIGRATION_PATH = join(process.cwd(), "supabase/migrations/0277_fix_shuttle_schedule_rpc_enum_types.sql");
const sql = readFileSync(MIGRATION_PATH, "utf8");

describe("migration 0277 — cast enum espliciti nelle RPC shuttle schedules (regressione bug produzione)", () => {
  it("il file esiste ed è non vuoto", () => {
    expect(sql.length).toBeGreaterThan(0);
  });

  it("patch_shuttle_schedule e delete_shuttle_schedule sono entrambe definite", () => {
    expect(sql).toMatch(/create or replace function public\.patch_shuttle_schedule/);
    expect(sql).toMatch(/create or replace function public\.delete_shuttle_schedule/);
  });

  it("il confronto WHERE su direction è castato esplicitamente a public.service_direction (bug originale)", () => {
    const occurrences = sql.match(/s\.direction\s*=\s*p_old_direction::public\.service_direction/g) ?? [];
    // Una volta in patch_shuttle_schedule, una volta in delete_shuttle_schedule.
    expect(occurrences.length).toBe(2);
  });

  it("il confronto WHERE su time è castato esplicitamente a time (bug gemello, mai raggiunto in produzione)", () => {
    const occurrences = sql.match(/s\."time"\s*=\s*p_old_departure_time::time/g) ?? [];
    expect(occurrences.length).toBe(2);
  });

  it("l'INSERT di service_type in patch_shuttle_schedule è castato a public.service_type", () => {
    expect(sql).toMatch(/coalesce\(v_row->>'service_type',\s*'transfer'\)::public\.service_type/);
  });

  it("l'INSERT di status in patch_shuttle_schedule è castato a public.service_status", () => {
    expect(sql).toMatch(/coalesce\(v_row->>'status',\s*'new'\)::public\.service_status/);
  });

  it("l'INSERT di direction resta castato (già corretto in 0276, non regredito)", () => {
    expect(sql).toMatch(/\(v_row->>'direction'\)::public\.service_direction/);
  });

  it("nessun confronto/assegnazione booking_service_kind viene castato (è testo con CHECK, non un enum — un cast qui sarebbe un errore)", () => {
    expect(sql).not.toMatch(/booking_service_kind::public\./);
    expect(sql).not.toMatch(/p_old_booking_service_kind::public\./);
  });

  it("nessun fallback silenzioso: gli errori di cast restano RAISE EXCEPTION reali, non soppressi (niente EXCEPTION WHEN ... THEN NULL/CONTINUE)", () => {
    expect(sql).not.toMatch(/exception\s+when\s+others\s+then/i);
  });
});
