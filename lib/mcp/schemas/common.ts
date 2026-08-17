import { z } from "zod";

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;

export const limitSchema = z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT);

export const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Formato data non valido (YYYY-MM-DD).");

export const uuidSchema = z.string().uuid("UUID non valido.");
