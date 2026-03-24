export type UserRole = "admin" | "operator" | "driver" | "agency";
export type VehicleSize = "small" | "medium" | "large" | "bus";

export type ServiceDirection = "arrival" | "departure";
export type ServiceType = "transfer" | "bus_tour";
export type AgencyBookingServiceKind =
  | "transfer_port_hotel"
  | "transfer_airport_hotel"
  | "transfer_train_hotel"
  | "bus_city_hotel"
  | "excursion";
export type OperationalServiceType =
  | "transfer_station_hotel"
  | "transfer_airport_hotel"
  | "transfer_port_hotel"
  | "transfer_hotel_port"
  | "excursion"
  | "ferry_transfer"
  | "bus_line";
export type TransportMode = "train" | "hydrofoil" | "ferry" | "road_transfer" | "bus" | "unknown";

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
  normalized_name?: string | null;
  address: string;
  city?: string | null;
  lat: number;
  lng: number;
  zone: "Ischia Porto" | "Ischia Ponte" | "Casamicciola" | "Lacco Ameno" | "Forio" | "Barano" | "Serrara Fontana";
  source?: string | null;
  source_osm_type?: "node" | "way" | "relation" | null;
  source_osm_id?: number | null;
  is_active?: boolean;
  updated_at?: string;
}

export interface Service {
  id: string;
  tenant_id: string;
  inbound_email_id?: string | null;
  is_draft?: boolean;
  agency_id?: string | null;
  route_id?: string | null;
  import_id?: string | null;
  applied_price_list_id?: string | null;
  applied_pricing_rule_id?: string | null;
  pricing_currency?: string | null;
  internal_cost_cents?: number | null;
  public_price_cents?: number | null;
  agency_price_cents?: number | null;
  final_price_cents?: number | null;
  source_total_amount_cents?: number | null;
  source_price_per_pax_cents?: number | null;
  source_amount_currency?: string | null;
  margin_cents?: number | null;
  pricing_apply_mode?: "manual" | "auto_rule" | "fallback" | null;
  pricing_confidence?: number | null;
  pricing_applied_at?: string | null;
  pricing_manual_override?: boolean | null;
  pricing_manual_override_reason?: string | null;
  date: string;
  time: string;
  service_type?: ServiceType;
  direction: ServiceDirection;
  vessel: string;
  pax: number;
  hotel_id: string;
  customer_name: string;
  billing_party_name?: string | null;
  outbound_time?: string | null;
  return_time?: string | null;
  transport_mode?: TransportMode | null;
  transport_reference_outward?: string | null;
  transport_reference_return?: string | null;
  created_by_user_id?: string | null;
  phone: string;
  phone_e164?: string | null;
  notes: string;
  tour_name?: string | null;
  capacity?: number | null;
  low_seat_threshold?: number | null;
  minimum_passengers?: number | null;
  waitlist_enabled?: boolean | null;
  waitlist_count?: number | null;
  meeting_point?: string | null;
  stops?: string[] | null;
  bus_plate?: string | null;
  booking_service_kind?: AgencyBookingServiceKind | null;
  service_type_code?: OperationalServiceType | null;
  customer_first_name?: string | null;
  customer_last_name?: string | null;
  customer_email?: string | null;
  arrival_date?: string | null;
  arrival_time?: string | null;
  departure_date?: string | null;
  departure_time?: string | null;
  transport_code?: string | null;
  train_arrival_number?: string | null;
  train_arrival_time?: string | null;
  train_departure_number?: string | null;
  train_departure_time?: string | null;
  bus_city_origin?: string | null;
  include_ferry_tickets?: boolean | null;
  ferry_details?: Record<string, unknown> | null;
  excursion_details?: Record<string, unknown> | null;
  email_confirmation_to?: string | null;
  email_confirmation_status?: "pending" | "sent" | "failed" | "skipped" | null;
  email_confirmation_error?: string | null;
  email_confirmation_sent_at?: string | null;
  share_token?: string | null;
  share_expires_at?: string | null;
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

export interface BusLotConfig {
  id: string;
  tenant_id: string;
  lot_key: string;
  service_date: string;
  direction: ServiceDirection;
  billing_party_name?: string | null;
  bus_city_origin?: string | null;
  transport_code?: string | null;
  title?: string | null;
  meeting_point?: string | null;
  capacity: number;
  low_seat_threshold: number;
  minimum_passengers?: number | null;
  waitlist_enabled: boolean;
  waitlist_count: number;
  notes?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface VehicleRecord {
  id: string;
  tenant_id: string;
  label: string;
  plate?: string | null;
  capacity?: number | null;
  active: boolean;
  vehicle_size?: VehicleSize | null;
  habitual_driver_user_id?: string | null;
  default_zone?: string | null;
  blocked_until?: string | null;
  blocked_reason?: string | null;
  notes?: string | null;
  is_blocked_manual?: boolean | null;
  created_at?: string;
}

export interface VehicleAnomaly {
  id: string;
  tenant_id: string;
  vehicle_id: string;
  driver_user_id?: string | null;
  severity: "low" | "medium" | "high" | "blocking";
  title: string;
  description?: string | null;
  blocked_until?: string | null;
  active: boolean;
  resolved_at?: string | null;
  resolved_by_user_id?: string | null;
  reported_at: string;
}

export interface TenantBusLine {
  id: string;
  tenant_id: string;
  code: string;
  name: string;
  family_code: string;
  family_name: string;
  variant_label?: string | null;
  default_capacity: number;
  alert_threshold: number;
  active: boolean;
  created_at?: string;
  updated_at?: string;
}

export interface TenantBusLineStop {
  id: string;
  tenant_id: string;
  bus_line_id: string;
  direction: ServiceDirection;
  stop_name: string;
  city: string;
  pickup_note?: string | null;
  stop_order: number;
  lat?: number | null;
  lng?: number | null;
  is_manual: boolean;
  active: boolean;
  created_at?: string;
  updated_at?: string;
}

export interface TenantBusUnit {
  id: string;
  tenant_id: string;
  bus_line_id: string;
  label: string;
  capacity: number;
  low_seat_threshold: number;
  minimum_passengers?: number | null;
  status: "open" | "low" | "closed" | "completed";
  manual_close: boolean;
  close_reason?: string | null;
  sort_order: number;
  active: boolean;
  created_at?: string;
  updated_at?: string;
}

export interface TenantBusAllocation {
  id: string;
  tenant_id: string;
  service_id: string;
  bus_line_id: string;
  bus_unit_id: string;
  root_allocation_id?: string | null;
  split_from_allocation_id?: string | null;
  stop_id?: string | null;
  stop_name: string;
  direction: ServiceDirection;
  pax_assigned: number;
  notes?: string | null;
  created_by_user_id?: string | null;
  created_at?: string;
}

export interface TenantBusAllocationMove {
  id: string;
  tenant_id: string;
  service_id: string;
  allocation_id?: string | null;
  target_allocation_id?: string | null;
  root_allocation_id?: string | null;
  from_bus_unit_id?: string | null;
  to_bus_unit_id?: string | null;
  stop_name?: string | null;
  pax_moved: number;
  reason?: string | null;
  created_by_user_id?: string | null;
  created_at?: string;
}

export interface QuoteRecord {
  id: string;
  tenant_id: string;
  created_by_user_id?: string | null;
  owner_label: string;
  status: "draft" | "sent" | "accepted" | "rejected" | "expired";
  service_kind: string;
  route_label: string;
  price_cents: number;
  currency: string;
  passenger_count?: number | null;
  valid_until?: string | null;
  notes?: string | null;
  created_at: string;
}

export interface QuoteWaypoint {
  id: string;
  tenant_id: string;
  quote_id: string;
  label: string;
  sort_order: number;
  created_at?: string;
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
    departure_date?: string;
    departure_time?: string;
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
  busLotConfigs: BusLotConfig[];
  inboundEmails: InboundEmail[];
  memberships: Membership[];
}
