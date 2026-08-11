import { z } from "zod";

/**
 * Input accettato dal client per il preflight: SOLO identificatori.
 * Nessun altro campo (cliente, pax, data, tratta, orario, prezzo) viene
 * mai accettato dal browser — il server ricostruisce tutto dal DB.
 */
export const preflightInputSchema = z.object({
  service_ids: z.array(z.string().uuid()).min(1).max(20),
});

export type PreflightInput = z.infer<typeof preflightInputSchema>;
