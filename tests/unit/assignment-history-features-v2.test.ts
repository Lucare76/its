import { describe, it, expect } from "vitest";
import { buildAssignmentDecisionFeatures, extractFeatures, type CandidateSnapshot } from "@/lib/server/assignment-history";

/**
 * ML Data Collection Sprint 2 — contratto features v2.
 *
 * buildAssignmentDecisionFeatures() è puro (nessun I/O): unisce il payload
 * v1 (extractFeatures, invariato — letto da learned-patterns.ts) con il
 * contesto decisionale opzionale, omettendo le chiavi non fornite invece di
 * scriverle come null esplicito.
 */
describe("buildAssignmentDecisionFeatures — features v2 (ML Data Collection Sprint 2)", () => {
  const baseFeatures = extractFeatures({
    serviceDate: "2026-08-20",
    changeType: "driver_swap",
    fromDriverProfileId: "drv-1",
    toDriverProfileId: "drv-2",
    direction: "arrival",
    zone: "Forio",
    time: "09:00",
    vessel: "Medmar",
    pax: 4,
    isNavetta: false,
  });

  it("1. nessun decision context passato: payload v1 invariato, nessuna chiave v2 aggiunta", () => {
    const merged = buildAssignmentDecisionFeatures(baseFeatures);
    expect(merged).toEqual(baseFeatures);
    expect(Object.keys(merged)).not.toContain("proposal_id");
    expect(Object.keys(merged)).not.toContain("candidates");
  });

  it("2. pattern_key resta nella stessa posizione/formato letto da learned-patterns.ts", () => {
    const merged = buildAssignmentDecisionFeatures(baseFeatures, { source: "auto_assign" });
    expect(merged.pattern_key).toBe(baseFeatures.pattern_key);
    expect(merged.macro_category).toBe(baseFeatures.macro_category);
    expect(merged.time_slot).toBe(baseFeatures.time_slot);
  });

  it("3. campi v2 forniti vengono aggiunti senza toccare i campi v1", () => {
    const candidates: CandidateSnapshot[] = [
      { driver_profile_id: "drv-2", score: 3, rank: 1, hard_ok: true },
      { driver_profile_id: "drv-1", score: 7, rank: 2, hard_ok: true },
    ];
    const merged = buildAssignmentDecisionFeatures(baseFeatures, {
      proposal_id: "prop-1",
      source: "auto_assign",
      was_override: true,
      chosen_rank: 2,
      candidate_count: 2,
      candidates,
      is_sunday: false,
      weekday: 3,
      learned_score_adjustment: -25,
    });
    expect(merged).toMatchObject({
      ...baseFeatures,
      proposal_id: "prop-1",
      source: "auto_assign",
      was_override: true,
      chosen_rank: 2,
      candidate_count: 2,
      candidates,
      is_sunday: false,
      weekday: 3,
      learned_score_adjustment: -25,
    });
  });

  it("4. valori v2 espliciti a null vengono scritti (distinti da 'non fornito')", () => {
    const merged = buildAssignmentDecisionFeatures(baseFeatures, { proposal_id: null, chosen_rank: null });
    expect(merged.proposal_id).toBeNull();
    expect(merged.chosen_rank).toBeNull();
    expect(Object.keys(merged)).not.toContain("source");
  });

  it("5. candidate snapshot contiene solo driver_profile_id/score/rank/hard_ok — nessun campo cliente/nome", () => {
    const candidates: CandidateSnapshot[] = [{ driver_profile_id: "drv-1", score: 1, rank: 1, hard_ok: true }];
    const merged = buildAssignmentDecisionFeatures(baseFeatures, { candidates });
    const text = JSON.stringify(merged).toLowerCase();
    expect(text).not.toMatch(/customer|phone|email|notes|address|passenger|raw_email/);
    expect(Object.keys(candidates[0]!).sort()).toEqual(["driver_profile_id", "hard_ok", "rank", "score"]);
  });

  it("6. PII guard: nessuna chiave/valore relativa a cliente in nessun campo v2 popolato", () => {
    const merged = buildAssignmentDecisionFeatures(baseFeatures, {
      proposal_id: "prop-xyz",
      source: "manual_swap",
      was_override: true,
      chosen_rank: 1,
      candidate_count: 1,
      candidates: [{ driver_profile_id: "drv-1", score: 0, rank: 1, hard_ok: true }],
      is_sunday: true,
      weekday: 0,
      learned_score_adjustment: null,
    });
    const text = JSON.stringify(merged).toLowerCase();
    expect(text).not.toMatch(/customer_name|phone|email|notes|raw_email|passenger_name|address/);
  });
});
