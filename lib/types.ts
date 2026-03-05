export type UserRole = "admin" | "operator" | "driver" | "agency";

export type ServiceDirection = "arrival" | "departure";
export type ServiceType = "transfer" | "bus_tour";

export type ServiceStatus = "needs_review" | "new" | "assigned" | "partito" | "arrivato" | "completato" | "problema" | "cancelled";
export type ReminderStatus = "pending" | "sent" | "delivered" | "read" | "failed";

export interface Membership {
  user_id: string;
  tenant_id: string;
  role: UserRole;
  full_name: string;
}

export interface Hotel {
  id: string;
  tenant_id: string;
  name: string;
  address: string;
  lat: number;
  lng: number;
  zone: "Ischia Porto" | "Ischia Ponte" | "Casamicciola" | "Lacco Ameno" | "Forio" | "Barano" | "Serrara Fontana";
}

export interface Service {
  id: string;
  tenant_id: string;
  inbound_email_id?: string | null;
  is_draft?: boolean;
  date: string;
  time: string;
  service_type?: ServiceType;
  direction: ServiceDirection;
  vessel: string;
  pax: number;
  hotel_id: string;
  customer_name: string;
  created_by_user_id?: string | null;
  phone: string;
  phone_e164?: string | null;
  notes: string;
  tour_name?: string | null;
  capacity?: number | null;
  meeting_point?: string | null;
  stops?: string[] | null;
  bus_plate?: string | null;
  reminder_status?: ReminderStatus | null;
  message_id?: string | null;
  sent_at?: string | null;
  status: ServiceStatus;
}

export interface Assignment {
  id: string;
  tenant_id: string;
  service_id: string;
  driver_user_id: string | null;
  vehicle_label: string;
  created_at?: string;
}

export interface StatusEvent {
  id: string;
  service_id: string;
  status: ServiceStatus;
  at: string;
  by_user_id: string;
  tenant_id: string;
}

export interface InboundEmail {
  id: string;
  tenant_id: string;
  raw_text: string;
  from_email?: string | null;
  subject?: string | null;
  body_text?: string | null;
  body_html?: string | null;
  raw_json?: Record<string, unknown>;
  extracted_text?: string | null;
  parsed_json: {
    date?: string;
    time?: string;
    vessel?: string;
    hotel?: string;
    pickup?: string;
    dropoff?: string;
    pax?: number;
    customer_name?: string;
    phone?: string;
    template_key?: string;
    source?: string;
    mailbox?: string;
    from_email?: string;
    subject?: string;
    received_at?: string;
    attachments?: Array<{
      filename: string;
      mime_type?: string;
      size_bytes?: number;
    }>;
  };
  created_at: string;
}

export interface DemoState {
  hotels: Hotel[];
  services: Service[];
  assignments: Assignment[];
  statusEvents: StatusEvent[];
  inboundEmails: InboundEmail[];
  memberships: Membership[];
}
