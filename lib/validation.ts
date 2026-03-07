import { z } from "zod";

export const roleSchema = z.enum(["admin", "operator", "driver", "agency"]);

export const serviceStatusSchema = z.enum(["needs_review", "new", "assigned", "partito", "arrivato", "completato", "problema", "cancelled"]);
export const serviceTypeSchema = z.enum(["transfer", "bus_tour"]);

export const serviceCreateSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  time: z.string().regex(/^\d{2}:\d{2}$/),
  service_type: serviceTypeSchema.default("transfer"),
  direction: z.enum(["arrival", "departure"]),
  vessel: z.string().min(2).max(80),
  pax: z.number().int().min(1).max(16),
  hotel_id: z.string().uuid(),
  customer_name: z.string().min(2).max(120),
  phone: z.string().min(6).max(30),
  notes: z.string().max(500),
  tour_name: z.string().max(120).optional().or(z.literal("")),
  capacity: z.number().int().min(1).max(120).optional().nullable(),
  meeting_point: z.string().max(160).optional().or(z.literal("")),
  stops: z.array(z.string().min(1).max(120)).max(20).optional().nullable(),
  bus_plate: z.string().max(32).optional().or(z.literal("")),
  status: serviceStatusSchema
}).superRefine((value, ctx) => {
  if (value.service_type === "bus_tour") {
    if (!value.tour_name || value.tour_name.trim().length < 2) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "tour_name richiesto per service_type bus_tour",
        path: ["tour_name"]
      });
    }
    if (!value.meeting_point || value.meeting_point.trim().length < 2) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "meeting_point richiesto per service_type bus_tour",
        path: ["meeting_point"]
      });
    }
    if (!value.capacity || value.capacity < value.pax) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "capacity deve essere >= pax per bus_tour",
        path: ["capacity"]
      });
    }
  }
});

export const assignmentSchema = z.object({
  service_id: z.string().uuid(),
  driver_user_id: z.string().uuid(),
  vehicle_label: z.string().min(3).max(120)
});

export const statusEventSchema = z.object({
  service_id: z.string().uuid(),
  status: serviceStatusSchema
});

export const inboundEmailSchema = z.object({
  tenant_id: z.string().uuid(),
  raw_text: z.string().min(10)
});

export const inboundWebhookSchema = z.object({
  tenant_id: z.string().uuid(),
  raw_text: z.string().min(10),
  source: z.string().max(80).optional(),
  template_key: z.string().max(80).optional(),
  mailbox: z.string().max(120).optional(),
  from_email: z.string().email().optional(),
  subject: z.string().max(240).optional(),
  received_at: z.string().datetime().optional(),
  attachments: z
    .array(
      z.object({
        filename: z.string().min(1).max(240),
        mime_type: z.string().max(120).optional(),
        size_bytes: z.number().int().min(0).optional(),
        content_base64: z.string().min(10).optional()
      })
    )
    .max(30)
    .optional()
});

export const onboardingTenantSchema = z.object({
  company_name: z.string().min(2).max(120)
});

export const onboardingDriverSchema = z.object({
  full_name: z.string().min(2).max(120),
  email: z.string().email().max(160),
  password: z.string().min(8).max(120)
});

export const onboardingDriversBatchSchema = z.object({
  tenant_id: z.string().uuid(),
  drivers: z.array(onboardingDriverSchema).max(20)
});

export const vehicleCreateSchema = z.object({
  label: z.string().min(2).max(120),
  plate: z.string().max(32).optional().or(z.literal("")),
  capacity: z.number().int().min(1).max(120).optional().nullable()
});

export const onboardingGeoSettingsSchema = z.object({
  tenant_id: z.string().uuid(),
  zones: z.array(z.string().min(1).max(120)).max(50),
  ports: z.array(z.string().min(1).max(120)).max(50)
});
