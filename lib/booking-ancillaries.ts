export const INFANT_FIXED_FEE_CENTS = 250;
export const PET_MAX_WEIGHT_KG = 10;

export type BookingAncillaries = {
  infant_count?: number | null;
  medmar_infant_count?: number | null;
  medmar_child_count?: number | null;
  medmar_adult_count?: number | null;
  pet_count?: number | null;
  pet_notes?: string | null;
};

function asNonNegativeInt(value: number | null | undefined) {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(Number(value))) : 0;
}

export function normalizeBookingAncillaries(input: BookingAncillaries) {
  const infantCount = asNonNegativeInt(input.infant_count);
  const medmarInfantCount = asNonNegativeInt(input.medmar_infant_count);
  const medmarChildCount = asNonNegativeInt(input.medmar_child_count);
  const medmarAdultCount = asNonNegativeInt(input.medmar_adult_count);
  const petCount = asNonNegativeInt(input.pet_count);
  const petNotes = input.pet_notes?.trim() || null;
  return { infantCount, medmarInfantCount, medmarChildCount, medmarAdultCount, petCount, petNotes };
}

export function appendBookingAncillaryNotes(notes: string, input: BookingAncillaries) {
  const { infantCount, medmarInfantCount, medmarChildCount, medmarAdultCount, petCount, petNotes } = normalizeBookingAncillaries(input);
  const lines: string[] = [];

  if (infantCount > 0) {
    lines.push(`Infant 0-1,99 anni: ${infantCount} (quota fissa EUR ${(INFANT_FIXED_FEE_CENTS / 100).toFixed(2)} cad.)`);
  }
  if (medmarInfantCount + medmarChildCount + medmarAdultCount > 0) {
    lines.push(`Formula MEDMAR - Infant 0-4: ${medmarInfantCount}; Bambini 4-12: ${medmarChildCount}; Adulti 12+: ${medmarAdultCount}.`);
  }

  if (petCount > 0) {
    const suffix = petNotes ? ` - ${petNotes}` : "";
    lines.push(`Animali piccola taglia max ${PET_MAX_WEIGHT_KG} kg: ${petCount}. Biglietto animale a cura del cliente in biglietteria${suffix}.`);
  }

  return [notes.trim(), ...lines].filter(Boolean).join("\n");
}

export function buildBookingAncillaryDetails(input: BookingAncillaries) {
  const { infantCount, medmarInfantCount, medmarChildCount, medmarAdultCount, petCount, petNotes } = normalizeBookingAncillaries(input);
  return {
    infant_count: infantCount,
    infant_unit_price_cents: INFANT_FIXED_FEE_CENTS,
    infant_total_price_cents: infantCount * INFANT_FIXED_FEE_CENTS,
    medmar_infant_count: medmarInfantCount,
    medmar_child_count: medmarChildCount,
    medmar_adult_count: medmarAdultCount,
    pet_count: petCount,
    pet_max_weight_kg: PET_MAX_WEIGHT_KG,
    pet_ticket_by_customer: petCount > 0,
    pet_notes: petNotes
  };
}
