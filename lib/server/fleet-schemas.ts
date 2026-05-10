import { z } from "zod";

const optionalDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional();
const placeholderFiscalDocumentHosts = new Set(["example.com", "example.org", "example.net"]);

const optionalFiscalDocumentUrl = z
  .string()
  .url()
  .max(2000)
  .nullable()
  .optional()
  .refine((value) => {
    if (!value) return true;
    try {
      return !placeholderFiscalDocumentHosts.has(new URL(value).hostname.toLowerCase());
    } catch {
      return false;
    }
  }, "Il documento fiscale deve puntare a un file reale, non a un link di esempio.");

export const vehicleUpsertSchema = z.object({
  id: z.string().uuid().optional(),
  label: z.string().min(2).max(120),
  plate: z.string().max(32).optional().nullable(),
  capacity: z.number().int().min(1).max(120).nullable(),
  vehicle_size: z.enum(["small", "medium", "large", "bus"]).nullable(),
  habitual_driver_user_id: z.string().uuid().optional().nullable(),
  default_zone: z.string().max(120).optional().nullable(),
  blocked_until: z.string().datetime().optional().nullable(),
  blocked_reason: z.string().max(500).optional().nullable(),
  notes: z.string().max(2000).optional().nullable(),
  is_blocked_manual: z.boolean().optional().default(false),
  active: z.boolean().optional().default(true),
  radius_vehicle_id: z.string().max(120).optional().nullable(),
  insurance_expiry: optionalDate,
  road_tax_expiry: optionalDate,
  inspection_expiry: optionalDate,
  km: z.number().int().min(0).nullable().optional(),
  telaio: z.string().max(80).nullable().optional(),
  license_number: z.string().max(80).nullable().optional(),
});

export const maintenanceRecordSchema = z.object({
  maintenance_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  description: z.string().min(2).max(500),
  cost: z.number().min(0).nullable().optional(),
  km_at_service: z.number().int().min(0).nullable().optional(),
  provider: z.string().max(160).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
  maintenance_kind: z.enum(["ordinary", "extraordinary"]).default("ordinary"),
  execution_mode: z.enum(["single", "multiple"]).default("single"),
  replaced_parts: z.array(z.string().min(1).max(160)).max(30).default([]),
});

export const fuelRecordSchema = z.object({
  fuel_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  liters: z.number().min(0).nullable().optional(),
  cost: z.number().min(0).nullable().optional(),
  km_at_fuel: z.number().int().min(0).nullable().optional(),
  fuel_type: z.string().max(40).nullable().optional(),
  station: z.string().max(160).nullable().optional(),
  notes: z.string().max(1000).nullable().optional(),
  approval_status: z.enum(["pending", "approved", "rejected"]).optional(),
  fiscal_document_url: optionalFiscalDocumentUrl,
  fiscal_document_name: z.string().max(240).nullable().optional(),
  submitted_via_qr: z.boolean().optional(),
});

export const fuelApprovalSchema = z.object({
  id: z.string().uuid(),
  approval_status: z.enum(["approved", "rejected"]),
  fiscal_document_url: optionalFiscalDocumentUrl,
  fiscal_document_name: z.string().max(240).nullable().optional(),
});

export const sparePartRecordSchema = z.object({
  order_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  part_name: z.string().min(2).max(240),
  quantity: z.number().int().min(1).default(1),
  cost: z.number().min(0).nullable().optional(),
  supplier: z.string().max(160).nullable().optional(),
  status: z.enum(["ordered", "received", "installed"]).default("ordered"),
  installed_at: optionalDate,
  notes: z.string().max(1000).nullable().optional(),
});

export const inventorySparePartSchema = z.object({
  id: z.string().uuid().optional(),
  vehicle_id: z.string().uuid().nullable().optional(),
  part_name: z.string().min(2).max(240),
  part_code: z.string().max(120).nullable().optional(),
  supplier: z.string().max(160).nullable().optional(),
  ordered_from: z.string().max(160).nullable().optional(),
  ordered_by_name: z.string().max(160).nullable().optional(),
  order_date: optionalDate,
  unit_cost: z.number().min(0).nullable().optional(),
  quantity_on_hand: z.number().int().min(0).default(0),
  quantity_ordered: z.number().int().min(0).default(0),
  status: z.enum(["available", "ordered", "out_of_stock"]).default("available"),
  notes: z.string().max(2000).nullable().optional(),
});

export const inventorySparePartUpdateSchema = inventorySparePartSchema.extend({
  id: z.string().uuid(),
});
