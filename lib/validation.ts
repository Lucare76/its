import { z } from "zod";

export const roleSchema = z.enum(["admin", "operator", "driver", "agency"]);

export const serviceStatusSchema = z.enum(["needs_review", "new", "assigned", "partito", "arrivato", "completato", "problema", "cancelled"]);
export const serviceTypeSchema = z.enum(["transfer", "bus_tour"]);
export const agencyBookingServiceKindSchema = z.enum([
  "transfer_port_hotel",
  "transfer_airport_hotel",
  "transfer_train_hotel",
  "bus_city_hotel",
  "excursion"
]);

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
  low_seat_threshold: z.number().int().min(0).max(120).optional().nullable(),
  minimum_passengers: z.number().int().min(1).max(120).optional().nullable(),
  waitlist_enabled: z.boolean().optional(),
  waitlist_count: z.number().int().min(0).max(500).optional().nullable(),
  meeting_point: z.string().max(160).optional().or(z.literal("")),
  stops: z.array(z.string().min(1).max(120)).max(20).optional().nullable(),
  bus_plate: z.string().max(32).optional().or(z.literal("")),
  billing_party_name: z.string().max(160).optional().or(z.literal("")),
  customer_email: z.string().email().max(160).optional().or(z.literal("")),
  booking_service_kind: agencyBookingServiceKindSchema.optional(),
  service_type_code: z
    .enum(["transfer_station_hotel", "transfer_airport_hotel", "transfer_port_hotel", "transfer_hotel_port", "excursion", "ferry_transfer", "bus_line"])
    .optional(),
  arrival_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().or(z.literal("")),
  arrival_time: z.string().regex(/^\d{2}:\d{2}$/).optional().or(z.literal("")),
  departure_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().or(z.literal("")),
  departure_time: z.string().regex(/^\d{2}:\d{2}$/).optional().or(z.literal("")),
  transport_code: z.string().max(80).optional().or(z.literal("")),
  bus_city_origin: z.string().max(120).optional().or(z.literal("")),
  status: serviceStatusSchema
}).superRefine((value, ctx) => {
  if (value.service_type === "bus_tour" || value.booking_service_kind === "bus_city_hotel" || value.service_type_code === "bus_line") {
    if (!value.tour_name || value.tour_name.trim().length < 2) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "tour_name richiesto per servizi bus",
        path: ["tour_name"]
      });
    }
    if (!value.meeting_point || value.meeting_point.trim().length < 2) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "meeting_point richiesto per servizi bus",
        path: ["meeting_point"]
      });
    }
    if (!value.capacity || value.capacity < value.pax) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "capacity deve essere >= pax per servizi bus",
        path: ["capacity"]
      });
    }
    if (value.minimum_passengers && value.capacity && value.minimum_passengers > value.capacity) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "minimum_passengers non puo superare la capacity del bus",
        path: ["minimum_passengers"]
      });
    }
    if (value.low_seat_threshold !== null && value.low_seat_threshold !== undefined && value.capacity && value.low_seat_threshold > value.capacity) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "low_seat_threshold non puo superare la capacity del bus",
        path: ["low_seat_threshold"]
      });
    }
  }

  const arrivalDate = value.arrival_date || value.date;
  const arrivalTime = value.arrival_time || value.time;
  const departureDate = value.departure_date || "";
  const departureTime = value.departure_time || "";
  if (departureDate && departureTime) {
    const start = new Date(`${arrivalDate}T${arrivalTime}:00`);
    const end = new Date(`${departureDate}T${departureTime}:00`);
    if (!Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime()) && end < start) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "La data/ora di ritorno non puo essere precedente all'andata.",
        path: ["departure_date"]
      });
    }
  }

  if (value.booking_service_kind === "bus_city_hotel" && (!value.bus_city_origin || value.bus_city_origin.trim().length < 2)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Origine linea bus obbligatoria per bus city/hotel.",
      path: ["bus_city_origin"]
    });
  }

  if (
    (value.booking_service_kind === "transfer_airport_hotel" || value.booking_service_kind === "transfer_train_hotel") &&
    (!value.transport_code || value.transport_code.trim().length < 2)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Riferimento volo/treno obbligatorio per aeroporto o stazione.",
      path: ["transport_code"]
    });
  }
});

export const agencyBookingCreateSchema = z
  .object({
    customer_first_name: z.string().min(2).max(80),
    customer_last_name: z.string().min(2).max(80),
    customer_phone: z.string().min(6).max(30),
    customer_email: z.string().email().max(160).optional().or(z.literal("")),
    pax: z.number().int().min(1).max(16),
    hotel_id: z.string().uuid(),
    booking_service_kind: agencyBookingServiceKindSchema,
    arrival_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    arrival_time: z.string().regex(/^\d{2}:\d{2}$/),
    departure_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    departure_time: z.string().regex(/^\d{2}:\d{2}$/),
    transport_code: z.string().max(80).optional().or(z.literal("")),
    bus_city_origin: z.string().max(120).optional().or(z.literal("")),
    include_ferry_tickets: z.boolean().default(false),
    ferry_outbound_code: z.string().max(80).optional().or(z.literal("")),
    ferry_return_code: z.string().max(80).optional().or(z.literal("")),
    excursion_title: z.string().max(160).optional().or(z.literal("")),
    notes: z.string().max(2000),
    agency_id: z.string().uuid().optional().or(z.literal(""))
  })
  .superRefine((value, ctx) => {
    if (
      (value.booking_service_kind === "transfer_airport_hotel" || value.booking_service_kind === "transfer_train_hotel") &&
      (!value.transport_code || value.transport_code.trim().length < 2)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Numero volo/treno obbligatorio per aeroporto/stazione.",
        path: ["transport_code"]
      });
    }
    if (value.booking_service_kind === "bus_city_hotel" && (!value.bus_city_origin || value.bus_city_origin.trim().length < 2)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Citta di partenza bus obbligatoria.",
        path: ["bus_city_origin"]
      });
    }
    if (value.booking_service_kind === "excursion" && (!value.excursion_title || value.excursion_title.trim().length < 2)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Nome escursione obbligatorio.",
        path: ["excursion_title"]
      });
    }

    const arrivalDateTime = new Date(`${value.arrival_date}T${value.arrival_time}:00`);
    const departureDateTime = new Date(`${value.departure_date}T${value.departure_time}:00`);
    if (!Number.isNaN(arrivalDateTime.getTime()) && !Number.isNaN(departureDateTime.getTime()) && departureDateTime < arrivalDateTime) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Partenza non puo essere precedente all'arrivo.",
        path: ["departure_date"]
      });
    }
  });

export const assignmentSchema = z.object({
  service_id: z.string().uuid(),
  driver_user_id: z.string().uuid().nullable().optional(),
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

export const adminUserCreateSchema = z.object({
  full_name: z.string().min(2).max(120),
  email: z.string().email().max(160),
  password: z.string().min(8).max(120),
  role: roleSchema
});

export const adminUserUpdateSchema = z.object({
  user_id: z.string().uuid(),
  full_name: z.string().min(2).max(120),
  role: roleSchema,
  password: z.string().min(8).max(120).optional(),
  suspended: z.boolean().optional()
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
