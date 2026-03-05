export interface Database {
  public: {
    Tables: {
      tenants: { Row: { id: string; name: string; created_at: string } };
      memberships: { Row: { user_id: string; tenant_id: string; role: "admin" | "operator" | "driver" | "agency"; full_name: string; created_at: string } };
      hotels: { Row: { id: string; tenant_id: string; name: string; address: string; lat: number; lng: number; zone: string } };
      services: { Row: { id: string; tenant_id: string; inbound_email_id: string | null; is_draft: boolean; date: string; time: string; service_type: "transfer" | "bus_tour"; direction: "arrival" | "departure"; vessel: string; pax: number; hotel_id: string; customer_name: string; created_by_user_id: string | null; phone: string; phone_e164: string | null; notes: string; tour_name: string | null; capacity: number | null; meeting_point: string | null; stops: string[] | null; bus_plate: string | null; reminder_status: "pending" | "sent" | "delivered" | "read" | "failed" | null; message_id: string | null; sent_at: string | null; status: "needs_review" | "new" | "assigned" | "partito" | "arrivato" | "completato" | "problema" | "cancelled" } };
      assignments: { Row: { id: string; tenant_id: string; service_id: string; driver_user_id: string | null; vehicle_label: string; created_at: string } };
      status_events: { Row: { id: string; tenant_id: string; service_id: string; status: string; at: string; by_user_id: string } };
      whatsapp_events: { Row: { id: string; tenant_id: string; service_id: string | null; to_phone: string; kind: string | null; template: string | null; status: "queued" | "sent" | "delivered" | "read" | "failed"; provider_message_id: string | null; happened_at: string; payload_json: Record<string, unknown>; created_at: string } };
      tenant_whatsapp_settings: { Row: { tenant_id: string; default_template: string; template_language: string; enable_2h_reminder: boolean; allow_text_fallback: boolean; updated_at: string } };
      vehicles: { Row: { id: string; tenant_id: string; label: string; plate: string | null; capacity: number | null; active: boolean; created_at: string } };
      tenant_geo_settings: { Row: { tenant_id: string; zones: string[]; ports: string[]; updated_at: string } };
      inbound_emails: { Row: { id: string; tenant_id: string; raw_text: string; from_email: string | null; subject: string | null; body_text: string | null; body_html: string | null; raw_json: Record<string, unknown>; extracted_text: string | null; parsed_json: Record<string, unknown>; created_at: string } };
      inbound_email_attachments: { Row: { id: string; inbound_email_id: string; tenant_id: string; filename: string; mimetype: string; size_bytes: number; stored: boolean; extracted_text: string | null; created_at: string } };
    };
  };
}
