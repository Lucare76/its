export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.1"
  }
  public: {
    Tables: {
      agencies: {
        Row: {
          active: boolean
          billing_name: string | null
          booking_email: string | null
          booking_emails: Json
          code: string | null
          contact_email: string | null
          contact_emails: Json
          created_at: string
          default_enabled_booking_kinds: Json
          default_pricing_notes: string
          email: string | null
          external_code: string | null
          id: string
          invoice_cadence: string
          invoice_email: string | null
          invoice_enabled: boolean
          invoice_send_day: number
          legal_name: string | null
          linked_user_id: string | null
          name: string
          notes: string | null
          parser_key_hint: string | null
          pec_email: string | null
          phone: string | null
          sdi_code: string | null
          sender_domains: Json
          setup_required: boolean
          tenant_id: string
          updated_at: string
          vat_number: string | null
        }
        Insert: {
          active?: boolean
          billing_name?: string | null
          booking_email?: string | null
          booking_emails?: Json
          code?: string | null
          contact_email?: string | null
          contact_emails?: Json
          created_at?: string
          default_enabled_booking_kinds?: Json
          default_pricing_notes?: string
          email?: string | null
          external_code?: string | null
          id?: string
          invoice_cadence?: string
          invoice_email?: string | null
          invoice_enabled?: boolean
          invoice_send_day?: number
          legal_name?: string | null
          linked_user_id?: string | null
          name: string
          notes?: string | null
          parser_key_hint?: string | null
          pec_email?: string | null
          phone?: string | null
          sdi_code?: string | null
          sender_domains?: Json
          setup_required?: boolean
          tenant_id: string
          updated_at?: string
          vat_number?: string | null
        }
        Update: {
          active?: boolean
          billing_name?: string | null
          booking_email?: string | null
          booking_emails?: Json
          code?: string | null
          contact_email?: string | null
          contact_emails?: Json
          created_at?: string
          default_enabled_booking_kinds?: Json
          default_pricing_notes?: string
          email?: string | null
          external_code?: string | null
          id?: string
          invoice_cadence?: string
          invoice_email?: string | null
          invoice_enabled?: boolean
          invoice_send_day?: number
          legal_name?: string | null
          linked_user_id?: string | null
          name?: string
          notes?: string | null
          parser_key_hint?: string | null
          pec_email?: string | null
          phone?: string | null
          sdi_code?: string | null
          sender_domains?: Json
          setup_required?: boolean
          tenant_id?: string
          updated_at?: string
          vat_number?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "agencies_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      agency_aliases: {
        Row: {
          active: boolean
          agency_id: string
          alias: string
          created_at: string
          id: string
          tenant_id: string
          updated_at: string
        }
        Insert: {
          active?: boolean
          agency_id: string
          alias: string
          created_at?: string
          id?: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          active?: boolean
          agency_id?: string
          alias?: string
          created_at?: string
          id?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "agency_aliases_agency_id_fkey"
            columns: ["agency_id"]
            isOneToOne: false
            referencedRelation: "agencies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agency_aliases_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      agency_bookings: {
        Row: {
          agency_name: string | null
          booking_kind: string
          created_at: string
          created_by_user_id: string | null
          customer_name: string | null
          hotel_id: string | null
          hotel_name_raw: string | null
          id: string
          pax: number
          service_scope: string
          source: string
          source_booking_key: string
          source_import_id: string | null
          source_payload: Json
          status: string
          status_reasons: Json
          tenant_id: string
          updated_at: string
        }
        Insert: {
          agency_name?: string | null
          booking_kind?: string
          created_at?: string
          created_by_user_id?: string | null
          customer_name?: string | null
          hotel_id?: string | null
          hotel_name_raw?: string | null
          id?: string
          pax?: number
          service_scope?: string
          source: string
          source_booking_key: string
          source_import_id?: string | null
          source_payload?: Json
          status?: string
          status_reasons?: Json
          tenant_id: string
          updated_at?: string
        }
        Update: {
          agency_name?: string | null
          booking_kind?: string
          created_at?: string
          created_by_user_id?: string | null
          customer_name?: string | null
          hotel_id?: string | null
          hotel_name_raw?: string | null
          id?: string
          pax?: number
          service_scope?: string
          source?: string
          source_booking_key?: string
          source_import_id?: string | null
          source_payload?: Json
          status?: string
          status_reasons?: Json
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "agency_bookings_hotel_id_fkey"
            columns: ["hotel_id"]
            isOneToOne: false
            referencedRelation: "hotels"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agency_bookings_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      agency_invoice_disputes: {
        Row: {
          agency_id: string
          agency_invoice_id: string | null
          agency_note: string | null
          created_at: string
          created_by: string | null
          id: string
          original_price_cents: number
          proposed_price_cents: number
          resolution_note: string | null
          resolved_at: string | null
          resolved_by: string | null
          service_id: string
          status: string
          tenant_id: string
        }
        Insert: {
          agency_id: string
          agency_invoice_id?: string | null
          agency_note?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          original_price_cents: number
          proposed_price_cents: number
          resolution_note?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          service_id: string
          status?: string
          tenant_id: string
        }
        Update: {
          agency_id?: string
          agency_invoice_id?: string | null
          agency_note?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          original_price_cents?: number
          proposed_price_cents?: number
          resolution_note?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          service_id?: string
          status?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "agency_invoice_disputes_agency_id_fkey"
            columns: ["agency_id"]
            isOneToOne: false
            referencedRelation: "agencies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agency_invoice_disputes_agency_invoice_id_fkey"
            columns: ["agency_invoice_id"]
            isOneToOne: false
            referencedRelation: "agency_invoices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agency_invoice_disputes_service_id_fkey"
            columns: ["service_id"]
            isOneToOne: false
            referencedRelation: "services"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agency_invoice_disputes_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      agency_invoices: {
        Row: {
          agency_id: string | null
          agency_name: string
          agency_review_status: string
          agency_reviewed_at: string | null
          created_at: string
          id: string
          invoice_data: Json
          paid_at: string | null
          paid_by_user_id: string | null
          payment_note: string | null
          period_from: string
          period_to: string
          sent_at: string | null
          services_count: number
          status: string
          tenant_id: string
          total_cents: number
        }
        Insert: {
          agency_id?: string | null
          agency_name: string
          agency_review_status?: string
          agency_reviewed_at?: string | null
          created_at?: string
          id?: string
          invoice_data?: Json
          paid_at?: string | null
          paid_by_user_id?: string | null
          payment_note?: string | null
          period_from: string
          period_to: string
          sent_at?: string | null
          services_count?: number
          status?: string
          tenant_id: string
          total_cents?: number
        }
        Update: {
          agency_id?: string | null
          agency_name?: string
          agency_review_status?: string
          agency_reviewed_at?: string | null
          created_at?: string
          id?: string
          invoice_data?: Json
          paid_at?: string | null
          paid_by_user_id?: string | null
          payment_note?: string | null
          period_from?: string
          period_to?: string
          sent_at?: string | null
          services_count?: number
          status?: string
          tenant_id?: string
          total_cents?: number
        }
        Relationships: [
          {
            foreignKeyName: "agency_invoices_agency_id_fkey"
            columns: ["agency_id"]
            isOneToOne: false
            referencedRelation: "agencies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agency_invoices_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      agency_profile_changes: {
        Row: {
          acknowledged_at: string | null
          agency_id: string
          changes: Json
          created_at: string
          id: string
          proposed_by_user_id: string
          rejection_note: string | null
          status: string
          tenant_id: string
          updated_at: string
        }
        Insert: {
          acknowledged_at?: string | null
          agency_id: string
          changes: Json
          created_at?: string
          id?: string
          proposed_by_user_id: string
          rejection_note?: string | null
          status?: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          acknowledged_at?: string | null
          agency_id?: string
          changes?: Json
          created_at?: string
          id?: string
          proposed_by_user_id?: string
          rejection_note?: string | null
          status?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: []
      }
      agency_rate_kinds: {
        Row: {
          active: boolean
          created_at: string
          id: string
          kind_key: string
          label: string
          tenant_id: string
        }
        Insert: {
          active?: boolean
          created_at?: string
          id?: string
          kind_key: string
          label: string
          tenant_id: string
        }
        Update: {
          active?: boolean
          created_at?: string
          id?: string
          kind_key?: string
          label?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "agency_rate_kinds_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      agency_rates: {
        Row: {
          active: boolean
          agency_id: string | null
          booking_service_kind: string
          cost_cents: number | null
          created_at: string
          hotel_id: string | null
          id: string
          line_code: string | null
          notes: string
          price_cents: number
          tenant_id: string
          updated_at: string
          valid_from: string
          valid_to: string | null
        }
        Insert: {
          active?: boolean
          agency_id?: string | null
          booking_service_kind: string
          cost_cents?: number | null
          created_at?: string
          hotel_id?: string | null
          id?: string
          line_code?: string | null
          notes?: string
          price_cents: number
          tenant_id: string
          updated_at?: string
          valid_from?: string
          valid_to?: string | null
        }
        Update: {
          active?: boolean
          agency_id?: string | null
          booking_service_kind?: string
          cost_cents?: number | null
          created_at?: string
          hotel_id?: string | null
          id?: string
          line_code?: string | null
          notes?: string
          price_cents?: number
          tenant_id?: string
          updated_at?: string
          valid_from?: string
          valid_to?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "agency_rates_agency_id_fkey"
            columns: ["agency_id"]
            isOneToOne: false
            referencedRelation: "agencies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agency_rates_hotel_id_fkey"
            columns: ["hotel_id"]
            isOneToOne: false
            referencedRelation: "hotels"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agency_rates_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      agency_review_sessions: {
        Row: {
          agency_name: string
          agency_notes: string | null
          created_at: string
          expires_at: string
          id: string
          modifications: Json | null
          report_type: string
          reviewed_at: string | null
          services: Json
          status: string
          target_date: string
          tenant_id: string
          token: string
        }
        Insert: {
          agency_name: string
          agency_notes?: string | null
          created_at?: string
          expires_at?: string
          id?: string
          modifications?: Json | null
          report_type: string
          reviewed_at?: string | null
          services?: Json
          status?: string
          target_date: string
          tenant_id: string
          token?: string
        }
        Update: {
          agency_name?: string
          agency_notes?: string | null
          created_at?: string
          expires_at?: string
          id?: string
          modifications?: Json | null
          report_type?: string
          reviewed_at?: string | null
          services?: Json
          status?: string
          target_date?: string
          tenant_id?: string
          token?: string
        }
        Relationships: [
          {
            foreignKeyName: "agency_review_sessions_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_usage_log: {
        Row: {
          cost_usd: number
          created_at: string
          error_message: string | null
          failed: boolean
          id: string
          import_id: string | null
          input_tokens: number
          model: string
          output_tokens: number
          provider: string
          source: string
          tenant_id: string
        }
        Insert: {
          cost_usd?: number
          created_at?: string
          error_message?: string | null
          failed?: boolean
          id?: string
          import_id?: string | null
          input_tokens?: number
          model: string
          output_tokens?: number
          provider?: string
          source: string
          tenant_id: string
        }
        Update: {
          cost_usd?: number
          created_at?: string
          error_message?: string | null
          failed?: boolean
          id?: string
          import_id?: string | null
          input_tokens?: number
          model?: string
          output_tokens?: number
          provider?: string
          source?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_usage_log_import_id_fkey"
            columns: ["import_id"]
            isOneToOne: false
            referencedRelation: "inbound_emails"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_usage_log_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      assignment_learned_patterns: {
        Row: {
          correction_count: number
          driver_profile_id: string
          id: string
          last_updated_at: string
          pattern_key: string
          tenant_id: string
          total_count: number
        }
        Insert: {
          correction_count?: number
          driver_profile_id: string
          id?: string
          last_updated_at?: string
          pattern_key: string
          tenant_id: string
          total_count?: number
        }
        Update: {
          correction_count?: number
          driver_profile_id?: string
          id?: string
          last_updated_at?: string
          pattern_key?: string
          tenant_id?: string
          total_count?: number
        }
        Relationships: []
      }
      assignment_plan_items: {
        Row: {
          alternatives: Json | null
          confidence: number | null
          confirmed_at: string | null
          confirmed_by: string | null
          created_at: string
          id: string
          locked: boolean
          mission_group_key: string | null
          plan_id: string
          proposed_driver_id: string | null
          proposed_driver_name: string | null
          proposed_vehicle_id: string | null
          proposed_vehicle_label: string | null
          reason: Json | null
          score: number | null
          service_id: string
          status: string
          suggested_fix: Json | null
          tenant_id: string
          updated_at: string
          warnings: Json | null
        }
        Insert: {
          alternatives?: Json | null
          confidence?: number | null
          confirmed_at?: string | null
          confirmed_by?: string | null
          created_at?: string
          id?: string
          locked?: boolean
          mission_group_key?: string | null
          plan_id: string
          proposed_driver_id?: string | null
          proposed_driver_name?: string | null
          proposed_vehicle_id?: string | null
          proposed_vehicle_label?: string | null
          reason?: Json | null
          score?: number | null
          service_id: string
          status: string
          suggested_fix?: Json | null
          tenant_id: string
          updated_at?: string
          warnings?: Json | null
        }
        Update: {
          alternatives?: Json | null
          confidence?: number | null
          confirmed_at?: string | null
          confirmed_by?: string | null
          created_at?: string
          id?: string
          locked?: boolean
          mission_group_key?: string | null
          plan_id?: string
          proposed_driver_id?: string | null
          proposed_driver_name?: string | null
          proposed_vehicle_id?: string | null
          proposed_vehicle_label?: string | null
          reason?: Json | null
          score?: number | null
          service_id?: string
          status?: string
          suggested_fix?: Json | null
          tenant_id?: string
          updated_at?: string
          warnings?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "assignment_plan_items_plan_id_fkey"
            columns: ["plan_id"]
            isOneToOne: false
            referencedRelation: "assignment_plans"
            referencedColumns: ["id"]
          },
        ]
      }
      assignment_plans: {
        Row: {
          auto_safe_count: number
          created_at: string
          drivers_count: number
          duration_ms: number | null
          generated_at: string
          generated_by: string | null
          id: string
          locked_count: number
          manual_count: number
          plan_date: string
          review_count: number
          services_count: number
          status: string
          summary: Json | null
          tenant_id: string
          unresolved_count: number
          updated_at: string
          vehicles_count: number
        }
        Insert: {
          auto_safe_count?: number
          created_at?: string
          drivers_count?: number
          duration_ms?: number | null
          generated_at?: string
          generated_by?: string | null
          id?: string
          locked_count?: number
          manual_count?: number
          plan_date: string
          review_count?: number
          services_count?: number
          status?: string
          summary?: Json | null
          tenant_id: string
          unresolved_count?: number
          updated_at?: string
          vehicles_count?: number
        }
        Update: {
          auto_safe_count?: number
          created_at?: string
          drivers_count?: number
          duration_ms?: number | null
          generated_at?: string
          generated_by?: string | null
          id?: string
          locked_count?: number
          manual_count?: number
          plan_date?: string
          review_count?: number
          services_count?: number
          status?: string
          summary?: Json | null
          tenant_id?: string
          unresolved_count?: number
          updated_at?: string
          vehicles_count?: number
        }
        Relationships: []
      }
      assignments: {
        Row: {
          assigned_at: string | null
          assigned_by: string | null
          assignment_source: string | null
          created_at: string
          driver_profile_id: string | null
          driver_user_id: string | null
          group_id: string | null
          id: string
          lock_reason: string | null
          locked_by_operator: boolean | null
          service_id: string
          tenant_id: string
          vehicle_label: string
        }
        Insert: {
          assigned_at?: string | null
          assigned_by?: string | null
          assignment_source?: string | null
          created_at?: string
          driver_profile_id?: string | null
          driver_user_id?: string | null
          group_id?: string | null
          id?: string
          lock_reason?: string | null
          locked_by_operator?: boolean | null
          service_id: string
          tenant_id: string
          vehicle_label: string
        }
        Update: {
          assigned_at?: string | null
          assigned_by?: string | null
          assignment_source?: string | null
          created_at?: string
          driver_profile_id?: string | null
          driver_user_id?: string | null
          group_id?: string | null
          id?: string
          lock_reason?: string | null
          locked_by_operator?: boolean | null
          service_id?: string
          tenant_id?: string
          vehicle_label?: string
        }
        Relationships: [
          {
            foreignKeyName: "assignments_driver_profile_id_fkey"
            columns: ["driver_profile_id"]
            isOneToOne: false
            referencedRelation: "driver_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assignments_group_id_fkey"
            columns: ["group_id"]
            isOneToOne: false
            referencedRelation: "trip_groups"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assignments_service_id_fkey"
            columns: ["service_id"]
            isOneToOne: true
            referencedRelation: "services"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assignments_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      auth_audit_log: {
        Row: {
          created_at: string | null
          details: Json | null
          event_type: string
          id: string
          ip_address: unknown
          status: string
          tenant_id: string | null
          user_agent: string | null
          user_id: string | null
        }
        Insert: {
          created_at?: string | null
          details?: Json | null
          event_type: string
          id?: string
          ip_address?: unknown
          status: string
          tenant_id?: string | null
          user_agent?: string | null
          user_id?: string | null
        }
        Update: {
          created_at?: string | null
          details?: Json | null
          event_type?: string
          id?: string
          ip_address?: unknown
          status?: string
          tenant_id?: string | null
          user_agent?: string | null
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "auth_audit_log_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      booking_approval_tokens: {
        Row: {
          action: string | null
          agency_response: string | null
          agency_response_at: string | null
          agency_response_notes: string | null
          agency_token: string | null
          created_at: string
          expires_at: string
          id: string
          resolved_by_email: string | null
          resolved_notes: string | null
          resolved_price_cents: number | null
          service_id: string
          tenant_id: string
          token: string
          used_at: string | null
        }
        Insert: {
          action?: string | null
          agency_response?: string | null
          agency_response_at?: string | null
          agency_response_notes?: string | null
          agency_token?: string | null
          created_at?: string
          expires_at?: string
          id?: string
          resolved_by_email?: string | null
          resolved_notes?: string | null
          resolved_price_cents?: number | null
          service_id: string
          tenant_id: string
          token?: string
          used_at?: string | null
        }
        Update: {
          action?: string | null
          agency_response?: string | null
          agency_response_at?: string | null
          agency_response_notes?: string | null
          agency_token?: string | null
          created_at?: string
          expires_at?: string
          id?: string
          resolved_by_email?: string | null
          resolved_notes?: string | null
          resolved_price_cents?: number | null
          service_id?: string
          tenant_id?: string
          token?: string
          used_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "booking_approval_tokens_service_id_fkey"
            columns: ["service_id"]
            isOneToOne: false
            referencedRelation: "services"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "booking_approval_tokens_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      booking_group_bus_reservations: {
        Row: {
          booking_group_id: string
          bus_unit_id: string
          created_at: string
          exclusive: boolean
          id: string
          notes: string | null
          reserved_pax: number
          service_date: string
          tenant_id: string
          updated_at: string
        }
        Insert: {
          booking_group_id: string
          bus_unit_id: string
          created_at?: string
          exclusive?: boolean
          id?: string
          notes?: string | null
          reserved_pax: number
          service_date: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          booking_group_id?: string
          bus_unit_id?: string
          created_at?: string
          exclusive?: boolean
          id?: string
          notes?: string | null
          reserved_pax?: number
          service_date?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "booking_group_bus_reservations_booking_group_id_fkey"
            columns: ["booking_group_id"]
            isOneToOne: false
            referencedRelation: "booking_groups"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "booking_group_bus_reservations_bus_unit_id_fkey"
            columns: ["bus_unit_id"]
            isOneToOne: false
            referencedRelation: "tenant_bus_units"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "booking_group_bus_reservations_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      booking_group_stops: {
        Row: {
          booking_group_id: string
          city: string
          contact_name: string | null
          contact_phone: string | null
          created_at: string
          direction: string
          expected_pax: number
          id: string
          notes: string | null
          pickup_point: string | null
          sort_order: number
          stop_id: string | null
          tenant_id: string
          updated_at: string
        }
        Insert: {
          booking_group_id: string
          city: string
          contact_name?: string | null
          contact_phone?: string | null
          created_at?: string
          direction: string
          expected_pax: number
          id?: string
          notes?: string | null
          pickup_point?: string | null
          sort_order?: number
          stop_id?: string | null
          tenant_id: string
          updated_at?: string
        }
        Update: {
          booking_group_id?: string
          city?: string
          contact_name?: string | null
          contact_phone?: string | null
          created_at?: string
          direction?: string
          expected_pax?: number
          id?: string
          notes?: string | null
          pickup_point?: string | null
          sort_order?: number
          stop_id?: string | null
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "booking_group_stops_booking_group_id_fkey"
            columns: ["booking_group_id"]
            isOneToOne: false
            referencedRelation: "booking_groups"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "booking_group_stops_stop_id_fkey"
            columns: ["stop_id"]
            isOneToOne: false
            referencedRelation: "tenant_bus_line_stops"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "booking_group_stops_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      booking_groups: {
        Row: {
          agency_id: string | null
          contact_name: string | null
          contact_phone: string | null
          created_at: string
          created_by_user_id: string | null
          expected_pax: number
          hotel_id: string | null
          id: string
          kind: string
          name: string
          notes: string | null
          outbound_arrival_port: string | null
          outbound_departure_port: string | null
          outbound_expected_arrival_time: string | null
          outbound_ferry_company: string | null
          outbound_ferry_time: string | null
          return_arrival_port: string | null
          return_date: string | null
          return_departure_port: string | null
          return_expected_arrival_time: string | null
          return_ferry_company: string | null
          return_ferry_time: string | null
          service_date: string | null
          status: string
          tenant_id: string
          updated_at: string
        }
        Insert: {
          agency_id?: string | null
          contact_name?: string | null
          contact_phone?: string | null
          created_at?: string
          created_by_user_id?: string | null
          expected_pax: number
          hotel_id?: string | null
          id?: string
          kind?: string
          name: string
          notes?: string | null
          outbound_arrival_port?: string | null
          outbound_departure_port?: string | null
          outbound_expected_arrival_time?: string | null
          outbound_ferry_company?: string | null
          outbound_ferry_time?: string | null
          return_arrival_port?: string | null
          return_date?: string | null
          return_departure_port?: string | null
          return_expected_arrival_time?: string | null
          return_ferry_company?: string | null
          return_ferry_time?: string | null
          service_date?: string | null
          status?: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          agency_id?: string | null
          contact_name?: string | null
          contact_phone?: string | null
          created_at?: string
          created_by_user_id?: string | null
          expected_pax?: number
          hotel_id?: string | null
          id?: string
          kind?: string
          name?: string
          notes?: string | null
          outbound_arrival_port?: string | null
          outbound_departure_port?: string | null
          outbound_expected_arrival_time?: string | null
          outbound_ferry_company?: string | null
          outbound_ferry_time?: string | null
          return_arrival_port?: string | null
          return_date?: string | null
          return_departure_port?: string | null
          return_expected_arrival_time?: string | null
          return_ferry_company?: string | null
          return_ferry_time?: string | null
          service_date?: string | null
          status?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "booking_groups_agency_id_fkey"
            columns: ["agency_id"]
            isOneToOne: false
            referencedRelation: "agencies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "booking_groups_hotel_id_fkey"
            columns: ["hotel_id"]
            isOneToOne: false
            referencedRelation: "hotels"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "booking_groups_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      booking_practice_counters: {
        Row: {
          last_value: number
          tenant_id: string
          updated_at: string
          year: number
        }
        Insert: {
          last_value?: number
          tenant_id: string
          updated_at?: string
          year: number
        }
        Update: {
          last_value?: number
          tenant_id?: string
          updated_at?: string
          year?: number
        }
        Relationships: [
          {
            foreignKeyName: "booking_practice_counters_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      booking_qr_codes: {
        Row: {
          booking_id: string
          created_at: string
          direction: Database["public"]["Enums"]["booking_qr_direction"]
          id: string
          qr_file_path: string | null
          qr_image_url: string
          qr_payload: string
          qr_token: string
          service_date: string
          status: Database["public"]["Enums"]["booking_qr_status"]
          tenant_id: string
          updated_at: string
          used_at: string | null
          used_by: string | null
        }
        Insert: {
          booking_id: string
          created_at?: string
          direction: Database["public"]["Enums"]["booking_qr_direction"]
          id?: string
          qr_file_path?: string | null
          qr_image_url: string
          qr_payload: string
          qr_token: string
          service_date: string
          status?: Database["public"]["Enums"]["booking_qr_status"]
          tenant_id: string
          updated_at?: string
          used_at?: string | null
          used_by?: string | null
        }
        Update: {
          booking_id?: string
          created_at?: string
          direction?: Database["public"]["Enums"]["booking_qr_direction"]
          id?: string
          qr_file_path?: string | null
          qr_image_url?: string
          qr_payload?: string
          qr_token?: string
          service_date?: string
          status?: Database["public"]["Enums"]["booking_qr_status"]
          tenant_id?: string
          updated_at?: string
          used_at?: string | null
          used_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "booking_qr_codes_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: false
            referencedRelation: "services"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "booking_qr_codes_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      bus_assignment_feedback: {
        Row: {
          action_type: string
          created_at: string
          created_by_user_id: string | null
          customer_name: string | null
          derived_family_code: string | null
          final_family_code: string | null
          hotel_name: string | null
          id: string
          metadata: Json | null
          new_bus_line_id: string | null
          new_bus_unit_id: string | null
          new_date: string | null
          new_direction: string | null
          new_stop_id: string | null
          old_bus_line_id: string | null
          old_bus_unit_id: string | null
          old_date: string | null
          old_direction: string | null
          old_stop_id: string | null
          pax: number | null
          reason: string | null
          service_id: string
          source: string
          tenant_id: string
        }
        Insert: {
          action_type: string
          created_at?: string
          created_by_user_id?: string | null
          customer_name?: string | null
          derived_family_code?: string | null
          final_family_code?: string | null
          hotel_name?: string | null
          id?: string
          metadata?: Json | null
          new_bus_line_id?: string | null
          new_bus_unit_id?: string | null
          new_date?: string | null
          new_direction?: string | null
          new_stop_id?: string | null
          old_bus_line_id?: string | null
          old_bus_unit_id?: string | null
          old_date?: string | null
          old_direction?: string | null
          old_stop_id?: string | null
          pax?: number | null
          reason?: string | null
          service_id: string
          source: string
          tenant_id: string
        }
        Update: {
          action_type?: string
          created_at?: string
          created_by_user_id?: string | null
          customer_name?: string | null
          derived_family_code?: string | null
          final_family_code?: string | null
          hotel_name?: string | null
          id?: string
          metadata?: Json | null
          new_bus_line_id?: string | null
          new_bus_unit_id?: string | null
          new_date?: string | null
          new_direction?: string | null
          new_stop_id?: string | null
          old_bus_line_id?: string | null
          old_bus_unit_id?: string | null
          old_date?: string | null
          old_direction?: string | null
          old_stop_id?: string | null
          pax?: number | null
          reason?: string | null
          service_id?: string
          source?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "bus_assignment_feedback_new_bus_line_id_fkey"
            columns: ["new_bus_line_id"]
            isOneToOne: false
            referencedRelation: "tenant_bus_lines"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bus_assignment_feedback_new_bus_unit_id_fkey"
            columns: ["new_bus_unit_id"]
            isOneToOne: false
            referencedRelation: "tenant_bus_units"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bus_assignment_feedback_new_stop_id_fkey"
            columns: ["new_stop_id"]
            isOneToOne: false
            referencedRelation: "tenant_bus_line_stops"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bus_assignment_feedback_old_bus_line_id_fkey"
            columns: ["old_bus_line_id"]
            isOneToOne: false
            referencedRelation: "tenant_bus_lines"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bus_assignment_feedback_old_bus_unit_id_fkey"
            columns: ["old_bus_unit_id"]
            isOneToOne: false
            referencedRelation: "tenant_bus_units"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bus_assignment_feedback_old_stop_id_fkey"
            columns: ["old_stop_id"]
            isOneToOne: false
            referencedRelation: "tenant_bus_line_stops"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bus_assignment_feedback_service_id_fkey"
            columns: ["service_id"]
            isOneToOne: false
            referencedRelation: "services"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bus_assignment_feedback_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      bus_convocation_batches: {
        Row: {
          created_at: string
          created_by: string
          error_count: number
          file_name: string
          id: string
          label: string
          sent_count: number
          skipped_count: number
          status: string
          tenant_id: string
          total_rows: number
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by: string
          error_count?: number
          file_name?: string
          id?: string
          label?: string
          sent_count?: number
          skipped_count?: number
          status?: string
          tenant_id: string
          total_rows?: number
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string
          error_count?: number
          file_name?: string
          id?: string
          label?: string
          sent_count?: number
          skipped_count?: number
          status?: string
          tenant_id?: string
          total_rows?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "bus_convocation_batches_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      bus_convocation_rows: {
        Row: {
          batch_id: string
          created_at: string
          customer_name: string
          date_line: string
          departure_point: string
          driver_emergency_phone: string
          driver_name: string
          error_message: string | null
          generated_message: string
          id: string
          inviare: boolean
          notes: string
          phone_e164: string | null
          phone_raw: string
          provider_message_id: string | null
          row_index: number
          sent_at: string | null
          service_time: string | null
          status: string
          tenant_id: string
          updated_at: string
        }
        Insert: {
          batch_id: string
          created_at?: string
          customer_name?: string
          date_line?: string
          departure_point?: string
          driver_emergency_phone?: string
          driver_name?: string
          error_message?: string | null
          generated_message?: string
          id?: string
          inviare?: boolean
          notes?: string
          phone_e164?: string | null
          phone_raw?: string
          provider_message_id?: string | null
          row_index: number
          sent_at?: string | null
          service_time?: string | null
          status?: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          batch_id?: string
          created_at?: string
          customer_name?: string
          date_line?: string
          departure_point?: string
          driver_emergency_phone?: string
          driver_name?: string
          error_message?: string | null
          generated_message?: string
          id?: string
          inviare?: boolean
          notes?: string
          phone_e164?: string | null
          phone_raw?: string
          provider_message_id?: string | null
          row_index?: number
          sent_at?: string | null
          service_time?: string | null
          status?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "bus_convocation_rows_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "bus_convocation_batches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bus_convocation_rows_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      bus_convocation_send_logs: {
        Row: {
          api_response_json: Json | null
          attempt_number: number
          attempted_at: string
          batch_id: string
          error_message: string | null
          id: string
          language_code: string
          operator_user_id: string
          phone_e164: string
          provider_message_id: string | null
          row_id: string
          status: string
          template_name: string
          tenant_id: string
          variables_json: Json
        }
        Insert: {
          api_response_json?: Json | null
          attempt_number?: number
          attempted_at?: string
          batch_id: string
          error_message?: string | null
          id?: string
          language_code?: string
          operator_user_id: string
          phone_e164: string
          provider_message_id?: string | null
          row_id: string
          status: string
          template_name: string
          tenant_id: string
          variables_json?: Json
        }
        Update: {
          api_response_json?: Json | null
          attempt_number?: number
          attempted_at?: string
          batch_id?: string
          error_message?: string | null
          id?: string
          language_code?: string
          operator_user_id?: string
          phone_e164?: string
          provider_message_id?: string | null
          row_id?: string
          status?: string
          template_name?: string
          tenant_id?: string
          variables_json?: Json
        }
        Relationships: [
          {
            foreignKeyName: "bus_convocation_send_logs_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "bus_convocation_batches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bus_convocation_send_logs_row_id_fkey"
            columns: ["row_id"]
            isOneToOne: false
            referencedRelation: "bus_convocation_rows"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bus_convocation_send_logs_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      bus_import_pending: {
        Row: {
          bus_line_id: string
          city_original: string
          created_at: string
          direction: string
          geo_lat: number | null
          geo_lng: number | null
          geo_suggested_stop: string | null
          id: string
          notes: string | null
          passenger_email: string | null
          passenger_name: string
          passenger_phone: string | null
          pax: number
          status: string
          tenant_id: string
          travel_date: string
        }
        Insert: {
          bus_line_id: string
          city_original: string
          created_at?: string
          direction: string
          geo_lat?: number | null
          geo_lng?: number | null
          geo_suggested_stop?: string | null
          id?: string
          notes?: string | null
          passenger_email?: string | null
          passenger_name: string
          passenger_phone?: string | null
          pax?: number
          status?: string
          tenant_id: string
          travel_date: string
        }
        Update: {
          bus_line_id?: string
          city_original?: string
          created_at?: string
          direction?: string
          geo_lat?: number | null
          geo_lng?: number | null
          geo_suggested_stop?: string | null
          id?: string
          notes?: string | null
          passenger_email?: string | null
          passenger_name?: string
          passenger_phone?: string | null
          pax?: number
          status?: string
          tenant_id?: string
          travel_date?: string
        }
        Relationships: [
          {
            foreignKeyName: "bus_import_pending_bus_line_id_fkey"
            columns: ["bus_line_id"]
            isOneToOne: false
            referencedRelation: "tenant_bus_lines"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bus_import_pending_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      bus_ischia_dist_allocations: {
        Row: {
          created_at: string
          customer_name: string
          dist_bus_id: string
          hotel_name: string
          hotel_zone: string
          id: string
          pax_assigned: number
          service_id: string
          stop_order: number
          tenant_id: string
        }
        Insert: {
          created_at?: string
          customer_name: string
          dist_bus_id: string
          hotel_name: string
          hotel_zone: string
          id?: string
          pax_assigned?: number
          service_id: string
          stop_order?: number
          tenant_id: string
        }
        Update: {
          created_at?: string
          customer_name?: string
          dist_bus_id?: string
          hotel_name?: string
          hotel_zone?: string
          id?: string
          pax_assigned?: number
          service_id?: string
          stop_order?: number
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "bus_ischia_dist_allocations_dist_bus_id_fkey"
            columns: ["dist_bus_id"]
            isOneToOne: false
            referencedRelation: "bus_ischia_dist_buses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bus_ischia_dist_allocations_service_id_fkey"
            columns: ["service_id"]
            isOneToOne: false
            referencedRelation: "services"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bus_ischia_dist_allocations_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      bus_ischia_dist_buses: {
        Row: {
          bus_line_id: string | null
          capacity: number
          created_at: string
          date: string
          driver_name: string | null
          driver_phone: string | null
          driver_profile_id: string | null
          id: string
          label: string
          section: string
          sort_order: number
          tenant_id: string
          vehicle_id: string | null
          zone: string
        }
        Insert: {
          bus_line_id?: string | null
          capacity?: number
          created_at?: string
          date: string
          driver_name?: string | null
          driver_phone?: string | null
          driver_profile_id?: string | null
          id?: string
          label: string
          section?: string
          sort_order?: number
          tenant_id: string
          vehicle_id?: string | null
          zone: string
        }
        Update: {
          bus_line_id?: string | null
          capacity?: number
          created_at?: string
          date?: string
          driver_name?: string | null
          driver_phone?: string | null
          driver_profile_id?: string | null
          id?: string
          label?: string
          section?: string
          sort_order?: number
          tenant_id?: string
          vehicle_id?: string | null
          zone?: string
        }
        Relationships: [
          {
            foreignKeyName: "bus_ischia_dist_buses_bus_line_id_fkey"
            columns: ["bus_line_id"]
            isOneToOne: false
            referencedRelation: "tenant_bus_lines"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bus_ischia_dist_buses_driver_profile_id_fkey"
            columns: ["driver_profile_id"]
            isOneToOne: false
            referencedRelation: "driver_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bus_ischia_dist_buses_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bus_ischia_dist_buses_vehicle_id_fkey"
            columns: ["vehicle_id"]
            isOneToOne: false
            referencedRelation: "vehicles"
            referencedColumns: ["id"]
          },
        ]
      }
      bus_line_ferry_config: {
        Row: {
          arrival_port: string
          bus_line_family_code: string
          departure_port: string
          departure_time: string
          id: string
          line_color: string
          line_label: string
          sort_order: number
          tenant_id: string
        }
        Insert: {
          arrival_port: string
          bus_line_family_code: string
          departure_port: string
          departure_time: string
          id?: string
          line_color: string
          line_label: string
          sort_order?: number
          tenant_id: string
        }
        Update: {
          arrival_port?: string
          bus_line_family_code?: string
          departure_port?: string
          departure_time?: string
          id?: string
          line_color?: string
          line_label?: string
          sort_order?: number
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "bus_line_ferry_config_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      bus_lot_configs: {
        Row: {
          billing_party_name: string | null
          bus_city_origin: string | null
          capacity: number
          created_at: string
          direction: string
          id: string
          lot_key: string
          low_seat_threshold: number
          meeting_point: string | null
          minimum_passengers: number | null
          notes: string | null
          service_date: string
          tenant_id: string
          title: string | null
          transport_code: string | null
          updated_at: string
          waitlist_count: number
          waitlist_enabled: boolean
        }
        Insert: {
          billing_party_name?: string | null
          bus_city_origin?: string | null
          capacity: number
          created_at?: string
          direction: string
          id?: string
          lot_key: string
          low_seat_threshold?: number
          meeting_point?: string | null
          minimum_passengers?: number | null
          notes?: string | null
          service_date: string
          tenant_id: string
          title?: string | null
          transport_code?: string | null
          updated_at?: string
          waitlist_count?: number
          waitlist_enabled?: boolean
        }
        Update: {
          billing_party_name?: string | null
          bus_city_origin?: string | null
          capacity?: number
          created_at?: string
          direction?: string
          id?: string
          lot_key?: string
          low_seat_threshold?: number
          meeting_point?: string | null
          minimum_passengers?: number | null
          notes?: string | null
          service_date?: string
          tenant_id?: string
          title?: string | null
          transport_code?: string | null
          updated_at?: string
          waitlist_count?: number
          waitlist_enabled?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "bus_lot_configs_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      bus_unit_driver_dates: {
        Row: {
          driver_name_outbound: string | null
          driver_name_return: string | null
          driver_phone_outbound: string | null
          driver_phone_return: string | null
          id: string
          tenant_id: string
          travel_date: string
          unit_id: string
          updated_at: string
        }
        Insert: {
          driver_name_outbound?: string | null
          driver_name_return?: string | null
          driver_phone_outbound?: string | null
          driver_phone_return?: string | null
          id?: string
          tenant_id: string
          travel_date: string
          unit_id: string
          updated_at?: string
        }
        Update: {
          driver_name_outbound?: string | null
          driver_name_return?: string | null
          driver_phone_outbound?: string | null
          driver_phone_return?: string | null
          id?: string
          tenant_id?: string
          travel_date?: string
          unit_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "bus_unit_driver_dates_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bus_unit_driver_dates_unit_id_fkey"
            columns: ["unit_id"]
            isOneToOne: false
            referencedRelation: "tenant_bus_units"
            referencedColumns: ["id"]
          },
        ]
      }
      cancellation_requests: {
        Row: {
          agency_counter_cents: number | null
          agency_responded_at: string | null
          agency_response: string | null
          agency_response_note: string | null
          approval_token: string
          cancel_legs: string
          created_at: string
          id: string
          penalty_cents: number | null
          penalty_note: string | null
          requested_by_role: string
          requested_by_user_id: string | null
          resolved_at: string | null
          resolved_by_user_id: string | null
          service_id: string
          status: string
          tenant_id: string
          updated_at: string
        }
        Insert: {
          agency_counter_cents?: number | null
          agency_responded_at?: string | null
          agency_response?: string | null
          agency_response_note?: string | null
          approval_token?: string
          cancel_legs?: string
          created_at?: string
          id?: string
          penalty_cents?: number | null
          penalty_note?: string | null
          requested_by_role: string
          requested_by_user_id?: string | null
          resolved_at?: string | null
          resolved_by_user_id?: string | null
          service_id: string
          status?: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          agency_counter_cents?: number | null
          agency_responded_at?: string | null
          agency_response?: string | null
          agency_response_note?: string | null
          approval_token?: string
          cancel_legs?: string
          created_at?: string
          id?: string
          penalty_cents?: number | null
          penalty_note?: string | null
          requested_by_role?: string
          requested_by_user_id?: string | null
          resolved_at?: string | null
          resolved_by_user_id?: string | null
          service_id?: string
          status?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "cancellation_requests_service_id_fkey"
            columns: ["service_id"]
            isOneToOne: false
            referencedRelation: "services"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cancellation_requests_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      daily_availability_confirmations: {
        Row: {
          confirmed: boolean
          confirmed_at: string | null
          confirmed_by: string | null
          created_at: string
          date: string
          id: string
          tenant_id: string
        }
        Insert: {
          confirmed?: boolean
          confirmed_at?: string | null
          confirmed_by?: string | null
          created_at?: string
          date: string
          id?: string
          tenant_id: string
        }
        Update: {
          confirmed?: boolean
          confirmed_at?: string | null
          confirmed_by?: string | null
          created_at?: string
          date?: string
          id?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "daily_availability_confirmations_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      direct_invites: {
        Row: {
          accepted_at: string | null
          agency_id: string | null
          created_at: string | null
          email: string
          expires_at: string
          full_name: string
          id: string
          invite_token: string
          invited_by_user_id: string
          rejected_at: string | null
          role: string
          tenant_id: string
        }
        Insert: {
          accepted_at?: string | null
          agency_id?: string | null
          created_at?: string | null
          email: string
          expires_at: string
          full_name: string
          id?: string
          invite_token: string
          invited_by_user_id: string
          rejected_at?: string | null
          role: string
          tenant_id: string
        }
        Update: {
          accepted_at?: string | null
          agency_id?: string | null
          created_at?: string | null
          email?: string
          expires_at?: string
          full_name?: string
          id?: string
          invite_token?: string
          invited_by_user_id?: string
          rejected_at?: string | null
          role?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "direct_invites_agency_id_fkey"
            columns: ["agency_id"]
            isOneToOne: false
            referencedRelation: "agencies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "direct_invites_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      driver_assignment_history: {
        Row: {
          change_type: string
          created_at: string
          features: Json | null
          from_driver_profile_id: string | null
          from_vehicle_label: string | null
          group_id: string | null
          id: string
          operator_id: string
          service_date: string
          service_id: string | null
          tenant_id: string
          to_driver_profile_id: string | null
          to_vehicle_label: string | null
        }
        Insert: {
          change_type: string
          created_at?: string
          features?: Json | null
          from_driver_profile_id?: string | null
          from_vehicle_label?: string | null
          group_id?: string | null
          id?: string
          operator_id: string
          service_date: string
          service_id?: string | null
          tenant_id: string
          to_driver_profile_id?: string | null
          to_vehicle_label?: string | null
        }
        Update: {
          change_type?: string
          created_at?: string
          features?: Json | null
          from_driver_profile_id?: string | null
          from_vehicle_label?: string | null
          group_id?: string | null
          id?: string
          operator_id?: string
          service_date?: string
          service_id?: string | null
          tenant_id?: string
          to_driver_profile_id?: string | null
          to_vehicle_label?: string | null
        }
        Relationships: []
      }
      driver_daily_availability: {
        Row: {
          available: boolean
          available_from: string | null
          available_to: string | null
          created_at: string
          date: string
          driver_profile_id: string | null
          driver_user_id: string | null
          id: string
          notes: string | null
          tenant_id: string
          updated_at: string
          vehicle_1_from: string | null
          vehicle_1_id: string | null
          vehicle_1_to: string | null
          vehicle_2_from: string | null
          vehicle_2_id: string | null
          vehicle_2_to: string | null
        }
        Insert: {
          available?: boolean
          available_from?: string | null
          available_to?: string | null
          created_at?: string
          date: string
          driver_profile_id?: string | null
          driver_user_id?: string | null
          id?: string
          notes?: string | null
          tenant_id: string
          updated_at?: string
          vehicle_1_from?: string | null
          vehicle_1_id?: string | null
          vehicle_1_to?: string | null
          vehicle_2_from?: string | null
          vehicle_2_id?: string | null
          vehicle_2_to?: string | null
        }
        Update: {
          available?: boolean
          available_from?: string | null
          available_to?: string | null
          created_at?: string
          date?: string
          driver_profile_id?: string | null
          driver_user_id?: string | null
          id?: string
          notes?: string | null
          tenant_id?: string
          updated_at?: string
          vehicle_1_from?: string | null
          vehicle_1_id?: string | null
          vehicle_1_to?: string | null
          vehicle_2_from?: string | null
          vehicle_2_id?: string | null
          vehicle_2_to?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "driver_daily_availability_driver_profile_id_fkey"
            columns: ["driver_profile_id"]
            isOneToOne: false
            referencedRelation: "driver_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "driver_daily_availability_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "driver_daily_availability_vehicle_1_id_fkey"
            columns: ["vehicle_1_id"]
            isOneToOne: false
            referencedRelation: "vehicles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "driver_daily_availability_vehicle_2_id_fkey"
            columns: ["vehicle_2_id"]
            isOneToOne: false
            referencedRelation: "vehicles"
            referencedColumns: ["id"]
          },
        ]
      }
      driver_profiles: {
        Row: {
          active: boolean
          created_at: string
          full_name: string
          id: string
          license_expiry: string | null
          license_number: string | null
          phone: string | null
          tachograph_card_document_path: string | null
          tachograph_card_expiry: string | null
          tachograph_card_number: string | null
          tenant_id: string
          user_id: string | null
        }
        Insert: {
          active?: boolean
          created_at?: string
          full_name: string
          id?: string
          license_expiry?: string | null
          license_number?: string | null
          phone?: string | null
          tachograph_card_document_path?: string | null
          tachograph_card_expiry?: string | null
          tachograph_card_number?: string | null
          tenant_id: string
          user_id?: string | null
        }
        Update: {
          active?: boolean
          created_at?: string
          full_name?: string
          id?: string
          license_expiry?: string | null
          license_number?: string | null
          phone?: string | null
          tachograph_card_document_path?: string | null
          tachograph_card_expiry?: string | null
          tachograph_card_number?: string | null
          tenant_id?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "driver_profiles_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      drivers: {
        Row: {
          active: boolean
          capacity: number
          created_at: string
          id: string
          name: string
          notes: string | null
          phone: string | null
          tenant_id: string
          updated_at: string
          vehicle_type: string | null
        }
        Insert: {
          active?: boolean
          capacity?: number
          created_at?: string
          id?: string
          name: string
          notes?: string | null
          phone?: string | null
          tenant_id: string
          updated_at?: string
          vehicle_type?: string | null
        }
        Update: {
          active?: boolean
          capacity?: number
          created_at?: string
          id?: string
          name?: string
          notes?: string | null
          phone?: string | null
          tenant_id?: string
          updated_at?: string
          vehicle_type?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "drivers_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      email_import_locks: {
        Row: {
          finished_at: string | null
          last_error: string | null
          last_success_at: string | null
          lock_expires_at: string | null
          mailbox: string
          started_at: string | null
          status: string
          tenant_id: string
          updated_at: string
        }
        Insert: {
          finished_at?: string | null
          last_error?: string | null
          last_success_at?: string | null
          lock_expires_at?: string | null
          mailbox?: string
          started_at?: string | null
          status?: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          finished_at?: string | null
          last_error?: string | null
          last_success_at?: string | null
          lock_expires_at?: string | null
          mailbox?: string
          started_at?: string | null
          status?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "email_import_locks_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      email_import_tests: {
        Row: {
          anomaly_message: string | null
          created_at: string
          date_from: string | null
          date_to: string | null
          duplicate_flag: boolean
          duplicate_of_id: string | null
          extracted_text: string | null
          first_beneficiary: string | null
          id: string
          import_status: string
          ns_contact: string | null
          ns_reference: string | null
          operational_details_json: Json
          operator_review_status: string
          package_description: string | null
          parsed_services_json: Json
          parsing_confidence: string | null
          pax: number | null
          pdf_filename: string | null
          practice_date: string | null
          practice_number: string | null
          program: string | null
          raw_email: string
          received_at: string
          sender_email: string
          service_rows_json: Json
          source_pdf: string | null
          subject: string
          total_amount_practice: number | null
        }
        Insert: {
          anomaly_message?: string | null
          created_at?: string
          date_from?: string | null
          date_to?: string | null
          duplicate_flag?: boolean
          duplicate_of_id?: string | null
          extracted_text?: string | null
          first_beneficiary?: string | null
          id?: string
          import_status?: string
          ns_contact?: string | null
          ns_reference?: string | null
          operational_details_json?: Json
          operator_review_status?: string
          package_description?: string | null
          parsed_services_json?: Json
          parsing_confidence?: string | null
          pax?: number | null
          pdf_filename?: string | null
          practice_date?: string | null
          practice_number?: string | null
          program?: string | null
          raw_email: string
          received_at?: string
          sender_email?: string
          service_rows_json?: Json
          source_pdf?: string | null
          subject?: string
          total_amount_practice?: number | null
        }
        Update: {
          anomaly_message?: string | null
          created_at?: string
          date_from?: string | null
          date_to?: string | null
          duplicate_flag?: boolean
          duplicate_of_id?: string | null
          extracted_text?: string | null
          first_beneficiary?: string | null
          id?: string
          import_status?: string
          ns_contact?: string | null
          ns_reference?: string | null
          operational_details_json?: Json
          operator_review_status?: string
          package_description?: string | null
          parsed_services_json?: Json
          parsing_confidence?: string | null
          pax?: number | null
          pdf_filename?: string | null
          practice_date?: string | null
          practice_number?: string | null
          program?: string | null
          raw_email?: string
          received_at?: string
          sender_email?: string
          service_rows_json?: Json
          source_pdf?: string | null
          subject?: string
          total_amount_practice?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "email_import_tests_duplicate_of_id_fkey"
            columns: ["duplicate_of_id"]
            isOneToOne: false
            referencedRelation: "email_import_tests"
            referencedColumns: ["id"]
          },
        ]
      }
      excursion_allocations: {
        Row: {
          agency_name: string | null
          created_at: string
          customer_name: string
          excursion_unit_id: string
          hotel_name: string | null
          id: string
          notes: string | null
          pax: number
          phone: string | null
          pickup_time: string | null
        }
        Insert: {
          agency_name?: string | null
          created_at?: string
          customer_name: string
          excursion_unit_id: string
          hotel_name?: string | null
          id?: string
          notes?: string | null
          pax?: number
          phone?: string | null
          pickup_time?: string | null
        }
        Update: {
          agency_name?: string | null
          created_at?: string
          customer_name?: string
          excursion_unit_id?: string
          hotel_name?: string | null
          id?: string
          notes?: string | null
          pax?: number
          phone?: string | null
          pickup_time?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "excursion_allocations_excursion_unit_id_fkey"
            columns: ["excursion_unit_id"]
            isOneToOne: false
            referencedRelation: "excursion_units"
            referencedColumns: ["id"]
          },
        ]
      }
      excursion_lines: {
        Row: {
          active: boolean
          color: string
          created_at: string
          days_of_week: number[]
          description: string | null
          excursion_type: string
          icon: string
          id: string
          min_pax: number
          name: string
          price_agency_cents: number
          price_retail_cents: number
          return_time: string | null
          sort_order: number
          tenant_id: string
          valid_from: string | null
        }
        Insert: {
          active?: boolean
          color?: string
          created_at?: string
          days_of_week?: number[]
          description?: string | null
          excursion_type?: string
          icon?: string
          id?: string
          min_pax?: number
          name: string
          price_agency_cents?: number
          price_retail_cents?: number
          return_time?: string | null
          sort_order?: number
          tenant_id: string
          valid_from?: string | null
        }
        Update: {
          active?: boolean
          color?: string
          created_at?: string
          days_of_week?: number[]
          description?: string | null
          excursion_type?: string
          icon?: string
          id?: string
          min_pax?: number
          name?: string
          price_agency_cents?: number
          price_retail_cents?: number
          return_time?: string | null
          sort_order?: number
          tenant_id?: string
          valid_from?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "excursion_lines_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      excursion_pickups: {
        Row: {
          excursion_line_id: string
          id: string
          location: string
          pickup_time: string
          sort_order: number
        }
        Insert: {
          excursion_line_id: string
          id?: string
          location: string
          pickup_time: string
          sort_order?: number
        }
        Update: {
          excursion_line_id?: string
          id?: string
          location?: string
          pickup_time?: string
          sort_order?: number
        }
        Relationships: [
          {
            foreignKeyName: "excursion_pickups_excursion_line_id_fkey"
            columns: ["excursion_line_id"]
            isOneToOne: false
            referencedRelation: "excursion_lines"
            referencedColumns: ["id"]
          },
        ]
      }
      excursion_units: {
        Row: {
          capacity: number
          created_at: string
          departure_time: string | null
          driver_profile_id: string | null
          excursion_date: string
          excursion_line_id: string
          id: string
          label: string
          notes: string | null
          status: string
          tenant_id: string
          vehicle_id: string | null
        }
        Insert: {
          capacity?: number
          created_at?: string
          departure_time?: string | null
          driver_profile_id?: string | null
          excursion_date: string
          excursion_line_id: string
          id?: string
          label: string
          notes?: string | null
          status?: string
          tenant_id: string
          vehicle_id?: string | null
        }
        Update: {
          capacity?: number
          created_at?: string
          departure_time?: string | null
          driver_profile_id?: string | null
          excursion_date?: string
          excursion_line_id?: string
          id?: string
          label?: string
          notes?: string | null
          status?: string
          tenant_id?: string
          vehicle_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "excursion_units_driver_profile_id_fkey"
            columns: ["driver_profile_id"]
            isOneToOne: false
            referencedRelation: "driver_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "excursion_units_excursion_line_id_fkey"
            columns: ["excursion_line_id"]
            isOneToOne: false
            referencedRelation: "excursion_lines"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "excursion_units_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "excursion_units_vehicle_id_fkey"
            columns: ["vehicle_id"]
            isOneToOne: false
            referencedRelation: "vehicles"
            referencedColumns: ["id"]
          },
        ]
      }
      ferry_pickup_rules: {
        Row: {
          agency_logic: string
          arrival_port: string
          arrival_time: string | null
          boat_type: string
          company: string
          created_at: string | null
          days_of_week: number[] | null
          departure_time: string
          direction: string
          embark_port: string | null
          hotel_id: string | null
          id: string
          pickup_time: string | null
          season_notes: string | null
          transport_from: string | null
          transport_to: string | null
          transport_type: string
          updated_at: string | null
          valid_from: string | null
          valid_to: string | null
          zone: string | null
        }
        Insert: {
          agency_logic: string
          arrival_port: string
          arrival_time?: string | null
          boat_type?: string
          company: string
          created_at?: string | null
          days_of_week?: number[] | null
          departure_time: string
          direction?: string
          embark_port?: string | null
          hotel_id?: string | null
          id?: string
          pickup_time?: string | null
          season_notes?: string | null
          transport_from?: string | null
          transport_to?: string | null
          transport_type: string
          updated_at?: string | null
          valid_from?: string | null
          valid_to?: string | null
          zone?: string | null
        }
        Update: {
          agency_logic?: string
          arrival_port?: string
          arrival_time?: string | null
          boat_type?: string
          company?: string
          created_at?: string | null
          days_of_week?: number[] | null
          departure_time?: string
          direction?: string
          embark_port?: string | null
          hotel_id?: string | null
          id?: string
          pickup_time?: string | null
          season_notes?: string | null
          transport_from?: string | null
          transport_to?: string | null
          transport_type?: string
          updated_at?: string | null
          valid_from?: string | null
          valid_to?: string | null
          zone?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "ferry_pickup_rules_hotel_id_fkey"
            columns: ["hotel_id"]
            isOneToOne: false
            referencedRelation: "hotels"
            referencedColumns: ["id"]
          },
        ]
      }
      ferry_schedules: {
        Row: {
          arrival_port: string
          arrival_time: string | null
          company: string
          created_at: string | null
          days_of_week: number[] | null
          departure_port: string
          departure_time: string
          direction: string
          id: string
          notes: string | null
          valid_from: string | null
          valid_to: string | null
        }
        Insert: {
          arrival_port: string
          arrival_time?: string | null
          company: string
          created_at?: string | null
          days_of_week?: number[] | null
          departure_port: string
          departure_time: string
          direction: string
          id?: string
          notes?: string | null
          valid_from?: string | null
          valid_to?: string | null
        }
        Update: {
          arrival_port?: string
          arrival_time?: string | null
          company?: string
          created_at?: string | null
          days_of_week?: number[] | null
          departure_port?: string
          departure_time?: string
          direction?: string
          id?: string
          notes?: string | null
          valid_from?: string | null
          valid_to?: string | null
        }
        Relationships: []
      }
      hotel_aliases: {
        Row: {
          alias: string
          alias_normalized: string
          created_at: string
          hotel_id: string
          id: string
          source: string
          tenant_id: string
          updated_at: string
        }
        Insert: {
          alias: string
          alias_normalized: string
          created_at?: string
          hotel_id: string
          id?: string
          source?: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          alias?: string
          alias_normalized?: string
          created_at?: string
          hotel_id?: string
          id?: string
          source?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "hotel_aliases_hotel_id_fkey"
            columns: ["hotel_id"]
            isOneToOne: false
            referencedRelation: "hotels"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "hotel_aliases_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      hotel_import_runs: {
        Row: {
          completed_at: string | null
          created_count: number
          dry_run: boolean
          error_message: string | null
          fetched_count: number
          force_refresh: boolean
          id: string
          invalid_count: number
          limit_applied: number | null
          payload_json: Json | null
          requested_by_user_id: string | null
          skipped_count: number
          source: string
          started_at: string
          status: string
          tenant_id: string
          updated_count: number
          used_cache: boolean
        }
        Insert: {
          completed_at?: string | null
          created_count?: number
          dry_run?: boolean
          error_message?: string | null
          fetched_count?: number
          force_refresh?: boolean
          id?: string
          invalid_count?: number
          limit_applied?: number | null
          payload_json?: Json | null
          requested_by_user_id?: string | null
          skipped_count?: number
          source: string
          started_at?: string
          status: string
          tenant_id: string
          updated_count?: number
          used_cache?: boolean
        }
        Update: {
          completed_at?: string | null
          created_count?: number
          dry_run?: boolean
          error_message?: string | null
          fetched_count?: number
          force_refresh?: boolean
          id?: string
          invalid_count?: number
          limit_applied?: number | null
          payload_json?: Json | null
          requested_by_user_id?: string | null
          skipped_count?: number
          source?: string
          started_at?: string
          status?: string
          tenant_id?: string
          updated_count?: number
          used_cache?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "hotel_import_runs_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      hotel_pickup_times: {
        Row: {
          comune: string
          hotel_name: string
          id: string
          pickup_time_linea_adriatica: string
          pickup_time_linea_centro: string
          pickup_time_linea_italia: string
        }
        Insert: {
          comune: string
          hotel_name: string
          id?: string
          pickup_time_linea_adriatica: string
          pickup_time_linea_centro: string
          pickup_time_linea_italia: string
        }
        Update: {
          comune?: string
          hotel_name?: string
          id?: string
          pickup_time_linea_adriatica?: string
          pickup_time_linea_centro?: string
          pickup_time_linea_italia?: string
        }
        Relationships: []
      }
      hotel_vehicle_limits: {
        Row: {
          created_at: string
          hotel_id: string | null
          hotel_name: string
          id: string
          max_capacity: number
          notes: string | null
          tenant_id: string
        }
        Insert: {
          created_at?: string
          hotel_id?: string | null
          hotel_name: string
          id?: string
          max_capacity: number
          notes?: string | null
          tenant_id: string
        }
        Update: {
          created_at?: string
          hotel_id?: string | null
          hotel_name?: string
          id?: string
          max_capacity?: number
          notes?: string | null
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "hotel_vehicle_limits_hotel_id_fkey"
            columns: ["hotel_id"]
            isOneToOne: false
            referencedRelation: "hotels"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "hotel_vehicle_limits_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      hotels: {
        Row: {
          address: string
          city: string | null
          contact_name: string | null
          created_at: string
          email: string | null
          formatted_address: string | null
          geo_accuracy: Database["public"]["Enums"]["hotel_geo_accuracy"]
          geo_notes: string | null
          geo_source: Database["public"]["Enums"]["hotel_geo_source"]
          geo_status: Database["public"]["Enums"]["hotel_geo_status"]
          geo_verified_at: string | null
          geo_verified_by: string | null
          id: string
          is_active: boolean
          lat: number | null
          lng: number | null
          name: string
          normalized_name: string | null
          phone: string | null
          pickup_note: string | null
          place_id: string | null
          small_vehicle_max_pax: number | null
          small_vehicle_only: boolean
          source: string
          source_osm_id: number | null
          source_osm_type: string | null
          tenant_id: string
          updated_at: string
          zone: string
        }
        Insert: {
          address: string
          city?: string | null
          contact_name?: string | null
          created_at?: string
          email?: string | null
          formatted_address?: string | null
          geo_accuracy?: Database["public"]["Enums"]["hotel_geo_accuracy"]
          geo_notes?: string | null
          geo_source?: Database["public"]["Enums"]["hotel_geo_source"]
          geo_status?: Database["public"]["Enums"]["hotel_geo_status"]
          geo_verified_at?: string | null
          geo_verified_by?: string | null
          id?: string
          is_active?: boolean
          lat?: number | null
          lng?: number | null
          name: string
          normalized_name?: string | null
          phone?: string | null
          pickup_note?: string | null
          place_id?: string | null
          small_vehicle_max_pax?: number | null
          small_vehicle_only?: boolean
          source?: string
          source_osm_id?: number | null
          source_osm_type?: string | null
          tenant_id: string
          updated_at?: string
          zone: string
        }
        Update: {
          address?: string
          city?: string | null
          contact_name?: string | null
          created_at?: string
          email?: string | null
          formatted_address?: string | null
          geo_accuracy?: Database["public"]["Enums"]["hotel_geo_accuracy"]
          geo_notes?: string | null
          geo_source?: Database["public"]["Enums"]["hotel_geo_source"]
          geo_status?: Database["public"]["Enums"]["hotel_geo_status"]
          geo_verified_at?: string | null
          geo_verified_by?: string | null
          id?: string
          is_active?: boolean
          lat?: number | null
          lng?: number | null
          name?: string
          normalized_name?: string | null
          phone?: string | null
          pickup_note?: string | null
          place_id?: string | null
          small_vehicle_max_pax?: number | null
          small_vehicle_only?: boolean
          source?: string
          source_osm_id?: number | null
          source_osm_type?: string | null
          tenant_id?: string
          updated_at?: string
          zone?: string
        }
        Relationships: [
          {
            foreignKeyName: "hotels_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      inbound_booking_imports: {
        Row: {
          created_at: string
          created_by_user_id: string | null
          error_text: string | null
          extracted_payload: Json
          id: string
          import_status: Database["public"]["Enums"]["import_status"]
          inbound_attachment_id: string | null
          inbound_email_id: string | null
          match_quality:
            | Database["public"]["Enums"]["pricing_match_quality"]
            | null
          parser_key: string | null
          parser_version: string | null
          raw_payload: Json
          review_required: boolean
          reviewed_at: string | null
          reviewed_by_user_id: string | null
          source_kind: Database["public"]["Enums"]["import_source_kind"]
          tenant_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by_user_id?: string | null
          error_text?: string | null
          extracted_payload?: Json
          id?: string
          import_status?: Database["public"]["Enums"]["import_status"]
          inbound_attachment_id?: string | null
          inbound_email_id?: string | null
          match_quality?:
            | Database["public"]["Enums"]["pricing_match_quality"]
            | null
          parser_key?: string | null
          parser_version?: string | null
          raw_payload?: Json
          review_required?: boolean
          reviewed_at?: string | null
          reviewed_by_user_id?: string | null
          source_kind: Database["public"]["Enums"]["import_source_kind"]
          tenant_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by_user_id?: string | null
          error_text?: string | null
          extracted_payload?: Json
          id?: string
          import_status?: Database["public"]["Enums"]["import_status"]
          inbound_attachment_id?: string | null
          inbound_email_id?: string | null
          match_quality?:
            | Database["public"]["Enums"]["pricing_match_quality"]
            | null
          parser_key?: string | null
          parser_version?: string | null
          raw_payload?: Json
          review_required?: boolean
          reviewed_at?: string | null
          reviewed_by_user_id?: string | null
          source_kind?: Database["public"]["Enums"]["import_source_kind"]
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "inbound_booking_imports_inbound_attachment_id_fkey"
            columns: ["inbound_attachment_id"]
            isOneToOne: false
            referencedRelation: "inbound_email_attachments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inbound_booking_imports_inbound_email_id_fkey"
            columns: ["inbound_email_id"]
            isOneToOne: false
            referencedRelation: "inbound_emails"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inbound_booking_imports_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      inbound_booking_items: {
        Row: {
          agency_raw: string | null
          created_at: string
          customer_name: string | null
          direction: Database["public"]["Enums"]["service_direction"] | null
          dropoff_raw: string | null
          external_ref: string | null
          hotel_name_raw: string | null
          id: string
          import_id: string
          match_confidence: number | null
          match_notes: string | null
          match_status: Database["public"]["Enums"]["match_status"]
          matched_agency_alias_id: string | null
          matched_agency_id: string | null
          matched_price_rule_id: string | null
          matched_route_id: string | null
          matched_service_id: string | null
          normalized_payload: Json
          pax: number | null
          pickup_raw: string | null
          service_date: string | null
          service_time: string | null
          service_type: Database["public"]["Enums"]["service_type"] | null
          source_row_no: number | null
          tenant_id: string
          updated_at: string
          vessel_raw: string | null
        }
        Insert: {
          agency_raw?: string | null
          created_at?: string
          customer_name?: string | null
          direction?: Database["public"]["Enums"]["service_direction"] | null
          dropoff_raw?: string | null
          external_ref?: string | null
          hotel_name_raw?: string | null
          id?: string
          import_id: string
          match_confidence?: number | null
          match_notes?: string | null
          match_status?: Database["public"]["Enums"]["match_status"]
          matched_agency_alias_id?: string | null
          matched_agency_id?: string | null
          matched_price_rule_id?: string | null
          matched_route_id?: string | null
          matched_service_id?: string | null
          normalized_payload?: Json
          pax?: number | null
          pickup_raw?: string | null
          service_date?: string | null
          service_time?: string | null
          service_type?: Database["public"]["Enums"]["service_type"] | null
          source_row_no?: number | null
          tenant_id: string
          updated_at?: string
          vessel_raw?: string | null
        }
        Update: {
          agency_raw?: string | null
          created_at?: string
          customer_name?: string | null
          direction?: Database["public"]["Enums"]["service_direction"] | null
          dropoff_raw?: string | null
          external_ref?: string | null
          hotel_name_raw?: string | null
          id?: string
          import_id?: string
          match_confidence?: number | null
          match_notes?: string | null
          match_status?: Database["public"]["Enums"]["match_status"]
          matched_agency_alias_id?: string | null
          matched_agency_id?: string | null
          matched_price_rule_id?: string | null
          matched_route_id?: string | null
          matched_service_id?: string | null
          normalized_payload?: Json
          pax?: number | null
          pickup_raw?: string | null
          service_date?: string | null
          service_time?: string | null
          service_type?: Database["public"]["Enums"]["service_type"] | null
          source_row_no?: number | null
          tenant_id?: string
          updated_at?: string
          vessel_raw?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "inbound_booking_items_import_id_fkey"
            columns: ["import_id"]
            isOneToOne: false
            referencedRelation: "inbound_booking_imports"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inbound_booking_items_matched_agency_alias_id_fkey"
            columns: ["matched_agency_alias_id"]
            isOneToOne: false
            referencedRelation: "agency_aliases"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inbound_booking_items_matched_agency_id_fkey"
            columns: ["matched_agency_id"]
            isOneToOne: false
            referencedRelation: "agencies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inbound_booking_items_matched_price_rule_id_fkey"
            columns: ["matched_price_rule_id"]
            isOneToOne: false
            referencedRelation: "price_rules"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inbound_booking_items_matched_route_id_fkey"
            columns: ["matched_route_id"]
            isOneToOne: false
            referencedRelation: "routes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inbound_booking_items_matched_service_id_fkey"
            columns: ["matched_service_id"]
            isOneToOne: false
            referencedRelation: "services"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inbound_booking_items_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      inbound_email_attachments: {
        Row: {
          created_at: string
          extracted_text: string | null
          filename: string
          id: string
          inbound_email_id: string
          mimetype: string
          size_bytes: number
          stored: boolean
          tenant_id: string
        }
        Insert: {
          created_at?: string
          extracted_text?: string | null
          filename: string
          id?: string
          inbound_email_id: string
          mimetype: string
          size_bytes?: number
          stored?: boolean
          tenant_id: string
        }
        Update: {
          created_at?: string
          extracted_text?: string | null
          filename?: string
          id?: string
          inbound_email_id?: string
          mimetype?: string
          size_bytes?: number
          stored?: boolean
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "inbound_email_attachments_inbound_email_id_fkey"
            columns: ["inbound_email_id"]
            isOneToOne: false
            referencedRelation: "inbound_emails"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inbound_email_attachments_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      inbound_emails: {
        Row: {
          body_html: string | null
          body_text: string | null
          created_at: string
          extracted_text: string | null
          from_email: string | null
          id: string
          parsed_json: Json
          raw_json: Json
          raw_text: string
          subject: string | null
          tenant_id: string
        }
        Insert: {
          body_html?: string | null
          body_text?: string | null
          created_at?: string
          extracted_text?: string | null
          from_email?: string | null
          id?: string
          parsed_json?: Json
          raw_json?: Json
          raw_text: string
          subject?: string | null
          tenant_id: string
        }
        Update: {
          body_html?: string | null
          body_text?: string | null
          created_at?: string
          extracted_text?: string | null
          from_email?: string | null
          id?: string
          parsed_json?: Json
          raw_json?: Json
          raw_text?: string
          subject?: string | null
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "inbound_emails_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      inventory_spare_parts: {
        Row: {
          created_at: string
          created_by: string | null
          id: string
          notes: string | null
          order_date: string | null
          ordered_by_name: string | null
          ordered_from: string | null
          part_code: string | null
          part_name: string
          quantity_on_hand: number
          quantity_ordered: number
          status: string
          supplier: string | null
          tenant_id: string
          unit_cost: number | null
          updated_at: string
          vehicle_id: string | null
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          id?: string
          notes?: string | null
          order_date?: string | null
          ordered_by_name?: string | null
          ordered_from?: string | null
          part_code?: string | null
          part_name: string
          quantity_on_hand?: number
          quantity_ordered?: number
          status?: string
          supplier?: string | null
          tenant_id: string
          unit_cost?: number | null
          updated_at?: string
          vehicle_id?: string | null
        }
        Update: {
          created_at?: string
          created_by?: string | null
          id?: string
          notes?: string | null
          order_date?: string | null
          ordered_by_name?: string | null
          ordered_from?: string | null
          part_code?: string | null
          part_name?: string
          quantity_on_hand?: number
          quantity_ordered?: number
          status?: string
          supplier?: string | null
          tenant_id?: string
          unit_cost?: number | null
          updated_at?: string
          vehicle_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "inventory_spare_parts_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inventory_spare_parts_vehicle_id_fkey"
            columns: ["vehicle_id"]
            isOneToOne: false
            referencedRelation: "vehicles"
            referencedColumns: ["id"]
          },
        ]
      }
      mario_llm_usage: {
        Row: {
          action: string | null
          created_at: string
          failed: boolean
          fallback_used: boolean
          id: string
          input_cost_usd: number | null
          input_tokens: number
          latency_ms: number | null
          model: string
          output_cost_usd: number | null
          output_tokens: number
          request_id: string | null
          tenant_id: string
          total_cost_usd: number | null
          user_id: string
        }
        Insert: {
          action?: string | null
          created_at?: string
          failed?: boolean
          fallback_used?: boolean
          id?: string
          input_cost_usd?: number | null
          input_tokens?: number
          latency_ms?: number | null
          model: string
          output_cost_usd?: number | null
          output_tokens?: number
          request_id?: string | null
          tenant_id: string
          total_cost_usd?: number | null
          user_id: string
        }
        Update: {
          action?: string | null
          created_at?: string
          failed?: boolean
          fallback_used?: boolean
          id?: string
          input_cost_usd?: number | null
          input_tokens?: number
          latency_ms?: number | null
          model?: string
          output_cost_usd?: number | null
          output_tokens?: number
          request_id?: string | null
          tenant_id?: string
          total_cost_usd?: number | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "mario_llm_usage_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      mcp_audit_logs: {
        Row: {
          category: string
          created_at: string
          duration_ms: number
          error_code: string | null
          id: string
          input_summary: Json | null
          request_id: string
          role: string
          success: boolean
          tenant_id: string
          tool_name: string
          user_id: string
        }
        Insert: {
          category: string
          created_at?: string
          duration_ms: number
          error_code?: string | null
          id?: string
          input_summary?: Json | null
          request_id: string
          role: string
          success: boolean
          tenant_id: string
          tool_name: string
          user_id: string
        }
        Update: {
          category?: string
          created_at?: string
          duration_ms?: number
          error_code?: string | null
          id?: string
          input_summary?: Json | null
          request_id?: string
          role?: string
          success?: boolean
          tenant_id?: string
          tool_name?: string
          user_id?: string
        }
        Relationships: []
      }
      medmar_ar_pending_groups: {
        Row: {
          booking_ids: string[]
          converted_ticket_id: string | null
          created_at: string
          created_by: string | null
          current_pax_count: number
          expires_at: string
          id: string
          outbound_time: string | null
          route: string
          status: string
          target_threshold: number
          tenant_id: string
          travel_date: string
          updated_at: string
        }
        Insert: {
          booking_ids?: string[]
          converted_ticket_id?: string | null
          created_at?: string
          created_by?: string | null
          current_pax_count?: number
          expires_at: string
          id?: string
          outbound_time?: string | null
          route: string
          status?: string
          target_threshold?: number
          tenant_id: string
          travel_date: string
          updated_at?: string
        }
        Update: {
          booking_ids?: string[]
          converted_ticket_id?: string | null
          created_at?: string
          created_by?: string | null
          current_pax_count?: number
          expires_at?: string
          id?: string
          outbound_time?: string | null
          route?: string
          status?: string
          target_threshold?: number
          tenant_id?: string
          travel_date?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "medmar_ar_pending_groups_converted_ticket_id_fkey"
            columns: ["converted_ticket_id"]
            isOneToOne: false
            referencedRelation: "medmar_ar_tickets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "medmar_ar_pending_groups_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      medmar_ar_prices: {
        Row: {
          created_at: string
          created_by: string | null
          id: string
          price_cents: number
          price_type: string
          tenant_id: string
          valid_from: string
          valid_to: string | null
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          id?: string
          price_cents: number
          price_type: string
          tenant_id: string
          valid_from: string
          valid_to?: string | null
        }
        Update: {
          created_at?: string
          created_by?: string | null
          id?: string
          price_cents?: number
          price_type?: string
          tenant_id?: string
          valid_from?: string
          valid_to?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "medmar_ar_prices_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      medmar_ar_ticket_legs: {
        Row: {
          created_at: string
          id: string
          leg_route: string
          leg_time: string | null
          leg_type: string
          original_booking_id: string | null
          price_per_pax_cents: number
          reassigned_booking_id: string | null
          status: string
          status_changed_at: string | null
          status_changed_by: string | null
          tenant_id: string
          ticket_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          leg_route: string
          leg_time?: string | null
          leg_type: string
          original_booking_id?: string | null
          price_per_pax_cents: number
          reassigned_booking_id?: string | null
          status?: string
          status_changed_at?: string | null
          status_changed_by?: string | null
          tenant_id: string
          ticket_id: string
        }
        Update: {
          created_at?: string
          id?: string
          leg_route?: string
          leg_time?: string | null
          leg_type?: string
          original_booking_id?: string | null
          price_per_pax_cents?: number
          reassigned_booking_id?: string | null
          status?: string
          status_changed_at?: string | null
          status_changed_by?: string | null
          tenant_id?: string
          ticket_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "medmar_ar_ticket_legs_original_booking_id_fkey"
            columns: ["original_booking_id"]
            isOneToOne: false
            referencedRelation: "services"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "medmar_ar_ticket_legs_reassigned_booking_id_fkey"
            columns: ["reassigned_booking_id"]
            isOneToOne: false
            referencedRelation: "services"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "medmar_ar_ticket_legs_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "medmar_ar_ticket_legs_ticket_id_fkey"
            columns: ["ticket_id"]
            isOneToOne: false
            referencedRelation: "medmar_ar_tickets"
            referencedColumns: ["id"]
          },
        ]
      }
      medmar_ar_tickets: {
        Row: {
          created_at: string
          id: string
          is_test_data: boolean
          issuing_operator_id: string | null
          notes: string | null
          outbound_time: string | null
          pax_count: number
          return_time: string | null
          route: string
          tenant_id: string
          ticket_mode: string
          total_price_cents: number
          travel_date: string
          unit_price_cents: number
          voucher_number: string
        }
        Insert: {
          created_at?: string
          id?: string
          is_test_data?: boolean
          issuing_operator_id?: string | null
          notes?: string | null
          outbound_time?: string | null
          pax_count: number
          return_time?: string | null
          route: string
          tenant_id: string
          ticket_mode: string
          total_price_cents: number
          travel_date: string
          unit_price_cents: number
          voucher_number: string
        }
        Update: {
          created_at?: string
          id?: string
          is_test_data?: boolean
          issuing_operator_id?: string | null
          notes?: string | null
          outbound_time?: string | null
          pax_count?: number
          return_time?: string | null
          route?: string
          tenant_id?: string
          ticket_mode?: string
          total_price_cents?: number
          travel_date?: string
          unit_price_cents?: number
          voucher_number?: string
        }
        Relationships: [
          {
            foreignKeyName: "medmar_ar_tickets_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      medmar_convocation_batches: {
        Row: {
          created_at: string
          created_by: string
          error_count: number
          file_name: string
          id: string
          label: string
          sent_count: number
          skipped_count: number
          status: string
          tenant_id: string
          total_rows: number
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by: string
          error_count?: number
          file_name?: string
          id?: string
          label?: string
          sent_count?: number
          skipped_count?: number
          status?: string
          tenant_id: string
          total_rows?: number
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string
          error_count?: number
          file_name?: string
          id?: string
          label?: string
          sent_count?: number
          skipped_count?: number
          status?: string
          tenant_id?: string
          total_rows?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "medmar_convocation_batches_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      medmar_convocation_rows: {
        Row: {
          arrival_port: string
          batch_id: string
          booking_reference: string
          company: string
          created_at: string
          customer_name: string
          departure_port: string
          departure_time: string
          error_message: string | null
          generated_message: string
          hotel: string
          id: string
          inviare: boolean
          notes: string
          passengers: string
          phone_e164: string | null
          phone_raw: string
          pickup_time: string
          provider_message_id: string | null
          route: string
          row_index: number
          sent_at: string | null
          service_id: string | null
          status: string
          template_payload: Json
          tenant_id: string
          travel_date: string
          travel_date_iso: string | null
          updated_at: string
        }
        Insert: {
          arrival_port?: string
          batch_id: string
          booking_reference?: string
          company?: string
          created_at?: string
          customer_name?: string
          departure_port?: string
          departure_time?: string
          error_message?: string | null
          generated_message?: string
          hotel?: string
          id?: string
          inviare?: boolean
          notes?: string
          passengers?: string
          phone_e164?: string | null
          phone_raw?: string
          pickup_time?: string
          provider_message_id?: string | null
          route?: string
          row_index: number
          sent_at?: string | null
          service_id?: string | null
          status?: string
          template_payload?: Json
          tenant_id: string
          travel_date?: string
          travel_date_iso?: string | null
          updated_at?: string
        }
        Update: {
          arrival_port?: string
          batch_id?: string
          booking_reference?: string
          company?: string
          created_at?: string
          customer_name?: string
          departure_port?: string
          departure_time?: string
          error_message?: string | null
          generated_message?: string
          hotel?: string
          id?: string
          inviare?: boolean
          notes?: string
          passengers?: string
          phone_e164?: string | null
          phone_raw?: string
          pickup_time?: string
          provider_message_id?: string | null
          route?: string
          row_index?: number
          sent_at?: string | null
          service_id?: string | null
          status?: string
          template_payload?: Json
          tenant_id?: string
          travel_date?: string
          travel_date_iso?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "medmar_convocation_rows_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "medmar_convocation_batches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "medmar_convocation_rows_service_id_fkey"
            columns: ["service_id"]
            isOneToOne: false
            referencedRelation: "services"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "medmar_convocation_rows_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      medmar_convocation_send_logs: {
        Row: {
          api_response_json: Json | null
          attempt_number: number
          attempted_at: string
          batch_id: string
          error_message: string | null
          id: string
          language_code: string
          operator_user_id: string
          phone_e164: string
          provider_message_id: string | null
          row_id: string
          status: string
          template_name: string
          tenant_id: string
          variables_json: Json
        }
        Insert: {
          api_response_json?: Json | null
          attempt_number?: number
          attempted_at?: string
          batch_id: string
          error_message?: string | null
          id?: string
          language_code?: string
          operator_user_id: string
          phone_e164: string
          provider_message_id?: string | null
          row_id: string
          status: string
          template_name: string
          tenant_id: string
          variables_json?: Json
        }
        Update: {
          api_response_json?: Json | null
          attempt_number?: number
          attempted_at?: string
          batch_id?: string
          error_message?: string | null
          id?: string
          language_code?: string
          operator_user_id?: string
          phone_e164?: string
          provider_message_id?: string | null
          row_id?: string
          status?: string
          template_name?: string
          tenant_id?: string
          variables_json?: Json
        }
        Relationships: [
          {
            foreignKeyName: "medmar_convocation_send_logs_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "medmar_convocation_batches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "medmar_convocation_send_logs_row_id_fkey"
            columns: ["row_id"]
            isOneToOne: false
            referencedRelation: "medmar_convocation_rows"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "medmar_convocation_send_logs_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      medmar_credit_settings: {
        Row: {
          created_at: string
          id: string
          initial_credit_cents: number
          notes: string | null
          safety_threshold_cents: number
          tenant_id: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          created_at?: string
          id?: string
          initial_credit_cents?: number
          notes?: string | null
          safety_threshold_cents?: number
          tenant_id: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          created_at?: string
          id?: string
          initial_credit_cents?: number
          notes?: string | null
          safety_threshold_cents?: number
          tenant_id?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "medmar_credit_settings_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: true
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      medmar_credit_topups: {
        Row: {
          amount_cents: number
          created_at: string
          created_by: string | null
          id: string
          notes: string | null
          tenant_id: string
          topup_date: string
        }
        Insert: {
          amount_cents: number
          created_at?: string
          created_by?: string | null
          id?: string
          notes?: string | null
          tenant_id: string
          topup_date?: string
        }
        Update: {
          amount_cents?: number
          created_at?: string
          created_by?: string | null
          id?: string
          notes?: string | null
          tenant_id?: string
          topup_date?: string
        }
        Relationships: [
          {
            foreignKeyName: "medmar_credit_topups_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      medmar_delivery_attempts: {
        Row: {
          attempt_count: number
          created_at: string
          created_by: string | null
          delivered_at: string | null
          id: string
          issuing_attempt_id: string
          last_error_code: string | null
          last_error_message: string | null
          medmar_id_prenotazione: string | null
          medmar_numero: string | null
          pdf_cleaned_sha256: string | null
          pdf_filename: string | null
          pdf_mailbox_message_uid: string | null
          pdf_original_sha256: string | null
          recipient_email: string | null
          recipient_name: string | null
          recipient_type: string | null
          resend_message_id: string | null
          service_ids: string[]
          status: string
          tenant_id: string
          updated_at: string
        }
        Insert: {
          attempt_count?: number
          created_at?: string
          created_by?: string | null
          delivered_at?: string | null
          id?: string
          issuing_attempt_id: string
          last_error_code?: string | null
          last_error_message?: string | null
          medmar_id_prenotazione?: string | null
          medmar_numero?: string | null
          pdf_cleaned_sha256?: string | null
          pdf_filename?: string | null
          pdf_mailbox_message_uid?: string | null
          pdf_original_sha256?: string | null
          recipient_email?: string | null
          recipient_name?: string | null
          recipient_type?: string | null
          resend_message_id?: string | null
          service_ids: string[]
          status: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          attempt_count?: number
          created_at?: string
          created_by?: string | null
          delivered_at?: string | null
          id?: string
          issuing_attempt_id?: string
          last_error_code?: string | null
          last_error_message?: string | null
          medmar_id_prenotazione?: string | null
          medmar_numero?: string | null
          pdf_cleaned_sha256?: string | null
          pdf_filename?: string | null
          pdf_mailbox_message_uid?: string | null
          pdf_original_sha256?: string | null
          recipient_email?: string | null
          recipient_name?: string | null
          recipient_type?: string | null
          resend_message_id?: string | null
          service_ids?: string[]
          status?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "medmar_delivery_attempts_issuing_attempt_id_fkey"
            columns: ["issuing_attempt_id"]
            isOneToOne: false
            referencedRelation: "medmar_issuing_attempts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "medmar_delivery_attempts_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      medmar_fleet_plate_changes: {
        Row: {
          changed_at: string
          changed_by: string | null
          credit_cents: number
          id: string
          new_meters: number
          new_plate: string
          new_vehicle_id: string | null
          notes: string | null
          original_meters: number
          original_plate: string
          tenant_id: string
          ticket_id: string
        }
        Insert: {
          changed_at?: string
          changed_by?: string | null
          credit_cents?: number
          id?: string
          new_meters: number
          new_plate: string
          new_vehicle_id?: string | null
          notes?: string | null
          original_meters: number
          original_plate: string
          tenant_id: string
          ticket_id: string
        }
        Update: {
          changed_at?: string
          changed_by?: string | null
          credit_cents?: number
          id?: string
          new_meters?: number
          new_plate?: string
          new_vehicle_id?: string | null
          notes?: string | null
          original_meters?: number
          original_plate?: string
          tenant_id?: string
          ticket_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "medmar_fleet_plate_changes_new_vehicle_id_fkey"
            columns: ["new_vehicle_id"]
            isOneToOne: false
            referencedRelation: "vehicles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "medmar_fleet_plate_changes_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "medmar_fleet_plate_changes_ticket_id_fkey"
            columns: ["ticket_id"]
            isOneToOne: false
            referencedRelation: "medmar_fleet_tickets"
            referencedColumns: ["id"]
          },
        ]
      }
      medmar_fleet_prices: {
        Row: {
          created_at: string
          created_by: string | null
          id: string
          meters_from: number
          meters_to: number
          notes: string | null
          price_ar_cents: number
          price_single_cents: number
          route: string
          tenant_id: string
          valid_from: string
          valid_to: string | null
          vehicle_type: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          id?: string
          meters_from: number
          meters_to: number
          notes?: string | null
          price_ar_cents: number
          price_single_cents: number
          route: string
          tenant_id: string
          valid_from?: string
          valid_to?: string | null
          vehicle_type: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          id?: string
          meters_from?: number
          meters_to?: number
          notes?: string | null
          price_ar_cents?: number
          price_single_cents?: number
          route?: string
          tenant_id?: string
          valid_from?: string
          valid_to?: string | null
          vehicle_type?: string
        }
        Relationships: [
          {
            foreignKeyName: "medmar_fleet_prices_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      medmar_fleet_tickets: {
        Row: {
          created_at: string
          created_by: string | null
          id: string
          length_meters: number
          notes: string | null
          outbound_time: string | null
          outbound_used: boolean
          plate: string
          price_cents: number
          price_id: string | null
          return_reassigned_to_ticket_id: string | null
          return_time: string | null
          return_used: boolean
          route: string
          status: string
          tenant_id: string
          ticket_mode: string
          travel_date: string
          vehicle_id: string | null
          vehicle_type: string
          voucher_number: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          id?: string
          length_meters: number
          notes?: string | null
          outbound_time?: string | null
          outbound_used?: boolean
          plate: string
          price_cents: number
          price_id?: string | null
          return_reassigned_to_ticket_id?: string | null
          return_time?: string | null
          return_used?: boolean
          route: string
          status?: string
          tenant_id: string
          ticket_mode: string
          travel_date: string
          vehicle_id?: string | null
          vehicle_type: string
          voucher_number: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          id?: string
          length_meters?: number
          notes?: string | null
          outbound_time?: string | null
          outbound_used?: boolean
          plate?: string
          price_cents?: number
          price_id?: string | null
          return_reassigned_to_ticket_id?: string | null
          return_time?: string | null
          return_used?: boolean
          route?: string
          status?: string
          tenant_id?: string
          ticket_mode?: string
          travel_date?: string
          vehicle_id?: string | null
          vehicle_type?: string
          voucher_number?: string
        }
        Relationships: [
          {
            foreignKeyName: "medmar_fleet_tickets_price_id_fkey"
            columns: ["price_id"]
            isOneToOne: false
            referencedRelation: "medmar_fleet_prices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "medmar_fleet_tickets_return_reassigned_to_ticket_id_fkey"
            columns: ["return_reassigned_to_ticket_id"]
            isOneToOne: false
            referencedRelation: "medmar_fleet_tickets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "medmar_fleet_tickets_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "medmar_fleet_tickets_vehicle_id_fkey"
            columns: ["vehicle_id"]
            isOneToOne: false
            referencedRelation: "vehicles"
            referencedColumns: ["id"]
          },
        ]
      }
      medmar_issue_confirmations: {
        Row: {
          created_at: string
          created_by: string
          expected_total_cents: number
          expires_at: string
          id: string
          route_snapshot: Json
          service_ids: string[]
          tenant_id: string
          token: string
          used_at: string | null
        }
        Insert: {
          created_at?: string
          created_by: string
          expected_total_cents: number
          expires_at?: string
          id?: string
          route_snapshot?: Json
          service_ids: string[]
          tenant_id: string
          token?: string
          used_at?: string | null
        }
        Update: {
          created_at?: string
          created_by?: string
          expected_total_cents?: number
          expires_at?: string
          id?: string
          route_snapshot?: Json
          service_ids?: string[]
          tenant_id?: string
          token?: string
          used_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "medmar_issue_confirmations_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      medmar_issuing_attempts: {
        Row: {
          booking_payload_hash: string | null
          completed_at: string | null
          created_at: string
          created_by: string | null
          expected_total_cents: number | null
          final_total_cents: number | null
          id: string
          idempotency_key: string
          last_error_code: string | null
          last_error_message: string | null
          lock_snapshot: Json | null
          medmar_id_prenotazione: string | null
          medmar_numero: string | null
          preflight_snapshot: Json | null
          remote_state_unknown: boolean
          service_ids: string[]
          status: string
          tenant_id: string
          updated_at: string
        }
        Insert: {
          booking_payload_hash?: string | null
          completed_at?: string | null
          created_at?: string
          created_by?: string | null
          expected_total_cents?: number | null
          final_total_cents?: number | null
          id?: string
          idempotency_key: string
          last_error_code?: string | null
          last_error_message?: string | null
          lock_snapshot?: Json | null
          medmar_id_prenotazione?: string | null
          medmar_numero?: string | null
          preflight_snapshot?: Json | null
          remote_state_unknown?: boolean
          service_ids: string[]
          status: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          booking_payload_hash?: string | null
          completed_at?: string | null
          created_at?: string
          created_by?: string | null
          expected_total_cents?: number | null
          final_total_cents?: number | null
          id?: string
          idempotency_key?: string
          last_error_code?: string | null
          last_error_message?: string | null
          lock_snapshot?: Json | null
          medmar_id_prenotazione?: string | null
          medmar_numero?: string | null
          preflight_snapshot?: Json | null
          remote_state_unknown?: boolean
          service_ids?: string[]
          status?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "medmar_issuing_attempts_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      medmar_issuing_events: {
        Row: {
          attempt_id: string
          created_at: string
          created_by: string | null
          details: Json | null
          error_code: string | null
          event_type: string
          id: string
          medmar_id_prenotazione: string | null
          medmar_numero: string | null
          new_status: string
          previous_status: string | null
          service_id: string | null
          tenant_id: string
        }
        Insert: {
          attempt_id: string
          created_at?: string
          created_by?: string | null
          details?: Json | null
          error_code?: string | null
          event_type: string
          id?: string
          medmar_id_prenotazione?: string | null
          medmar_numero?: string | null
          new_status: string
          previous_status?: string | null
          service_id?: string | null
          tenant_id: string
        }
        Update: {
          attempt_id?: string
          created_at?: string
          created_by?: string | null
          details?: Json | null
          error_code?: string | null
          event_type?: string
          id?: string
          medmar_id_prenotazione?: string | null
          medmar_numero?: string | null
          new_status?: string
          previous_status?: string | null
          service_id?: string | null
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "medmar_issuing_events_attempt_id_fkey"
            columns: ["attempt_id"]
            isOneToOne: false
            referencedRelation: "medmar_issuing_attempts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "medmar_issuing_events_service_id_fkey"
            columns: ["service_id"]
            isOneToOne: false
            referencedRelation: "services"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "medmar_issuing_events_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      medmar_service_issuance_locks: {
        Row: {
          acquired_at: string
          expires_at: string
          holder: string | null
          lock_token: string
          service_id: string
          tenant_id: string
        }
        Insert: {
          acquired_at?: string
          expires_at: string
          holder?: string | null
          lock_token: string
          service_id: string
          tenant_id: string
        }
        Update: {
          acquired_at?: string
          expires_at?: string
          holder?: string | null
          lock_token?: string
          service_id?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "medmar_service_issuance_locks_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      medmar_ticket_memory: {
        Row: {
          booking_code: string | null
          created_at: string
          created_by: string | null
          departure_time: string | null
          id: string
          issue_date: string | null
          matched_service_id: string | null
          notes: string | null
          photo_path: string | null
          photo_url: string | null
          price_cents: number | null
          quantity: number
          route_code: string
          status: string
          tariff_label: string | null
          tenant_id: string
          ticket_number: string | null
          travel_date: string
          voucher_label: string | null
        }
        Insert: {
          booking_code?: string | null
          created_at?: string
          created_by?: string | null
          departure_time?: string | null
          id?: string
          issue_date?: string | null
          matched_service_id?: string | null
          notes?: string | null
          photo_path?: string | null
          photo_url?: string | null
          price_cents?: number | null
          quantity?: number
          route_code: string
          status?: string
          tariff_label?: string | null
          tenant_id: string
          ticket_number?: string | null
          travel_date: string
          voucher_label?: string | null
        }
        Update: {
          booking_code?: string | null
          created_at?: string
          created_by?: string | null
          departure_time?: string | null
          id?: string
          issue_date?: string | null
          matched_service_id?: string | null
          notes?: string | null
          photo_path?: string | null
          photo_url?: string | null
          price_cents?: number | null
          quantity?: number
          route_code?: string
          status?: string
          tariff_label?: string | null
          tenant_id?: string
          ticket_number?: string | null
          travel_date?: string
          voucher_label?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "medmar_ticket_memory_matched_service_id_fkey"
            columns: ["matched_service_id"]
            isOneToOne: false
            referencedRelation: "services"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "medmar_ticket_memory_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      medmar_ticket_resends: {
        Row: {
          created_at: string
          created_by: string | null
          delivery_attempt_id: string
          error_code: string | null
          error_message: string | null
          hash_warning: boolean
          id: string
          issuing_attempt_id: string | null
          medmar_id_prenotazione: string
          medmar_numero: string
          original_pdf_sha256: string | null
          pdf_cleaned_sha256: string | null
          recipient_email: string
          resend_message_id: string | null
          sent_at: string | null
          status: string
          tenant_id: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          delivery_attempt_id: string
          error_code?: string | null
          error_message?: string | null
          hash_warning?: boolean
          id?: string
          issuing_attempt_id?: string | null
          medmar_id_prenotazione: string
          medmar_numero: string
          original_pdf_sha256?: string | null
          pdf_cleaned_sha256?: string | null
          recipient_email: string
          resend_message_id?: string | null
          sent_at?: string | null
          status: string
          tenant_id: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          delivery_attempt_id?: string
          error_code?: string | null
          error_message?: string | null
          hash_warning?: boolean
          id?: string
          issuing_attempt_id?: string | null
          medmar_id_prenotazione?: string
          medmar_numero?: string
          original_pdf_sha256?: string | null
          pdf_cleaned_sha256?: string | null
          recipient_email?: string
          resend_message_id?: string | null
          sent_at?: string | null
          status?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "medmar_ticket_resends_delivery_attempt_id_fkey"
            columns: ["delivery_attempt_id"]
            isOneToOne: false
            referencedRelation: "medmar_delivery_attempts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "medmar_ticket_resends_issuing_attempt_id_fkey"
            columns: ["issuing_attempt_id"]
            isOneToOne: false
            referencedRelation: "medmar_issuing_attempts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "medmar_ticket_resends_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      memberships: {
        Row: {
          agency_id: string | null
          created_at: string
          full_name: string
          max_vehicle_capacity: number | null
          role: Database["public"]["Enums"]["app_role"]
          suspended: boolean
          tenant_id: string
          user_id: string
          username: string | null
        }
        Insert: {
          agency_id?: string | null
          created_at?: string
          full_name: string
          max_vehicle_capacity?: number | null
          role: Database["public"]["Enums"]["app_role"]
          suspended?: boolean
          tenant_id: string
          user_id: string
          username?: string | null
        }
        Update: {
          agency_id?: string | null
          created_at?: string
          full_name?: string
          max_vehicle_capacity?: number | null
          role?: Database["public"]["Enums"]["app_role"]
          suspended?: boolean
          tenant_id?: string
          user_id?: string
          username?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "memberships_agency_id_fkey"
            columns: ["agency_id"]
            isOneToOne: false
            referencedRelation: "agencies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "memberships_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      modification_requests: {
        Row: {
          changes: Json
          created_at: string
          id: string
          operator_notes: string | null
          original_values: Json
          requested_by_user_id: string | null
          resolved_at: string | null
          resolved_by_user_id: string | null
          service_id: string
          status: string
          tenant_id: string
          updated_at: string
        }
        Insert: {
          changes?: Json
          created_at?: string
          id?: string
          operator_notes?: string | null
          original_values?: Json
          requested_by_user_id?: string | null
          resolved_at?: string | null
          resolved_by_user_id?: string | null
          service_id: string
          status?: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          changes?: Json
          created_at?: string
          id?: string
          operator_notes?: string | null
          original_values?: Json
          requested_by_user_id?: string | null
          resolved_at?: string | null
          resolved_by_user_id?: string | null
          service_id?: string
          status?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "modification_requests_service_id_fkey"
            columns: ["service_id"]
            isOneToOne: false
            referencedRelation: "services"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "modification_requests_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      notifications: {
        Row: {
          agency_id: string | null
          body: string | null
          created_at: string
          id: string
          link: string | null
          read: boolean
          reference_id: string | null
          role_target: string | null
          tenant_id: string
          title: string
          type: string
          user_id: string | null
        }
        Insert: {
          agency_id?: string | null
          body?: string | null
          created_at?: string
          id?: string
          link?: string | null
          read?: boolean
          reference_id?: string | null
          role_target?: string | null
          tenant_id: string
          title: string
          type: string
          user_id?: string | null
        }
        Update: {
          agency_id?: string | null
          body?: string | null
          created_at?: string
          id?: string
          link?: string | null
          read?: boolean
          reference_id?: string | null
          role_target?: string | null
          tenant_id?: string
          title?: string
          type?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "notifications_agency_id_fkey"
            columns: ["agency_id"]
            isOneToOne: false
            referencedRelation: "agencies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notifications_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      operations_suggestions: {
        Row: {
          action_payload: Json
          created_at: string
          id: string
          resolution_note: string | null
          resolved: boolean
          resolved_at: string | null
          resolved_by_name: string | null
          resolved_by_user_id: string | null
          restore_note: string | null
          restored_at: string | null
          restored_by_name: string | null
          restored_by_user_id: string | null
          suggestion_id: string
          tenant_id: string
          type: string
          updated_at: string
        }
        Insert: {
          action_payload?: Json
          created_at?: string
          id?: string
          resolution_note?: string | null
          resolved?: boolean
          resolved_at?: string | null
          resolved_by_name?: string | null
          resolved_by_user_id?: string | null
          restore_note?: string | null
          restored_at?: string | null
          restored_by_name?: string | null
          restored_by_user_id?: string | null
          suggestion_id: string
          tenant_id: string
          type: string
          updated_at?: string
        }
        Update: {
          action_payload?: Json
          created_at?: string
          id?: string
          resolution_note?: string | null
          resolved?: boolean
          resolved_at?: string | null
          resolved_by_name?: string | null
          resolved_by_user_id?: string | null
          restore_note?: string | null
          restored_at?: string | null
          restored_by_name?: string | null
          restored_by_user_id?: string | null
          suggestion_id?: string
          tenant_id?: string
          type?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "operations_suggestions_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      ops_audit_events: {
        Row: {
          created_at: string
          details: Json | null
          duplicate: boolean
          event: string
          id: string
          inbound_email_id: string | null
          level: string
          outcome: string | null
          parser_key: string | null
          parsing_quality: string | null
          role: string | null
          service_id: string | null
          tenant_id: string
          user_id: string | null
        }
        Insert: {
          created_at?: string
          details?: Json | null
          duplicate?: boolean
          event: string
          id?: string
          inbound_email_id?: string | null
          level?: string
          outcome?: string | null
          parser_key?: string | null
          parsing_quality?: string | null
          role?: string | null
          service_id?: string | null
          tenant_id: string
          user_id?: string | null
        }
        Update: {
          created_at?: string
          details?: Json | null
          duplicate?: boolean
          event?: string
          id?: string
          inbound_email_id?: string | null
          level?: string
          outcome?: string | null
          parser_key?: string | null
          parsing_quality?: string | null
          role?: string | null
          service_id?: string | null
          tenant_id?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "ops_audit_events_inbound_email_id_fkey"
            columns: ["inbound_email_id"]
            isOneToOne: false
            referencedRelation: "inbound_emails"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ops_audit_events_service_id_fkey"
            columns: ["service_id"]
            isOneToOne: false
            referencedRelation: "services"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ops_audit_events_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      ops_report_jobs: {
        Row: {
          created_at: string
          created_by_user_id: string | null
          id: string
          job_type: string
          owner_name: string | null
          payload: Json
          status: string
          target_date: string
          tenant_id: string
        }
        Insert: {
          created_at?: string
          created_by_user_id?: string | null
          id?: string
          job_type: string
          owner_name?: string | null
          payload?: Json
          status?: string
          target_date: string
          tenant_id: string
        }
        Update: {
          created_at?: string
          created_by_user_id?: string | null
          id?: string
          job_type?: string
          owner_name?: string | null
          payload?: Json
          status?: string
          target_date?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "ops_report_jobs_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      otp_sessions: {
        Row: {
          attempts_remaining: number | null
          created_at: string | null
          email: string
          expires_at: string
          id: string
          otp_code: string
          user_id: string
          verified_at: string | null
        }
        Insert: {
          attempts_remaining?: number | null
          created_at?: string | null
          email: string
          expires_at: string
          id?: string
          otp_code: string
          user_id: string
          verified_at?: string | null
        }
        Update: {
          attempts_remaining?: number | null
          created_at?: string | null
          email?: string
          expires_at?: string
          id?: string
          otp_code?: string
          user_id?: string
          verified_at?: string | null
        }
        Relationships: []
      }
      piano_operator_decisions: {
        Row: {
          action: string
          after_json: Json | null
          before_json: Json | null
          confirmed_at: string
          confirmed_by: string
          created_at: string
          decision_type: string
          id: string
          payload_json: Json
          revoked_at: string | null
          revoked_by: string | null
          service_date: string
          status: string
          suggestion_hash: string
          tenant_id: string
          trip_group_id: string | null
        }
        Insert: {
          action: string
          after_json?: Json | null
          before_json?: Json | null
          confirmed_at?: string
          confirmed_by: string
          created_at?: string
          decision_type: string
          id?: string
          payload_json?: Json
          revoked_at?: string | null
          revoked_by?: string | null
          service_date: string
          status?: string
          suggestion_hash: string
          tenant_id: string
          trip_group_id?: string | null
        }
        Update: {
          action?: string
          after_json?: Json | null
          before_json?: Json | null
          confirmed_at?: string
          confirmed_by?: string
          created_at?: string
          decision_type?: string
          id?: string
          payload_json?: Json
          revoked_at?: string | null
          revoked_by?: string | null
          service_date?: string
          status?: string
          suggestion_hash?: string
          tenant_id?: string
          trip_group_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "piano_operator_decisions_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "piano_operator_decisions_trip_group_id_fkey"
            columns: ["trip_group_id"]
            isOneToOne: false
            referencedRelation: "trip_groups"
            referencedColumns: ["id"]
          },
        ]
      }
      pickup_run_arrivals: {
        Row: {
          arrival_time: string
          ferry_name: string
          id: string
          notes: string | null
          pax: number
          run_id: string
          service_id: string | null
        }
        Insert: {
          arrival_time: string
          ferry_name: string
          id?: string
          notes?: string | null
          pax?: number
          run_id: string
          service_id?: string | null
        }
        Update: {
          arrival_time?: string
          ferry_name?: string
          id?: string
          notes?: string | null
          pax?: number
          run_id?: string
          service_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "pickup_run_arrivals_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "pickup_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pickup_run_arrivals_service_id_fkey"
            columns: ["service_id"]
            isOneToOne: false
            referencedRelation: "services"
            referencedColumns: ["id"]
          },
        ]
      }
      pickup_run_buses: {
        Row: {
          direction: string
          direction_label: string
          driver_profile_id: string | null
          id: string
          notes: string | null
          pax_assigned: number
          run_id: string
          vehicle_id: string | null
        }
        Insert: {
          direction: string
          direction_label: string
          driver_profile_id?: string | null
          id?: string
          notes?: string | null
          pax_assigned?: number
          run_id: string
          vehicle_id?: string | null
        }
        Update: {
          direction?: string
          direction_label?: string
          driver_profile_id?: string | null
          id?: string
          notes?: string | null
          pax_assigned?: number
          run_id?: string
          vehicle_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "pickup_run_buses_driver_profile_id_fkey"
            columns: ["driver_profile_id"]
            isOneToOne: false
            referencedRelation: "driver_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pickup_run_buses_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "pickup_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pickup_run_buses_vehicle_id_fkey"
            columns: ["vehicle_id"]
            isOneToOne: false
            referencedRelation: "vehicles"
            referencedColumns: ["id"]
          },
        ]
      }
      pickup_run_services: {
        Row: {
          created_at: string
          hotel_id: string | null
          hotel_name: string
          hotel_zone: string | null
          id: string
          moved_to_dist_bus_id: string | null
          passenger_name: string
          passenger_phone: string | null
          pax: number
          run_id: string
          service_id: string | null
          tenant_id: string
        }
        Insert: {
          created_at?: string
          hotel_id?: string | null
          hotel_name: string
          hotel_zone?: string | null
          id?: string
          moved_to_dist_bus_id?: string | null
          passenger_name: string
          passenger_phone?: string | null
          pax?: number
          run_id: string
          service_id?: string | null
          tenant_id: string
        }
        Update: {
          created_at?: string
          hotel_id?: string | null
          hotel_name?: string
          hotel_zone?: string | null
          id?: string
          moved_to_dist_bus_id?: string | null
          passenger_name?: string
          passenger_phone?: string | null
          pax?: number
          run_id?: string
          service_id?: string | null
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "pickup_run_services_hotel_id_fkey"
            columns: ["hotel_id"]
            isOneToOne: false
            referencedRelation: "hotels"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pickup_run_services_moved_to_dist_bus_id_fkey"
            columns: ["moved_to_dist_bus_id"]
            isOneToOne: false
            referencedRelation: "bus_ischia_dist_buses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pickup_run_services_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "pickup_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pickup_run_services_service_id_fkey"
            columns: ["service_id"]
            isOneToOne: false
            referencedRelation: "services"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pickup_run_services_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      pickup_runs: {
        Row: {
          bus_line_family_code: string | null
          created_at: string
          direction: string
          id: string
          line_color: string | null
          notes: string | null
          port: string
          run_date: string
          status: string
          tenant_id: string
          total_pax: number
          window_close: string
          window_open: string
        }
        Insert: {
          bus_line_family_code?: string | null
          created_at?: string
          direction?: string
          id?: string
          line_color?: string | null
          notes?: string | null
          port: string
          run_date: string
          status?: string
          tenant_id: string
          total_pax?: number
          window_close: string
          window_open: string
        }
        Update: {
          bus_line_family_code?: string | null
          created_at?: string
          direction?: string
          id?: string
          line_color?: string | null
          notes?: string | null
          port?: string
          run_date?: string
          status?: string
          tenant_id?: string
          total_pax?: number
          window_close?: string
          window_open?: string
        }
        Relationships: [
          {
            foreignKeyName: "pickup_runs_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      place_aliases: {
        Row: {
          alias: string
          alias_normalized: string
          created_at: string
          id: string
          place_id: string
          source: string
          tenant_id: string
        }
        Insert: {
          alias: string
          alias_normalized: string
          created_at?: string
          id?: string
          place_id: string
          source?: string
          tenant_id: string
        }
        Update: {
          alias?: string
          alias_normalized?: string
          created_at?: string
          id?: string
          place_id?: string
          source?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "place_aliases_place_id_fkey"
            columns: ["place_id"]
            isOneToOne: false
            referencedRelation: "places"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "place_aliases_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      places: {
        Row: {
          active: boolean
          address: string | null
          city: string | null
          confidence: number
          created_at: string
          geo_source: string
          id: string
          lat: number | null
          lng: number | null
          name: string
          normalized_name: string
          place_type: string
          tenant_id: string
          updated_at: string
          zone: string | null
        }
        Insert: {
          active?: boolean
          address?: string | null
          city?: string | null
          confidence?: number
          created_at?: string
          geo_source?: string
          id?: string
          lat?: number | null
          lng?: number | null
          name: string
          normalized_name: string
          place_type: string
          tenant_id: string
          updated_at?: string
          zone?: string | null
        }
        Update: {
          active?: boolean
          address?: string | null
          city?: string | null
          confidence?: number
          created_at?: string
          geo_source?: string
          id?: string
          lat?: number | null
          lng?: number | null
          name?: string
          normalized_name?: string
          place_type?: string
          tenant_id?: string
          updated_at?: string
          zone?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "places_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      port_routing_rules: {
        Row: {
          direction: string
          id: string
          label: string
          port: string
          sort_order: number
          tenant_id: string
          zone_filter: string[]
        }
        Insert: {
          direction: string
          id?: string
          label: string
          port: string
          sort_order?: number
          tenant_id: string
          zone_filter: string[]
        }
        Update: {
          direction?: string
          id?: string
          label?: string
          port?: string
          sort_order?: number
          tenant_id?: string
          zone_filter?: string[]
        }
        Relationships: [
          {
            foreignKeyName: "port_routing_rules_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      price_lists: {
        Row: {
          active: boolean
          agency_id: string | null
          created_at: string
          created_by_user_id: string | null
          currency: string
          description: string | null
          id: string
          is_default: boolean
          name: string
          priority: number
          tenant_id: string
          updated_at: string
          valid_from: string | null
          valid_to: string | null
        }
        Insert: {
          active?: boolean
          agency_id?: string | null
          created_at?: string
          created_by_user_id?: string | null
          currency?: string
          description?: string | null
          id?: string
          is_default?: boolean
          name: string
          priority?: number
          tenant_id: string
          updated_at?: string
          valid_from?: string | null
          valid_to?: string | null
        }
        Update: {
          active?: boolean
          agency_id?: string | null
          created_at?: string
          created_by_user_id?: string | null
          currency?: string
          description?: string | null
          id?: string
          is_default?: boolean
          name?: string
          priority?: number
          tenant_id?: string
          updated_at?: string
          valid_from?: string | null
          valid_to?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "price_lists_agency_id_fkey"
            columns: ["agency_id"]
            isOneToOne: false
            referencedRelation: "agencies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "price_lists_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      price_rules: {
        Row: {
          active: boolean
          agency_id: string | null
          agency_price_cents: number | null
          confidence_boost: number
          created_at: string
          days_of_week: number[]
          end_time: string | null
          id: string
          internal_cost_cents: number
          notes: string | null
          pax_max: number
          pax_min: number
          price_list_id: string
          priority: number
          public_price_cents: number
          route_id: string | null
          season_end: string | null
          season_start: string | null
          service_type: Database["public"]["Enums"]["service_type"]
          start_time: string | null
          tenant_id: string
          updated_at: string
          vehicle_label: string | null
        }
        Insert: {
          active?: boolean
          agency_id?: string | null
          agency_price_cents?: number | null
          confidence_boost?: number
          created_at?: string
          days_of_week?: number[]
          end_time?: string | null
          id?: string
          internal_cost_cents: number
          notes?: string | null
          pax_max?: number
          pax_min?: number
          price_list_id: string
          priority?: number
          public_price_cents: number
          route_id?: string | null
          season_end?: string | null
          season_start?: string | null
          service_type?: Database["public"]["Enums"]["service_type"]
          start_time?: string | null
          tenant_id: string
          updated_at?: string
          vehicle_label?: string | null
        }
        Update: {
          active?: boolean
          agency_id?: string | null
          agency_price_cents?: number | null
          confidence_boost?: number
          created_at?: string
          days_of_week?: number[]
          end_time?: string | null
          id?: string
          internal_cost_cents?: number
          notes?: string | null
          pax_max?: number
          pax_min?: number
          price_list_id?: string
          priority?: number
          public_price_cents?: number
          route_id?: string | null
          season_end?: string | null
          season_start?: string | null
          service_type?: Database["public"]["Enums"]["service_type"]
          start_time?: string | null
          tenant_id?: string
          updated_at?: string
          vehicle_label?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "price_rules_agency_id_fkey"
            columns: ["agency_id"]
            isOneToOne: false
            referencedRelation: "agencies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "price_rules_price_list_id_fkey"
            columns: ["price_list_id"]
            isOneToOne: false
            referencedRelation: "price_lists"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "price_rules_route_id_fkey"
            columns: ["route_id"]
            isOneToOne: false
            referencedRelation: "routes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "price_rules_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      pricing_overrides: {
        Row: {
          by_user_id: string
          created_at: string
          id: string
          new_margin_cents: number | null
          new_price_cents: number
          previous_margin_cents: number | null
          previous_price_cents: number | null
          reason: string | null
          rule_id: string | null
          service_id: string
          tenant_id: string
        }
        Insert: {
          by_user_id: string
          created_at?: string
          id?: string
          new_margin_cents?: number | null
          new_price_cents: number
          previous_margin_cents?: number | null
          previous_price_cents?: number | null
          reason?: string | null
          rule_id?: string | null
          service_id: string
          tenant_id: string
        }
        Update: {
          by_user_id?: string
          created_at?: string
          id?: string
          new_margin_cents?: number | null
          new_price_cents?: number
          previous_margin_cents?: number | null
          previous_price_cents?: number | null
          reason?: string | null
          rule_id?: string | null
          service_id?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "pricing_overrides_rule_id_fkey"
            columns: ["rule_id"]
            isOneToOne: false
            referencedRelation: "price_rules"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pricing_overrides_service_id_fkey"
            columns: ["service_id"]
            isOneToOne: false
            referencedRelation: "services"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pricing_overrides_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      pricing_rules: {
        Row: {
          active: boolean
          agency_id: string | null
          agency_price_cents: number | null
          bus_line_code: string | null
          created_at: string
          id: string
          internal_cost_cents: number
          needs_manual_review: boolean
          notes: string
          pax_max: number | null
          pax_min: number
          price_list_id: string
          priority: number
          public_price_cents: number
          route_id: string
          rule_kind: Database["public"]["Enums"]["pricing_rule_kind"]
          season_from: string | null
          season_to: string | null
          tenant_id: string
          time_from: string | null
          time_to: string | null
          updated_at: string
          vehicle_type: string | null
        }
        Insert: {
          active?: boolean
          agency_id?: string | null
          agency_price_cents?: number | null
          bus_line_code?: string | null
          created_at?: string
          id?: string
          internal_cost_cents: number
          needs_manual_review?: boolean
          notes?: string
          pax_max?: number | null
          pax_min?: number
          price_list_id: string
          priority?: number
          public_price_cents: number
          route_id: string
          rule_kind?: Database["public"]["Enums"]["pricing_rule_kind"]
          season_from?: string | null
          season_to?: string | null
          tenant_id: string
          time_from?: string | null
          time_to?: string | null
          updated_at?: string
          vehicle_type?: string | null
        }
        Update: {
          active?: boolean
          agency_id?: string | null
          agency_price_cents?: number | null
          bus_line_code?: string | null
          created_at?: string
          id?: string
          internal_cost_cents?: number
          needs_manual_review?: boolean
          notes?: string
          pax_max?: number | null
          pax_min?: number
          price_list_id?: string
          priority?: number
          public_price_cents?: number
          route_id?: string
          rule_kind?: Database["public"]["Enums"]["pricing_rule_kind"]
          season_from?: string | null
          season_to?: string | null
          tenant_id?: string
          time_from?: string | null
          time_to?: string | null
          updated_at?: string
          vehicle_type?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "pricing_rules_agency_id_fkey"
            columns: ["agency_id"]
            isOneToOne: false
            referencedRelation: "agencies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pricing_rules_price_list_id_fkey"
            columns: ["price_list_id"]
            isOneToOne: false
            referencedRelation: "price_lists"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pricing_rules_route_id_fkey"
            columns: ["route_id"]
            isOneToOne: false
            referencedRelation: "routes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pricing_rules_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      push_notification_log: {
        Row: {
          id: string
          kind: string
          sent_at: string
          service_id: string | null
          tenant_id: string
          user_id: string
        }
        Insert: {
          id?: string
          kind: string
          sent_at?: string
          service_id?: string | null
          tenant_id: string
          user_id: string
        }
        Update: {
          id?: string
          kind?: string
          sent_at?: string
          service_id?: string | null
          tenant_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "push_notification_log_service_id_fkey"
            columns: ["service_id"]
            isOneToOne: false
            referencedRelation: "services"
            referencedColumns: ["id"]
          },
        ]
      }
      push_subscriptions: {
        Row: {
          auth_key: string
          created_at: string
          endpoint: string
          id: string
          p256dh: string
          tenant_id: string
          user_agent: string | null
          user_id: string
        }
        Insert: {
          auth_key: string
          created_at?: string
          endpoint: string
          id?: string
          p256dh: string
          tenant_id: string
          user_agent?: string | null
          user_id: string
        }
        Update: {
          auth_key?: string
          created_at?: string
          endpoint?: string
          id?: string
          p256dh?: string
          tenant_id?: string
          user_agent?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "push_subscriptions_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      quote_waypoints: {
        Row: {
          created_at: string
          id: string
          label: string
          quote_id: string
          sort_order: number
          tenant_id: string
          waypoint_type: string
        }
        Insert: {
          created_at?: string
          id?: string
          label: string
          quote_id: string
          sort_order?: number
          tenant_id: string
          waypoint_type?: string
        }
        Update: {
          created_at?: string
          id?: string
          label?: string
          quote_id?: string
          sort_order?: number
          tenant_id?: string
          waypoint_type?: string
        }
        Relationships: [
          {
            foreignKeyName: "quote_waypoints_quote_id_fkey"
            columns: ["quote_id"]
            isOneToOne: false
            referencedRelation: "quotes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quote_waypoints_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      quotes: {
        Row: {
          arrival_date: string | null
          bus_city_geo_label: string | null
          bus_city_lat: number | null
          bus_city_lng: number | null
          bus_city_origin: string | null
          client_email: string | null
          client_name: string | null
          created_at: string
          created_by_user_id: string | null
          currency: string
          departure_date: string | null
          hotel_name: string | null
          id: string
          notes: string | null
          owner_label: string
          passenger_count: number | null
          price_cents: number
          response_token: string | null
          route_label: string
          service_kind: string
          status: string
          tenant_id: string
          valid_until: string | null
        }
        Insert: {
          arrival_date?: string | null
          bus_city_geo_label?: string | null
          bus_city_lat?: number | null
          bus_city_lng?: number | null
          bus_city_origin?: string | null
          client_email?: string | null
          client_name?: string | null
          created_at?: string
          created_by_user_id?: string | null
          currency?: string
          departure_date?: string | null
          hotel_name?: string | null
          id?: string
          notes?: string | null
          owner_label?: string
          passenger_count?: number | null
          price_cents: number
          response_token?: string | null
          route_label: string
          service_kind: string
          status?: string
          tenant_id: string
          valid_until?: string | null
        }
        Update: {
          arrival_date?: string | null
          bus_city_geo_label?: string | null
          bus_city_lat?: number | null
          bus_city_lng?: number | null
          bus_city_origin?: string | null
          client_email?: string | null
          client_name?: string | null
          created_at?: string
          created_by_user_id?: string | null
          currency?: string
          departure_date?: string | null
          hotel_name?: string | null
          id?: string
          notes?: string | null
          owner_label?: string
          passenger_count?: number | null
          price_cents?: number
          response_token?: string | null
          route_label?: string
          service_kind?: string
          status?: string
          tenant_id?: string
          valid_until?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "quotes_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      role_capability_overrides: {
        Row: {
          capability: string
          created_at: string
          enabled: boolean
          id: string
          role: string
          tenant_id: string
          updated_at: string
        }
        Insert: {
          capability: string
          created_at?: string
          enabled: boolean
          id?: string
          role: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          capability?: string
          created_at?: string
          enabled?: boolean
          id?: string
          role?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "role_capability_overrides_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      routes: {
        Row: {
          active: boolean
          created_at: string
          destination_label: string
          destination_type: Database["public"]["Enums"]["route_point_type"]
          from_label: string
          from_zone: string | null
          id: string
          name: string
          origin_label: string
          origin_type: Database["public"]["Enums"]["route_point_type"]
          service_type: Database["public"]["Enums"]["service_type"]
          tenant_id: string
          to_label: string
          to_zone: string | null
          updated_at: string
          vehicle_hint: string | null
        }
        Insert: {
          active?: boolean
          created_at?: string
          destination_label?: string
          destination_type?: Database["public"]["Enums"]["route_point_type"]
          from_label?: string
          from_zone?: string | null
          id?: string
          name: string
          origin_label?: string
          origin_type?: Database["public"]["Enums"]["route_point_type"]
          service_type?: Database["public"]["Enums"]["service_type"]
          tenant_id: string
          to_label?: string
          to_zone?: string | null
          updated_at?: string
          vehicle_hint?: string | null
        }
        Update: {
          active?: boolean
          created_at?: string
          destination_label?: string
          destination_type?: Database["public"]["Enums"]["route_point_type"]
          from_label?: string
          from_zone?: string | null
          id?: string
          name?: string
          origin_label?: string
          origin_type?: Database["public"]["Enums"]["route_point_type"]
          service_type?: Database["public"]["Enums"]["service_type"]
          tenant_id?: string
          to_label?: string
          to_zone?: string | null
          updated_at?: string
          vehicle_hint?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "routes_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      service_audit_events: {
        Row: {
          actor_email: string | null
          actor_name: string | null
          actor_user_id: string | null
          booking_id: string | null
          created_at: string
          event_type: string
          id: string
          metadata: Json | null
          new_data: Json | null
          old_data: Json | null
          reason: string | null
          service_id: string
          source: string
          tenant_id: string
        }
        Insert: {
          actor_email?: string | null
          actor_name?: string | null
          actor_user_id?: string | null
          booking_id?: string | null
          created_at?: string
          event_type: string
          id?: string
          metadata?: Json | null
          new_data?: Json | null
          old_data?: Json | null
          reason?: string | null
          service_id: string
          source: string
          tenant_id: string
        }
        Update: {
          actor_email?: string | null
          actor_name?: string | null
          actor_user_id?: string | null
          booking_id?: string | null
          created_at?: string
          event_type?: string
          id?: string
          metadata?: Json | null
          new_data?: Json | null
          old_data?: Json | null
          reason?: string | null
          service_id?: string
          source?: string
          tenant_id?: string
        }
        Relationships: []
      }
      service_cancellation_penalties: {
        Row: {
          applied_at: string
          applied_by_name: string | null
          applied_by_role: string | null
          applied_by_user_id: string | null
          base_amount_cents: number | null
          base_amount_source: string | null
          cancellation_request_id: string | null
          created_at: string
          email_attempts: number
          email_kind: string
          email_last_attempt_at: string | null
          email_last_error: string | null
          email_recipient: string | null
          email_sent_at: string | null
          email_status: string
          id: string
          idempotency_key: string
          linked_service_id: string | null
          penalty_amount_cents: number
          penalty_notes: string | null
          penalty_percentage: number | null
          penalty_type: string
          scope: string
          service_id: string
          status: string
          superseded_at: string | null
          superseded_by_id: string | null
          supersedes_ids: string[]
          tenant_id: string
          updated_at: string
          void_email_attempts: number
          void_email_last_attempt_at: string | null
          void_email_last_error: string | null
          void_email_recipient: string | null
          void_email_sent_at: string | null
          void_email_status: string | null
          void_reason: string | null
          voided_at: string | null
          voided_by_name: string | null
          voided_by_user_id: string | null
        }
        Insert: {
          applied_at?: string
          applied_by_name?: string | null
          applied_by_role?: string | null
          applied_by_user_id?: string | null
          base_amount_cents?: number | null
          base_amount_source?: string | null
          cancellation_request_id?: string | null
          created_at?: string
          email_attempts?: number
          email_kind?: string
          email_last_attempt_at?: string | null
          email_last_error?: string | null
          email_recipient?: string | null
          email_sent_at?: string | null
          email_status?: string
          id?: string
          idempotency_key: string
          linked_service_id?: string | null
          penalty_amount_cents?: number
          penalty_notes?: string | null
          penalty_percentage?: number | null
          penalty_type: string
          scope: string
          service_id: string
          status?: string
          superseded_at?: string | null
          superseded_by_id?: string | null
          supersedes_ids?: string[]
          tenant_id: string
          updated_at?: string
          void_email_attempts?: number
          void_email_last_attempt_at?: string | null
          void_email_last_error?: string | null
          void_email_recipient?: string | null
          void_email_sent_at?: string | null
          void_email_status?: string | null
          void_reason?: string | null
          voided_at?: string | null
          voided_by_name?: string | null
          voided_by_user_id?: string | null
        }
        Update: {
          applied_at?: string
          applied_by_name?: string | null
          applied_by_role?: string | null
          applied_by_user_id?: string | null
          base_amount_cents?: number | null
          base_amount_source?: string | null
          cancellation_request_id?: string | null
          created_at?: string
          email_attempts?: number
          email_kind?: string
          email_last_attempt_at?: string | null
          email_last_error?: string | null
          email_recipient?: string | null
          email_sent_at?: string | null
          email_status?: string
          id?: string
          idempotency_key?: string
          linked_service_id?: string | null
          penalty_amount_cents?: number
          penalty_notes?: string | null
          penalty_percentage?: number | null
          penalty_type?: string
          scope?: string
          service_id?: string
          status?: string
          superseded_at?: string | null
          superseded_by_id?: string | null
          supersedes_ids?: string[]
          tenant_id?: string
          updated_at?: string
          void_email_attempts?: number
          void_email_last_attempt_at?: string | null
          void_email_last_error?: string | null
          void_email_recipient?: string | null
          void_email_sent_at?: string | null
          void_email_status?: string | null
          void_reason?: string | null
          voided_at?: string | null
          voided_by_name?: string | null
          voided_by_user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "service_cancellation_penalties_cancellation_request_id_fkey"
            columns: ["cancellation_request_id"]
            isOneToOne: false
            referencedRelation: "cancellation_requests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "service_cancellation_penalties_superseded_by_id_fkey"
            columns: ["superseded_by_id"]
            isOneToOne: false
            referencedRelation: "service_cancellation_penalties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "service_cancellation_penalties_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      service_change_logs: {
        Row: {
          action: string
          after_data: Json
          before_data: Json
          changed_fields: string[]
          created_at: string
          dismissed_at: string | null
          dismissed_by_user_id: string | null
          id: string
          operator_email: string | null
          operator_name: string | null
          operator_user_id: string | null
          root_service_id: string | null
          service_id: string
          tenant_id: string
        }
        Insert: {
          action?: string
          after_data?: Json
          before_data?: Json
          changed_fields?: string[]
          created_at?: string
          dismissed_at?: string | null
          dismissed_by_user_id?: string | null
          id?: string
          operator_email?: string | null
          operator_name?: string | null
          operator_user_id?: string | null
          root_service_id?: string | null
          service_id: string
          tenant_id: string
        }
        Update: {
          action?: string
          after_data?: Json
          before_data?: Json
          changed_fields?: string[]
          created_at?: string
          dismissed_at?: string | null
          dismissed_by_user_id?: string | null
          id?: string
          operator_email?: string | null
          operator_name?: string | null
          operator_user_id?: string | null
          root_service_id?: string | null
          service_id?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "service_change_logs_root_service_id_fkey"
            columns: ["root_service_id"]
            isOneToOne: false
            referencedRelation: "services"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "service_change_logs_service_id_fkey"
            columns: ["service_id"]
            isOneToOne: false
            referencedRelation: "services"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "service_change_logs_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      service_deletion_log: {
        Row: {
          booking_service_kind: string | null
          customer_name: string | null
          deleted_at: string
          deleted_by_name: string | null
          deleted_by_role: string | null
          deleted_by_user_id: string
          deletion_reason: string | null
          hotel_name: string | null
          id: string
          notes: string | null
          original_service_id: string
          pax: number | null
          service_date: string | null
          status: string | null
          tenant_id: string
        }
        Insert: {
          booking_service_kind?: string | null
          customer_name?: string | null
          deleted_at?: string
          deleted_by_name?: string | null
          deleted_by_role?: string | null
          deleted_by_user_id: string
          deletion_reason?: string | null
          hotel_name?: string | null
          id?: string
          notes?: string | null
          original_service_id: string
          pax?: number | null
          service_date?: string | null
          status?: string | null
          tenant_id: string
        }
        Update: {
          booking_service_kind?: string | null
          customer_name?: string | null
          deleted_at?: string
          deleted_by_name?: string | null
          deleted_by_role?: string | null
          deleted_by_user_id?: string
          deletion_reason?: string | null
          hotel_name?: string | null
          id?: string
          notes?: string | null
          original_service_id?: string
          pax?: number | null
          service_date?: string | null
          status?: string | null
          tenant_id?: string
        }
        Relationships: []
      }
      service_pricing: {
        Row: {
          agency_id: string | null
          agency_price_cents: number | null
          apply_mode: Database["public"]["Enums"]["pricing_apply_mode"]
          confidence: number | null
          created_at: string
          created_by_user_id: string | null
          currency: string
          final_price_cents: number
          id: string
          internal_cost_cents: number
          manual_override: boolean
          manual_override_reason: string
          margin_cents: number | null
          price_list_id: string | null
          pricing_rule_id: string | null
          public_price_cents: number
          route_id: string | null
          service_id: string
          snapshot_json: Json
          tenant_id: string
        }
        Insert: {
          agency_id?: string | null
          agency_price_cents?: number | null
          apply_mode?: Database["public"]["Enums"]["pricing_apply_mode"]
          confidence?: number | null
          created_at?: string
          created_by_user_id?: string | null
          currency?: string
          final_price_cents: number
          id?: string
          internal_cost_cents: number
          manual_override?: boolean
          manual_override_reason?: string
          margin_cents?: number | null
          price_list_id?: string | null
          pricing_rule_id?: string | null
          public_price_cents: number
          route_id?: string | null
          service_id: string
          snapshot_json?: Json
          tenant_id: string
        }
        Update: {
          agency_id?: string | null
          agency_price_cents?: number | null
          apply_mode?: Database["public"]["Enums"]["pricing_apply_mode"]
          confidence?: number | null
          created_at?: string
          created_by_user_id?: string | null
          currency?: string
          final_price_cents?: number
          id?: string
          internal_cost_cents?: number
          manual_override?: boolean
          manual_override_reason?: string
          margin_cents?: number | null
          price_list_id?: string | null
          pricing_rule_id?: string | null
          public_price_cents?: number
          route_id?: string | null
          service_id?: string
          snapshot_json?: Json
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "service_pricing_agency_id_fkey"
            columns: ["agency_id"]
            isOneToOne: false
            referencedRelation: "agencies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "service_pricing_price_list_id_fkey"
            columns: ["price_list_id"]
            isOneToOne: false
            referencedRelation: "price_lists"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "service_pricing_pricing_rule_id_fkey"
            columns: ["pricing_rule_id"]
            isOneToOne: false
            referencedRelation: "pricing_rules"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "service_pricing_route_id_fkey"
            columns: ["route_id"]
            isOneToOne: false
            referencedRelation: "routes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "service_pricing_service_id_fkey"
            columns: ["service_id"]
            isOneToOne: false
            referencedRelation: "services"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "service_pricing_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      service_quote_items: {
        Row: {
          arrival_date: string | null
          arrival_flight_train: string | null
          arrival_time: string | null
          created_at: string
          departure_date: string | null
          departure_flight_train: string | null
          departure_time: string | null
          description: string | null
          direction: string | null
          hotel_address: string | null
          hotel_name: string | null
          id: string
          item_type: string
          luggage_notes: string | null
          pax: number
          price_mode: string
          price_notes: string | null
          quantity: number
          quote_id: string
          service_type: string | null
          sort_order: number
          special_requests: string | null
          tenant_id: string
          title: string | null
          total_price_cents: number
          unit_price_cents: number
          updated_at: string
        }
        Insert: {
          arrival_date?: string | null
          arrival_flight_train?: string | null
          arrival_time?: string | null
          created_at?: string
          departure_date?: string | null
          departure_flight_train?: string | null
          departure_time?: string | null
          description?: string | null
          direction?: string | null
          hotel_address?: string | null
          hotel_name?: string | null
          id?: string
          item_type?: string
          luggage_notes?: string | null
          pax?: number
          price_mode?: string
          price_notes?: string | null
          quantity?: number
          quote_id: string
          service_type?: string | null
          sort_order?: number
          special_requests?: string | null
          tenant_id: string
          title?: string | null
          total_price_cents?: number
          unit_price_cents?: number
          updated_at?: string
        }
        Update: {
          arrival_date?: string | null
          arrival_flight_train?: string | null
          arrival_time?: string | null
          created_at?: string
          departure_date?: string | null
          departure_flight_train?: string | null
          departure_time?: string | null
          description?: string | null
          direction?: string | null
          hotel_address?: string | null
          hotel_name?: string | null
          id?: string
          item_type?: string
          luggage_notes?: string | null
          pax?: number
          price_mode?: string
          price_notes?: string | null
          quantity?: number
          quote_id?: string
          service_type?: string | null
          sort_order?: number
          special_requests?: string | null
          tenant_id?: string
          title?: string | null
          total_price_cents?: number
          unit_price_cents?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "service_quote_items_quote_id_fkey"
            columns: ["quote_id"]
            isOneToOne: false
            referencedRelation: "service_quotes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "service_quote_items_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      service_quotes: {
        Row: {
          accept_token: string
          accept_token_expires_at: string | null
          accepted_at: string | null
          accepted_ip: string | null
          arrival_date: string | null
          arrival_flight_train: string | null
          arrival_time: string | null
          bank_account_holder: string | null
          cancelled_at: string | null
          confirmed_at: string | null
          created_at: string
          created_by: string | null
          currency: string
          customer_email: string
          customer_first_name: string
          customer_language: string
          customer_last_name: string
          customer_phone: string | null
          departure_date: string | null
          departure_flight_train: string | null
          departure_time: string | null
          direction: string | null
          email_intro: string | null
          end_customer_name: string | null
          expires_at: string | null
          hotel_address: string | null
          hotel_name: string | null
          iban: string | null
          id: string
          is_agency: boolean
          luggage_notes: string | null
          notes_internal: string | null
          offer_sent_at: string | null
          paid_at: string | null
          pax: number
          payment_instructions: string | null
          payment_method: string | null
          payment_reference: string | null
          price_cents: number
          price_mode: string
          price_notes: string | null
          quote_number: string
          service_id: string | null
          service_type: string
          special_requests: string | null
          status: string
          swift_code: string | null
          tenant_id: string
          updated_at: string
        }
        Insert: {
          accept_token?: string
          accept_token_expires_at?: string | null
          accepted_at?: string | null
          accepted_ip?: string | null
          arrival_date?: string | null
          arrival_flight_train?: string | null
          arrival_time?: string | null
          bank_account_holder?: string | null
          cancelled_at?: string | null
          confirmed_at?: string | null
          created_at?: string
          created_by?: string | null
          currency?: string
          customer_email: string
          customer_first_name: string
          customer_language?: string
          customer_last_name: string
          customer_phone?: string | null
          departure_date?: string | null
          departure_flight_train?: string | null
          departure_time?: string | null
          direction?: string | null
          email_intro?: string | null
          end_customer_name?: string | null
          expires_at?: string | null
          hotel_address?: string | null
          hotel_name?: string | null
          iban?: string | null
          id?: string
          is_agency?: boolean
          luggage_notes?: string | null
          notes_internal?: string | null
          offer_sent_at?: string | null
          paid_at?: string | null
          pax?: number
          payment_instructions?: string | null
          payment_method?: string | null
          payment_reference?: string | null
          price_cents: number
          price_mode?: string
          price_notes?: string | null
          quote_number: string
          service_id?: string | null
          service_type: string
          special_requests?: string | null
          status?: string
          swift_code?: string | null
          tenant_id: string
          updated_at?: string
        }
        Update: {
          accept_token?: string
          accept_token_expires_at?: string | null
          accepted_at?: string | null
          accepted_ip?: string | null
          arrival_date?: string | null
          arrival_flight_train?: string | null
          arrival_time?: string | null
          bank_account_holder?: string | null
          cancelled_at?: string | null
          confirmed_at?: string | null
          created_at?: string
          created_by?: string | null
          currency?: string
          customer_email?: string
          customer_first_name?: string
          customer_language?: string
          customer_last_name?: string
          customer_phone?: string | null
          departure_date?: string | null
          departure_flight_train?: string | null
          departure_time?: string | null
          direction?: string | null
          email_intro?: string | null
          end_customer_name?: string | null
          expires_at?: string | null
          hotel_address?: string | null
          hotel_name?: string | null
          iban?: string | null
          id?: string
          is_agency?: boolean
          luggage_notes?: string | null
          notes_internal?: string | null
          offer_sent_at?: string | null
          paid_at?: string | null
          pax?: number
          payment_instructions?: string | null
          payment_method?: string | null
          payment_reference?: string | null
          price_cents?: number
          price_mode?: string
          price_notes?: string | null
          quote_number?: string
          service_id?: string | null
          service_type?: string
          special_requests?: string | null
          status?: string
          swift_code?: string | null
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "service_quotes_service_id_fkey"
            columns: ["service_id"]
            isOneToOne: false
            referencedRelation: "services"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "service_quotes_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      service_scan_log: {
        Row: {
          action: string
          id: string
          scanned_at: string
          scanned_by_user_id: string | null
          service_id: string
          tenant_id: string
        }
        Insert: {
          action: string
          id?: string
          scanned_at?: string
          scanned_by_user_id?: string | null
          service_id: string
          tenant_id: string
        }
        Update: {
          action?: string
          id?: string
          scanned_at?: string
          scanned_by_user_id?: string | null
          service_id?: string
          tenant_id?: string
        }
        Relationships: []
      }
      services: {
        Row: {
          agency_booking_id: string | null
          agency_id: string | null
          agency_paid_at: string | null
          agency_payment_status: string
          agency_price_cents: number | null
          agency_quoted_price_cents: number | null
          applied_price_list_id: string | null
          applied_pricing_rule_id: string | null
          approval_notes: string | null
          approval_price_cents: number | null
          approval_resolved_at: string | null
          approval_status: string | null
          arrival_date: string | null
          arrival_time: string | null
          barca_compagnia: string | null
          billing_party_name: string | null
          booking_group_id: string | null
          booking_group_stop_id: string | null
          booking_service_kind: string | null
          bus_capacity: number | null
          bus_city_origin: string | null
          bus_plate: string | null
          capacity: number | null
          continent_dispatch_override_reason: string | null
          continent_dispatch_source: string | null
          continent_dispatch_target: string | null
          continent_dispatch_updated_at: string | null
          continent_dispatch_updated_by: string | null
          continent_dispatch_vendor: string | null
          created_at: string
          created_by_user_id: string | null
          customer_email: string | null
          customer_first_name: string | null
          customer_last_name: string | null
          customer_name: string
          date: string
          departure_date: string | null
          departure_time: string | null
          destination_label_raw: string | null
          destination_place_id: string | null
          destination_place_type: string | null
          direction: Database["public"]["Enums"]["service_direction"]
          email_confirmation_error: string | null
          email_confirmation_sent_at: string | null
          email_confirmation_status: string | null
          email_confirmation_to: string | null
          excursion_details: Json
          excursion_name: string | null
          ferry_details: Json
          final_price_cents: number | null
          geo_confidence: number | null
          geo_status: string
          guide_name: string | null
          hotel_id: string | null
          id: string
          import_id: string | null
          inbound_booking_item_id: string | null
          inbound_email_id: string | null
          include_ferry_tickets: boolean
          internal_cost_cents: number | null
          internal_notes: string | null
          internal_notes_updated_at: string | null
          internal_notes_updated_by: string | null
          is_draft: boolean
          is_test_data: boolean
          legacy_import_fingerprint: string | null
          linked_service_id: string | null
          low_seat_threshold: number | null
          margin_cents: number | null
          match_status: Database["public"]["Enums"]["match_status"] | null
          medmar_ticket_sent_at: string | null
          medmar_ticket_sent_by: string | null
          meeting_point: string | null
          minimum_passengers: number | null
          notes: string
          orario_barca: string | null
          origin_label_raw: string | null
          origin_place_id: string | null
          origin_place_type: string | null
          outbound_time: string | null
          pax: number
          phone: string
          pickup_alert: string | null
          pickup_hotel: string | null
          pickup_time: string | null
          place_type: string
          porto_bruno: string | null
          practice_number: string | null
          price_list_id: string | null
          pricing_applied_at: string | null
          pricing_apply_mode:
            | Database["public"]["Enums"]["pricing_apply_mode"]
            | null
          pricing_confidence: string | null
          pricing_currency: string
          pricing_explanation: string | null
          pricing_manual_override: boolean
          pricing_manual_override_reason: string
          pricing_match_confidence: number | null
          pricing_matched_at: string | null
          pricing_rule_id: string | null
          pricing_source: string | null
          public_price_cents: number | null
          return_time: string | null
          route_id: string | null
          route_kind: string | null
          service_category: string | null
          service_type: Database["public"]["Enums"]["service_type"]
          service_type_code: string | null
          share_expires_at: string | null
          share_token: string | null
          source_amount_currency: string | null
          source_price_per_pax_cents: number | null
          source_quote_id: string | null
          source_quote_leg: string | null
          source_total_amount_cents: number | null
          status: Database["public"]["Enums"]["service_status"]
          tenant_id: string
          time: string
          time_from: string | null
          time_to: string | null
          tour_name: string | null
          train_arrival_number: string | null
          train_arrival_time: string | null
          train_departure_number: string | null
          train_departure_time: string | null
          transport_code: string | null
          vessel: string
          waitlist_count: number
          waitlist_enabled: boolean
        }
        Insert: {
          agency_booking_id?: string | null
          agency_id?: string | null
          agency_paid_at?: string | null
          agency_payment_status?: string
          agency_price_cents?: number | null
          agency_quoted_price_cents?: number | null
          applied_price_list_id?: string | null
          applied_pricing_rule_id?: string | null
          approval_notes?: string | null
          approval_price_cents?: number | null
          approval_resolved_at?: string | null
          approval_status?: string | null
          arrival_date?: string | null
          arrival_time?: string | null
          barca_compagnia?: string | null
          billing_party_name?: string | null
          booking_group_id?: string | null
          booking_group_stop_id?: string | null
          booking_service_kind?: string | null
          bus_capacity?: number | null
          bus_city_origin?: string | null
          bus_plate?: string | null
          capacity?: number | null
          continent_dispatch_override_reason?: string | null
          continent_dispatch_source?: string | null
          continent_dispatch_target?: string | null
          continent_dispatch_updated_at?: string | null
          continent_dispatch_updated_by?: string | null
          continent_dispatch_vendor?: string | null
          created_at?: string
          created_by_user_id?: string | null
          customer_email?: string | null
          customer_first_name?: string | null
          customer_last_name?: string | null
          customer_name: string
          date: string
          departure_date?: string | null
          departure_time?: string | null
          destination_label_raw?: string | null
          destination_place_id?: string | null
          destination_place_type?: string | null
          direction: Database["public"]["Enums"]["service_direction"]
          email_confirmation_error?: string | null
          email_confirmation_sent_at?: string | null
          email_confirmation_status?: string | null
          email_confirmation_to?: string | null
          excursion_details?: Json
          excursion_name?: string | null
          ferry_details?: Json
          final_price_cents?: number | null
          geo_confidence?: number | null
          geo_status?: string
          guide_name?: string | null
          hotel_id?: string | null
          id?: string
          import_id?: string | null
          inbound_booking_item_id?: string | null
          inbound_email_id?: string | null
          include_ferry_tickets?: boolean
          internal_cost_cents?: number | null
          internal_notes?: string | null
          internal_notes_updated_at?: string | null
          internal_notes_updated_by?: string | null
          is_draft?: boolean
          is_test_data?: boolean
          legacy_import_fingerprint?: string | null
          linked_service_id?: string | null
          low_seat_threshold?: number | null
          margin_cents?: number | null
          match_status?: Database["public"]["Enums"]["match_status"] | null
          medmar_ticket_sent_at?: string | null
          medmar_ticket_sent_by?: string | null
          meeting_point?: string | null
          minimum_passengers?: number | null
          notes?: string
          orario_barca?: string | null
          origin_label_raw?: string | null
          origin_place_id?: string | null
          origin_place_type?: string | null
          outbound_time?: string | null
          pax: number
          phone: string
          pickup_alert?: string | null
          pickup_hotel?: string | null
          pickup_time?: string | null
          place_type?: string
          porto_bruno?: string | null
          practice_number?: string | null
          price_list_id?: string | null
          pricing_applied_at?: string | null
          pricing_apply_mode?:
            | Database["public"]["Enums"]["pricing_apply_mode"]
            | null
          pricing_confidence?: string | null
          pricing_currency?: string
          pricing_explanation?: string | null
          pricing_manual_override?: boolean
          pricing_manual_override_reason?: string
          pricing_match_confidence?: number | null
          pricing_matched_at?: string | null
          pricing_rule_id?: string | null
          pricing_source?: string | null
          public_price_cents?: number | null
          return_time?: string | null
          route_id?: string | null
          route_kind?: string | null
          service_category?: string | null
          service_type?: Database["public"]["Enums"]["service_type"]
          service_type_code?: string | null
          share_expires_at?: string | null
          share_token?: string | null
          source_amount_currency?: string | null
          source_price_per_pax_cents?: number | null
          source_quote_id?: string | null
          source_quote_leg?: string | null
          source_total_amount_cents?: number | null
          status?: Database["public"]["Enums"]["service_status"]
          tenant_id: string
          time: string
          time_from?: string | null
          time_to?: string | null
          tour_name?: string | null
          train_arrival_number?: string | null
          train_arrival_time?: string | null
          train_departure_number?: string | null
          train_departure_time?: string | null
          transport_code?: string | null
          vessel: string
          waitlist_count?: number
          waitlist_enabled?: boolean
        }
        Update: {
          agency_booking_id?: string | null
          agency_id?: string | null
          agency_paid_at?: string | null
          agency_payment_status?: string
          agency_price_cents?: number | null
          agency_quoted_price_cents?: number | null
          applied_price_list_id?: string | null
          applied_pricing_rule_id?: string | null
          approval_notes?: string | null
          approval_price_cents?: number | null
          approval_resolved_at?: string | null
          approval_status?: string | null
          arrival_date?: string | null
          arrival_time?: string | null
          barca_compagnia?: string | null
          billing_party_name?: string | null
          booking_group_id?: string | null
          booking_group_stop_id?: string | null
          booking_service_kind?: string | null
          bus_capacity?: number | null
          bus_city_origin?: string | null
          bus_plate?: string | null
          capacity?: number | null
          continent_dispatch_override_reason?: string | null
          continent_dispatch_source?: string | null
          continent_dispatch_target?: string | null
          continent_dispatch_updated_at?: string | null
          continent_dispatch_updated_by?: string | null
          continent_dispatch_vendor?: string | null
          created_at?: string
          created_by_user_id?: string | null
          customer_email?: string | null
          customer_first_name?: string | null
          customer_last_name?: string | null
          customer_name?: string
          date?: string
          departure_date?: string | null
          departure_time?: string | null
          destination_label_raw?: string | null
          destination_place_id?: string | null
          destination_place_type?: string | null
          direction?: Database["public"]["Enums"]["service_direction"]
          email_confirmation_error?: string | null
          email_confirmation_sent_at?: string | null
          email_confirmation_status?: string | null
          email_confirmation_to?: string | null
          excursion_details?: Json
          excursion_name?: string | null
          ferry_details?: Json
          final_price_cents?: number | null
          geo_confidence?: number | null
          geo_status?: string
          guide_name?: string | null
          hotel_id?: string | null
          id?: string
          import_id?: string | null
          inbound_booking_item_id?: string | null
          inbound_email_id?: string | null
          include_ferry_tickets?: boolean
          internal_cost_cents?: number | null
          internal_notes?: string | null
          internal_notes_updated_at?: string | null
          internal_notes_updated_by?: string | null
          is_draft?: boolean
          is_test_data?: boolean
          legacy_import_fingerprint?: string | null
          linked_service_id?: string | null
          low_seat_threshold?: number | null
          margin_cents?: number | null
          match_status?: Database["public"]["Enums"]["match_status"] | null
          medmar_ticket_sent_at?: string | null
          medmar_ticket_sent_by?: string | null
          meeting_point?: string | null
          minimum_passengers?: number | null
          notes?: string
          orario_barca?: string | null
          origin_label_raw?: string | null
          origin_place_id?: string | null
          origin_place_type?: string | null
          outbound_time?: string | null
          pax?: number
          phone?: string
          pickup_alert?: string | null
          pickup_hotel?: string | null
          pickup_time?: string | null
          place_type?: string
          porto_bruno?: string | null
          practice_number?: string | null
          price_list_id?: string | null
          pricing_applied_at?: string | null
          pricing_apply_mode?:
            | Database["public"]["Enums"]["pricing_apply_mode"]
            | null
          pricing_confidence?: string | null
          pricing_currency?: string
          pricing_explanation?: string | null
          pricing_manual_override?: boolean
          pricing_manual_override_reason?: string
          pricing_match_confidence?: number | null
          pricing_matched_at?: string | null
          pricing_rule_id?: string | null
          pricing_source?: string | null
          public_price_cents?: number | null
          return_time?: string | null
          route_id?: string | null
          route_kind?: string | null
          service_category?: string | null
          service_type?: Database["public"]["Enums"]["service_type"]
          service_type_code?: string | null
          share_expires_at?: string | null
          share_token?: string | null
          source_amount_currency?: string | null
          source_price_per_pax_cents?: number | null
          source_quote_id?: string | null
          source_quote_leg?: string | null
          source_total_amount_cents?: number | null
          status?: Database["public"]["Enums"]["service_status"]
          tenant_id?: string
          time?: string
          time_from?: string | null
          time_to?: string | null
          tour_name?: string | null
          train_arrival_number?: string | null
          train_arrival_time?: string | null
          train_departure_number?: string | null
          train_departure_time?: string | null
          transport_code?: string | null
          vessel?: string
          waitlist_count?: number
          waitlist_enabled?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "services_agency_booking_id_fkey"
            columns: ["agency_booking_id"]
            isOneToOne: false
            referencedRelation: "agency_bookings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "services_agency_id_fkey"
            columns: ["agency_id"]
            isOneToOne: false
            referencedRelation: "agencies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "services_applied_price_list_id_fkey"
            columns: ["applied_price_list_id"]
            isOneToOne: false
            referencedRelation: "price_lists"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "services_applied_pricing_rule_id_fkey"
            columns: ["applied_pricing_rule_id"]
            isOneToOne: false
            referencedRelation: "pricing_rules"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "services_booking_group_id_fkey"
            columns: ["booking_group_id"]
            isOneToOne: false
            referencedRelation: "booking_groups"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "services_booking_group_stop_id_fkey"
            columns: ["booking_group_stop_id"]
            isOneToOne: false
            referencedRelation: "booking_group_stops"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "services_destination_place_id_fkey"
            columns: ["destination_place_id"]
            isOneToOne: false
            referencedRelation: "places"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "services_hotel_id_fkey"
            columns: ["hotel_id"]
            isOneToOne: false
            referencedRelation: "hotels"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "services_import_id_fkey"
            columns: ["import_id"]
            isOneToOne: false
            referencedRelation: "inbound_booking_imports"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "services_inbound_booking_item_id_fkey"
            columns: ["inbound_booking_item_id"]
            isOneToOne: false
            referencedRelation: "inbound_booking_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "services_inbound_email_id_fkey"
            columns: ["inbound_email_id"]
            isOneToOne: false
            referencedRelation: "inbound_emails"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "services_linked_service_id_fkey"
            columns: ["linked_service_id"]
            isOneToOne: false
            referencedRelation: "services"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "services_origin_place_id_fkey"
            columns: ["origin_place_id"]
            isOneToOne: false
            referencedRelation: "places"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "services_price_list_id_fkey"
            columns: ["price_list_id"]
            isOneToOne: false
            referencedRelation: "price_lists"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "services_pricing_rule_id_fkey"
            columns: ["pricing_rule_id"]
            isOneToOne: false
            referencedRelation: "price_rules"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "services_route_id_fkey"
            columns: ["route_id"]
            isOneToOne: false
            referencedRelation: "routes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "services_source_quote_id_fkey"
            columns: ["source_quote_id"]
            isOneToOne: false
            referencedRelation: "quotes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "services_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      services_ischia: {
        Row: {
          created_at: string
          customer_name: string
          customer_phone: string | null
          driver_id: string | null
          hotel_arrivo_id: string | null
          hotel_arrivo_name: string
          hotel_partenza_id: string | null
          hotel_partenza_name: string
          id: string
          notes: string | null
          orario: string | null
          pax: number
          status: string
          tenant_id: string
          travel_date: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          customer_name: string
          customer_phone?: string | null
          driver_id?: string | null
          hotel_arrivo_id?: string | null
          hotel_arrivo_name: string
          hotel_partenza_id?: string | null
          hotel_partenza_name: string
          id?: string
          notes?: string | null
          orario?: string | null
          pax?: number
          status?: string
          tenant_id: string
          travel_date: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          customer_name?: string
          customer_phone?: string | null
          driver_id?: string | null
          hotel_arrivo_id?: string | null
          hotel_arrivo_name?: string
          hotel_partenza_id?: string | null
          hotel_partenza_name?: string
          id?: string
          notes?: string | null
          orario?: string | null
          pax?: number
          status?: string
          tenant_id?: string
          travel_date?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "services_ischia_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "drivers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "services_ischia_hotel_arrivo_id_fkey"
            columns: ["hotel_arrivo_id"]
            isOneToOne: false
            referencedRelation: "hotels"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "services_ischia_hotel_partenza_id_fkey"
            columns: ["hotel_partenza_id"]
            isOneToOne: false
            referencedRelation: "hotels"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "services_ischia_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      snav_convocation_batches: {
        Row: {
          created_at: string
          created_by: string
          error_count: number
          file_name: string
          id: string
          label: string
          sent_count: number
          skipped_count: number
          status: string
          tenant_id: string
          total_rows: number
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by: string
          error_count?: number
          file_name?: string
          id?: string
          label?: string
          sent_count?: number
          skipped_count?: number
          status?: string
          tenant_id: string
          total_rows?: number
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string
          error_count?: number
          file_name?: string
          id?: string
          label?: string
          sent_count?: number
          skipped_count?: number
          status?: string
          tenant_id?: string
          total_rows?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "snav_convocation_batches_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      snav_convocation_rows: {
        Row: {
          batch_id: string
          created_at: string
          customer_name: string
          departure_date: string | null
          departure_date_label: string
          error_message: string | null
          generated_message: string
          hotel: string
          id: string
          inviare: boolean
          passengers: string
          phone_e164: string | null
          phone_raw: string
          pickup_time: string
          provider_message_id: string | null
          row_index: number
          sent_at: string | null
          service_id: string | null
          status: string
          template_payload: Json
          tenant_id: string
          updated_at: string
          vessel_time: string
        }
        Insert: {
          batch_id: string
          created_at?: string
          customer_name?: string
          departure_date?: string | null
          departure_date_label?: string
          error_message?: string | null
          generated_message?: string
          hotel?: string
          id?: string
          inviare?: boolean
          passengers?: string
          phone_e164?: string | null
          phone_raw?: string
          pickup_time?: string
          provider_message_id?: string | null
          row_index: number
          sent_at?: string | null
          service_id?: string | null
          status?: string
          template_payload?: Json
          tenant_id: string
          updated_at?: string
          vessel_time?: string
        }
        Update: {
          batch_id?: string
          created_at?: string
          customer_name?: string
          departure_date?: string | null
          departure_date_label?: string
          error_message?: string | null
          generated_message?: string
          hotel?: string
          id?: string
          inviare?: boolean
          passengers?: string
          phone_e164?: string | null
          phone_raw?: string
          pickup_time?: string
          provider_message_id?: string | null
          row_index?: number
          sent_at?: string | null
          service_id?: string | null
          status?: string
          template_payload?: Json
          tenant_id?: string
          updated_at?: string
          vessel_time?: string
        }
        Relationships: [
          {
            foreignKeyName: "snav_convocation_rows_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "snav_convocation_batches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "snav_convocation_rows_service_id_fkey"
            columns: ["service_id"]
            isOneToOne: false
            referencedRelation: "services"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "snav_convocation_rows_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      snav_convocation_send_logs: {
        Row: {
          api_response_json: Json | null
          attempt_number: number
          attempted_at: string
          batch_id: string
          error_message: string | null
          id: string
          language_code: string
          operator_user_id: string
          phone_e164: string
          provider_message_id: string | null
          row_id: string
          status: string
          template_name: string
          tenant_id: string
          variables_json: Json
        }
        Insert: {
          api_response_json?: Json | null
          attempt_number?: number
          attempted_at?: string
          batch_id: string
          error_message?: string | null
          id?: string
          language_code?: string
          operator_user_id: string
          phone_e164: string
          provider_message_id?: string | null
          row_id: string
          status: string
          template_name: string
          tenant_id: string
          variables_json?: Json
        }
        Update: {
          api_response_json?: Json | null
          attempt_number?: number
          attempted_at?: string
          batch_id?: string
          error_message?: string | null
          id?: string
          language_code?: string
          operator_user_id?: string
          phone_e164?: string
          provider_message_id?: string | null
          row_id?: string
          status?: string
          template_name?: string
          tenant_id?: string
          variables_json?: Json
        }
        Relationships: [
          {
            foreignKeyName: "snav_convocation_send_logs_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "snav_convocation_batches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "snav_convocation_send_logs_row_id_fkey"
            columns: ["row_id"]
            isOneToOne: false
            referencedRelation: "snav_convocation_rows"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "snav_convocation_send_logs_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      status_events: {
        Row: {
          at: string
          by_user_id: string | null
          gps_lat: number | null
          gps_lng: number | null
          id: string
          notes: string | null
          service_id: string
          status: Database["public"]["Enums"]["service_status"]
          tenant_id: string
        }
        Insert: {
          at?: string
          by_user_id?: string | null
          gps_lat?: number | null
          gps_lng?: number | null
          id?: string
          notes?: string | null
          service_id: string
          status: Database["public"]["Enums"]["service_status"]
          tenant_id: string
        }
        Update: {
          at?: string
          by_user_id?: string | null
          gps_lat?: number | null
          gps_lng?: number | null
          id?: string
          notes?: string | null
          service_id?: string
          status?: Database["public"]["Enums"]["service_status"]
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "status_events_service_id_fkey"
            columns: ["service_id"]
            isOneToOne: false
            referencedRelation: "services"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "status_events_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      system_job_runs: {
        Row: {
          created_at: string
          error_message: string | null
          failed_count: number
          finished_at: string | null
          id: string
          job_key: string
          job_name: string
          metadata: Json
          processed_count: number
          run_id: string | null
          source: string
          started_at: string
          status: string
          success_count: number
          tenant_id: string | null
          warning_count: number
        }
        Insert: {
          created_at?: string
          error_message?: string | null
          failed_count?: number
          finished_at?: string | null
          id?: string
          job_key: string
          job_name: string
          metadata?: Json
          processed_count?: number
          run_id?: string | null
          source: string
          started_at?: string
          status?: string
          success_count?: number
          tenant_id?: string | null
          warning_count?: number
        }
        Update: {
          created_at?: string
          error_message?: string | null
          failed_count?: number
          finished_at?: string | null
          id?: string
          job_key?: string
          job_name?: string
          metadata?: Json
          processed_count?: number
          run_id?: string | null
          source?: string
          started_at?: string
          status?: string
          success_count?: number
          tenant_id?: string | null
          warning_count?: number
        }
        Relationships: [
          {
            foreignKeyName: "system_job_runs_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      tenant_access_requests: {
        Row: {
          agency_name: string | null
          created_at: string
          email: string
          full_name: string
          id: string
          requested_role: Database["public"]["Enums"]["app_role"] | null
          review_notes: string | null
          reviewed_at: string | null
          reviewed_by_user_id: string | null
          status: string
          tenant_id: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          agency_name?: string | null
          created_at?: string
          email: string
          full_name: string
          id?: string
          requested_role?: Database["public"]["Enums"]["app_role"] | null
          review_notes?: string | null
          reviewed_at?: string | null
          reviewed_by_user_id?: string | null
          status?: string
          tenant_id?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          agency_name?: string | null
          created_at?: string
          email?: string
          full_name?: string
          id?: string
          requested_role?: Database["public"]["Enums"]["app_role"] | null
          review_notes?: string | null
          reviewed_at?: string | null
          reviewed_by_user_id?: string | null
          status?: string
          tenant_id?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "tenant_access_requests_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      tenant_bus_allocation_moves: {
        Row: {
          allocation_id: string | null
          allocation_snapshot_pax: number | null
          created_at: string
          created_by_user_id: string | null
          customer_name: string | null
          customer_phone: string | null
          from_bus_unit_id: string | null
          hotel_name: string | null
          id: string
          moved_full_allocation: boolean
          pax_moved: number
          reason: string | null
          root_allocation_id: string | null
          service_id: string
          source_bus_label: string | null
          stop_name: string | null
          target_allocation_id: string | null
          target_bus_label: string | null
          tenant_id: string
          to_bus_unit_id: string | null
        }
        Insert: {
          allocation_id?: string | null
          allocation_snapshot_pax?: number | null
          created_at?: string
          created_by_user_id?: string | null
          customer_name?: string | null
          customer_phone?: string | null
          from_bus_unit_id?: string | null
          hotel_name?: string | null
          id?: string
          moved_full_allocation?: boolean
          pax_moved: number
          reason?: string | null
          root_allocation_id?: string | null
          service_id: string
          source_bus_label?: string | null
          stop_name?: string | null
          target_allocation_id?: string | null
          target_bus_label?: string | null
          tenant_id: string
          to_bus_unit_id?: string | null
        }
        Update: {
          allocation_id?: string | null
          allocation_snapshot_pax?: number | null
          created_at?: string
          created_by_user_id?: string | null
          customer_name?: string | null
          customer_phone?: string | null
          from_bus_unit_id?: string | null
          hotel_name?: string | null
          id?: string
          moved_full_allocation?: boolean
          pax_moved?: number
          reason?: string | null
          root_allocation_id?: string | null
          service_id?: string
          source_bus_label?: string | null
          stop_name?: string | null
          target_allocation_id?: string | null
          target_bus_label?: string | null
          tenant_id?: string
          to_bus_unit_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "tenant_bus_allocation_moves_allocation_id_fkey"
            columns: ["allocation_id"]
            isOneToOne: false
            referencedRelation: "ops_bus_allocation_details"
            referencedColumns: ["allocation_id"]
          },
          {
            foreignKeyName: "tenant_bus_allocation_moves_allocation_id_fkey"
            columns: ["allocation_id"]
            isOneToOne: false
            referencedRelation: "tenant_bus_allocations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tenant_bus_allocation_moves_from_bus_unit_id_fkey"
            columns: ["from_bus_unit_id"]
            isOneToOne: false
            referencedRelation: "tenant_bus_units"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tenant_bus_allocation_moves_root_allocation_id_fkey"
            columns: ["root_allocation_id"]
            isOneToOne: false
            referencedRelation: "ops_bus_allocation_details"
            referencedColumns: ["allocation_id"]
          },
          {
            foreignKeyName: "tenant_bus_allocation_moves_root_allocation_id_fkey"
            columns: ["root_allocation_id"]
            isOneToOne: false
            referencedRelation: "tenant_bus_allocations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tenant_bus_allocation_moves_service_id_fkey"
            columns: ["service_id"]
            isOneToOne: false
            referencedRelation: "services"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tenant_bus_allocation_moves_target_allocation_id_fkey"
            columns: ["target_allocation_id"]
            isOneToOne: false
            referencedRelation: "ops_bus_allocation_details"
            referencedColumns: ["allocation_id"]
          },
          {
            foreignKeyName: "tenant_bus_allocation_moves_target_allocation_id_fkey"
            columns: ["target_allocation_id"]
            isOneToOne: false
            referencedRelation: "tenant_bus_allocations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tenant_bus_allocation_moves_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tenant_bus_allocation_moves_to_bus_unit_id_fkey"
            columns: ["to_bus_unit_id"]
            isOneToOne: false
            referencedRelation: "tenant_bus_units"
            referencedColumns: ["id"]
          },
        ]
      }
      tenant_bus_allocations: {
        Row: {
          bus_line_id: string
          bus_unit_id: string
          created_at: string
          created_by_user_id: string | null
          direction: Database["public"]["Enums"]["service_direction"]
          id: string
          notes: string | null
          pax_assigned: number
          root_allocation_id: string | null
          service_id: string
          split_from_allocation_id: string | null
          stop_id: string | null
          stop_name: string
          tenant_id: string
        }
        Insert: {
          bus_line_id: string
          bus_unit_id: string
          created_at?: string
          created_by_user_id?: string | null
          direction: Database["public"]["Enums"]["service_direction"]
          id?: string
          notes?: string | null
          pax_assigned: number
          root_allocation_id?: string | null
          service_id: string
          split_from_allocation_id?: string | null
          stop_id?: string | null
          stop_name: string
          tenant_id: string
        }
        Update: {
          bus_line_id?: string
          bus_unit_id?: string
          created_at?: string
          created_by_user_id?: string | null
          direction?: Database["public"]["Enums"]["service_direction"]
          id?: string
          notes?: string | null
          pax_assigned?: number
          root_allocation_id?: string | null
          service_id?: string
          split_from_allocation_id?: string | null
          stop_id?: string | null
          stop_name?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "tenant_bus_allocations_bus_line_id_fkey"
            columns: ["bus_line_id"]
            isOneToOne: false
            referencedRelation: "tenant_bus_lines"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tenant_bus_allocations_bus_unit_id_fkey"
            columns: ["bus_unit_id"]
            isOneToOne: false
            referencedRelation: "tenant_bus_units"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tenant_bus_allocations_root_allocation_id_fkey"
            columns: ["root_allocation_id"]
            isOneToOne: false
            referencedRelation: "ops_bus_allocation_details"
            referencedColumns: ["allocation_id"]
          },
          {
            foreignKeyName: "tenant_bus_allocations_root_allocation_id_fkey"
            columns: ["root_allocation_id"]
            isOneToOne: false
            referencedRelation: "tenant_bus_allocations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tenant_bus_allocations_service_id_fkey"
            columns: ["service_id"]
            isOneToOne: false
            referencedRelation: "services"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tenant_bus_allocations_split_from_allocation_id_fkey"
            columns: ["split_from_allocation_id"]
            isOneToOne: false
            referencedRelation: "ops_bus_allocation_details"
            referencedColumns: ["allocation_id"]
          },
          {
            foreignKeyName: "tenant_bus_allocations_split_from_allocation_id_fkey"
            columns: ["split_from_allocation_id"]
            isOneToOne: false
            referencedRelation: "tenant_bus_allocations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tenant_bus_allocations_stop_id_fkey"
            columns: ["stop_id"]
            isOneToOne: false
            referencedRelation: "tenant_bus_line_stops"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tenant_bus_allocations_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      tenant_bus_line_stops: {
        Row: {
          active: boolean
          bus_line_id: string
          city: string
          created_at: string
          direction: Database["public"]["Enums"]["service_direction"]
          id: string
          is_manual: boolean
          lat: number | null
          lng: number | null
          order_index: number
          pickup_note: string | null
          pickup_note_key: string | null
          pickup_time: string | null
          stop_name: string
          stop_order: number
          tenant_id: string
          updated_at: string
        }
        Insert: {
          active?: boolean
          bus_line_id: string
          city: string
          created_at?: string
          direction: Database["public"]["Enums"]["service_direction"]
          id?: string
          is_manual?: boolean
          lat?: number | null
          lng?: number | null
          order_index: number
          pickup_note?: string | null
          pickup_note_key?: string | null
          pickup_time?: string | null
          stop_name: string
          stop_order: number
          tenant_id: string
          updated_at?: string
        }
        Update: {
          active?: boolean
          bus_line_id?: string
          city?: string
          created_at?: string
          direction?: Database["public"]["Enums"]["service_direction"]
          id?: string
          is_manual?: boolean
          lat?: number | null
          lng?: number | null
          order_index?: number
          pickup_note?: string | null
          pickup_note_key?: string | null
          pickup_time?: string | null
          stop_name?: string
          stop_order?: number
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "tenant_bus_line_stops_bus_line_id_fkey"
            columns: ["bus_line_id"]
            isOneToOne: false
            referencedRelation: "tenant_bus_lines"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tenant_bus_line_stops_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      tenant_bus_lines: {
        Row: {
          active: boolean
          alert_threshold: number
          code: string
          created_at: string
          default_capacity: number
          family_code: string
          family_name: string
          id: string
          name: string
          tenant_id: string
          updated_at: string
          variant_label: string | null
        }
        Insert: {
          active?: boolean
          alert_threshold?: number
          code: string
          created_at?: string
          default_capacity?: number
          family_code: string
          family_name: string
          id?: string
          name: string
          tenant_id: string
          updated_at?: string
          variant_label?: string | null
        }
        Update: {
          active?: boolean
          alert_threshold?: number
          code?: string
          created_at?: string
          default_capacity?: number
          family_code?: string
          family_name?: string
          id?: string
          name?: string
          tenant_id?: string
          updated_at?: string
          variant_label?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "tenant_bus_lines_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      tenant_bus_units: {
        Row: {
          active: boolean
          bus_line_id: string
          capacity: number
          close_reason: string | null
          created_at: string
          driver_name_outbound: string | null
          driver_name_return: string | null
          driver_phone_outbound: string | null
          driver_phone_return: string | null
          group_name: string | null
          id: string
          label: string
          low_seat_threshold: number
          manual_close: boolean
          minimum_passengers: number | null
          sort_order: number
          status: string
          tag: string | null
          tenant_id: string
          updated_at: string
        }
        Insert: {
          active?: boolean
          bus_line_id: string
          capacity: number
          close_reason?: string | null
          created_at?: string
          driver_name_outbound?: string | null
          driver_name_return?: string | null
          driver_phone_outbound?: string | null
          driver_phone_return?: string | null
          group_name?: string | null
          id?: string
          label: string
          low_seat_threshold?: number
          manual_close?: boolean
          minimum_passengers?: number | null
          sort_order?: number
          status?: string
          tag?: string | null
          tenant_id: string
          updated_at?: string
        }
        Update: {
          active?: boolean
          bus_line_id?: string
          capacity?: number
          close_reason?: string | null
          created_at?: string
          driver_name_outbound?: string | null
          driver_name_return?: string | null
          driver_phone_outbound?: string | null
          driver_phone_return?: string | null
          group_name?: string | null
          id?: string
          label?: string
          low_seat_threshold?: number
          manual_close?: boolean
          minimum_passengers?: number | null
          sort_order?: number
          status?: string
          tag?: string | null
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "tenant_bus_units_bus_line_id_fkey"
            columns: ["bus_line_id"]
            isOneToOne: false
            referencedRelation: "tenant_bus_lines"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tenant_bus_units_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      tenant_geo_settings: {
        Row: {
          ports: string[]
          tenant_id: string
          updated_at: string
          zones: string[]
        }
        Insert: {
          ports?: string[]
          tenant_id: string
          updated_at?: string
          zones?: string[]
        }
        Update: {
          ports?: string[]
          tenant_id?: string
          updated_at?: string
          zones?: string[]
        }
        Relationships: [
          {
            foreignKeyName: "tenant_geo_settings_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: true
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      tenant_mario_bus_rows: {
        Row: {
          created_at: string | null
          id: string
          label: string
          notes: string | null
          sort_order: number
          tenant_id: string
        }
        Insert: {
          created_at?: string | null
          id?: string
          label: string
          notes?: string | null
          sort_order?: number
          tenant_id: string
        }
        Update: {
          created_at?: string | null
          id?: string
          label?: string
          notes?: string | null
          sort_order?: number
          tenant_id?: string
        }
        Relationships: []
      }
      tenant_operational_settings: {
        Row: {
          arrival_summary_hours: number
          bruno_email: string | null
          departure_summary_hours: number
          internal_notes: string | null
          monday_bus_enabled: boolean
          monday_bus_scope: string
          monday_bus_send_weekday: number
          report_processing_limit: number
          split_arrivals_exports: boolean
          split_departures_exports: boolean
          statement_agencies: string[]
          tenant_id: string
          updated_at: string
        }
        Insert: {
          arrival_summary_hours?: number
          bruno_email?: string | null
          departure_summary_hours?: number
          internal_notes?: string | null
          monday_bus_enabled?: boolean
          monday_bus_scope?: string
          monday_bus_send_weekday?: number
          report_processing_limit?: number
          split_arrivals_exports?: boolean
          split_departures_exports?: boolean
          statement_agencies?: string[]
          tenant_id: string
          updated_at?: string
        }
        Update: {
          arrival_summary_hours?: number
          bruno_email?: string | null
          departure_summary_hours?: number
          internal_notes?: string | null
          monday_bus_enabled?: boolean
          monday_bus_scope?: string
          monday_bus_send_weekday?: number
          report_processing_limit?: number
          split_arrivals_exports?: boolean
          split_departures_exports?: boolean
          statement_agencies?: string[]
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "tenant_operational_settings_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: true
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      tenant_planning_cells: {
        Row: {
          bg_color: string | null
          cell_date: string
          col_index: number
          content: string | null
          created_at: string | null
          end_date: string | null
          id: string
          planning_type: string
          row_key: string
          service_id: string | null
          tenant_id: string
          updated_at: string | null
        }
        Insert: {
          bg_color?: string | null
          cell_date: string
          col_index?: number
          content?: string | null
          created_at?: string | null
          end_date?: string | null
          id?: string
          planning_type: string
          row_key: string
          service_id?: string | null
          tenant_id: string
          updated_at?: string | null
        }
        Update: {
          bg_color?: string | null
          cell_date?: string
          col_index?: number
          content?: string | null
          created_at?: string | null
          end_date?: string | null
          id?: string
          planning_type?: string
          row_key?: string
          service_id?: string | null
          tenant_id?: string
          updated_at?: string | null
        }
        Relationships: []
      }
      tenant_user_feature_flags: {
        Row: {
          created_at: string
          enabled: boolean
          feature_code: string
          id: string
          tenant_id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          enabled?: boolean
          feature_code: string
          id?: string
          tenant_id: string
          user_id: string
        }
        Update: {
          created_at?: string
          enabled?: boolean
          feature_code?: string
          id?: string
          tenant_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "tenant_user_feature_flags_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      tenant_whatsapp_settings: {
        Row: {
          allow_text_fallback: boolean
          arrival_notice_minutes: number
          arrival_template: string
          bus_convocazioni_send_hour: number
          default_template: string
          enable_2h_reminder: boolean
          enable_arrival_messages: boolean
          template_language: string
          tenant_id: string
          updated_at: string
        }
        Insert: {
          allow_text_fallback?: boolean
          arrival_notice_minutes?: number
          arrival_template?: string
          bus_convocazioni_send_hour?: number
          default_template?: string
          enable_2h_reminder?: boolean
          enable_arrival_messages?: boolean
          template_language?: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          allow_text_fallback?: boolean
          arrival_notice_minutes?: number
          arrival_template?: string
          bus_convocazioni_send_hour?: number
          default_template?: string
          enable_2h_reminder?: boolean
          enable_arrival_messages?: boolean
          template_language?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "tenant_whatsapp_settings_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: true
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      tenants: {
        Row: {
          address: string | null
          contact_email: string | null
          contact_phone: string | null
          created_at: string
          id: string
          legal_name: string | null
          name: string
          quote_bank_holder: string | null
          quote_company_phone: string | null
          quote_company_whatsapp: string | null
          quote_iban: string | null
          quote_offer_validity_days: number
          quote_payment_instructions: string | null
          quote_sequence: number
          quote_swift_code: string | null
          updated_at: string
          vat_number: string | null
          website_url: string | null
        }
        Insert: {
          address?: string | null
          contact_email?: string | null
          contact_phone?: string | null
          created_at?: string
          id?: string
          legal_name?: string | null
          name: string
          quote_bank_holder?: string | null
          quote_company_phone?: string | null
          quote_company_whatsapp?: string | null
          quote_iban?: string | null
          quote_offer_validity_days?: number
          quote_payment_instructions?: string | null
          quote_sequence?: number
          quote_swift_code?: string | null
          updated_at?: string
          vat_number?: string | null
          website_url?: string | null
        }
        Update: {
          address?: string | null
          contact_email?: string | null
          contact_phone?: string | null
          created_at?: string
          id?: string
          legal_name?: string | null
          name?: string
          quote_bank_holder?: string | null
          quote_company_phone?: string | null
          quote_company_whatsapp?: string | null
          quote_iban?: string | null
          quote_offer_validity_days?: number
          quote_payment_instructions?: string | null
          quote_sequence?: number
          quote_swift_code?: string | null
          updated_at?: string
          vat_number?: string | null
          website_url?: string | null
        }
        Relationships: []
      }
      trip_groups: {
        Row: {
          created_at: string
          created_by: string | null
          date: string
          driver_profile_id: string | null
          driver_user_id: string | null
          id: string
          notes: string | null
          status: string
          tenant_id: string
          updated_at: string
          vehicle_capacity: number | null
          vehicle_label: string | null
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          date: string
          driver_profile_id?: string | null
          driver_user_id?: string | null
          id?: string
          notes?: string | null
          status?: string
          tenant_id: string
          updated_at?: string
          vehicle_capacity?: number | null
          vehicle_label?: string | null
        }
        Update: {
          created_at?: string
          created_by?: string | null
          date?: string
          driver_profile_id?: string | null
          driver_user_id?: string | null
          id?: string
          notes?: string | null
          status?: string
          tenant_id?: string
          updated_at?: string
          vehicle_capacity?: number | null
          vehicle_label?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "trip_groups_driver_profile_id_fkey"
            columns: ["driver_profile_id"]
            isOneToOne: false
            referencedRelation: "driver_profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      user_capability_overrides: {
        Row: {
          capability: string
          created_at: string
          enabled: boolean
          id: string
          tenant_id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          capability: string
          created_at?: string
          enabled: boolean
          id?: string
          tenant_id: string
          updated_at?: string
          user_id: string
        }
        Update: {
          capability?: string
          created_at?: string
          enabled?: boolean
          id?: string
          tenant_id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_capability_overrides_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      user_login_sessions: {
        Row: {
          created_at: string
          device_info: Json | null
          id: string
          ip_address: unknown
          last_activity: string
          session_end: string | null
          session_start: string
          tenant_id: string
          updated_at: string
          user_agent: string | null
          user_id: string
        }
        Insert: {
          created_at?: string
          device_info?: Json | null
          id?: string
          ip_address?: unknown
          last_activity?: string
          session_end?: string | null
          session_start?: string
          tenant_id: string
          updated_at?: string
          user_agent?: string | null
          user_id: string
        }
        Update: {
          created_at?: string
          device_info?: Json | null
          id?: string
          ip_address?: unknown
          last_activity?: string
          session_end?: string | null
          session_start?: string
          tenant_id?: string
          updated_at?: string
          user_agent?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_login_sessions_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      vehicle_anomalies: {
        Row: {
          active: boolean
          blocked_from: string | null
          blocked_until: string | null
          description: string | null
          driver_user_id: string | null
          id: string
          reported_at: string
          resolved_at: string | null
          resolved_by_user_id: string | null
          severity: string
          tenant_id: string
          title: string
          vehicle_id: string
        }
        Insert: {
          active?: boolean
          blocked_from?: string | null
          blocked_until?: string | null
          description?: string | null
          driver_user_id?: string | null
          id?: string
          reported_at?: string
          resolved_at?: string | null
          resolved_by_user_id?: string | null
          severity?: string
          tenant_id: string
          title: string
          vehicle_id: string
        }
        Update: {
          active?: boolean
          blocked_from?: string | null
          blocked_until?: string | null
          description?: string | null
          driver_user_id?: string | null
          id?: string
          reported_at?: string
          resolved_at?: string | null
          resolved_by_user_id?: string | null
          severity?: string
          tenant_id?: string
          title?: string
          vehicle_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "vehicle_anomalies_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vehicle_anomalies_vehicle_id_fkey"
            columns: ["vehicle_id"]
            isOneToOne: false
            referencedRelation: "vehicles"
            referencedColumns: ["id"]
          },
        ]
      }
      vehicle_commitments: {
        Row: {
          commitment_date: string
          commitment_type: string
          created_at: string
          created_by: string | null
          id: string
          notes: string | null
          tenant_id: string
          vehicle_id: string
        }
        Insert: {
          commitment_date: string
          commitment_type: string
          created_at?: string
          created_by?: string | null
          id?: string
          notes?: string | null
          tenant_id: string
          vehicle_id: string
        }
        Update: {
          commitment_date?: string
          commitment_type?: string
          created_at?: string
          created_by?: string | null
          id?: string
          notes?: string | null
          tenant_id?: string
          vehicle_id?: string
        }
        Relationships: []
      }
      vehicle_compliance_costs: {
        Row: {
          amount_cents: number
          compliance_type: string
          created_at: string
          created_by: string | null
          duration_months: number | null
          id: string
          notes: string | null
          paid_at: string
          provider: string | null
          tenant_id: string
          vehicle_id: string
        }
        Insert: {
          amount_cents: number
          compliance_type: string
          created_at?: string
          created_by?: string | null
          duration_months?: number | null
          id?: string
          notes?: string | null
          paid_at: string
          provider?: string | null
          tenant_id: string
          vehicle_id: string
        }
        Update: {
          amount_cents?: number
          compliance_type?: string
          created_at?: string
          created_by?: string | null
          duration_months?: number | null
          id?: string
          notes?: string | null
          paid_at?: string
          provider?: string | null
          tenant_id?: string
          vehicle_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "vehicle_compliance_costs_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vehicle_compliance_costs_vehicle_id_fkey"
            columns: ["vehicle_id"]
            isOneToOne: false
            referencedRelation: "vehicles"
            referencedColumns: ["id"]
          },
        ]
      }
      vehicle_compliance_grace_periods: {
        Row: {
          compliance_type: string
          grace_days: number
          id: string
          tenant_id: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          compliance_type: string
          grace_days?: number
          id?: string
          tenant_id: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          compliance_type?: string
          grace_days?: number
          id?: string
          tenant_id?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "vehicle_compliance_grace_periods_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      vehicle_compliance_history: {
        Row: {
          action: string
          compliance_type: string
          driver_id: string | null
          id: string
          new_expiry_date: string | null
          notes: string | null
          old_expiry_date: string | null
          performed_at: string
          performed_by: string | null
          ref_id: string | null
          tenant_id: string
          vehicle_id: string | null
        }
        Insert: {
          action: string
          compliance_type: string
          driver_id?: string | null
          id?: string
          new_expiry_date?: string | null
          notes?: string | null
          old_expiry_date?: string | null
          performed_at?: string
          performed_by?: string | null
          ref_id?: string | null
          tenant_id: string
          vehicle_id?: string | null
        }
        Update: {
          action?: string
          compliance_type?: string
          driver_id?: string | null
          id?: string
          new_expiry_date?: string | null
          notes?: string | null
          old_expiry_date?: string | null
          performed_at?: string
          performed_by?: string | null
          ref_id?: string | null
          tenant_id?: string
          vehicle_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "vehicle_compliance_history_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "driver_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vehicle_compliance_history_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vehicle_compliance_history_vehicle_id_fkey"
            columns: ["vehicle_id"]
            isOneToOne: false
            referencedRelation: "vehicles"
            referencedColumns: ["id"]
          },
        ]
      }
      vehicle_daily_availability: {
        Row: {
          available: boolean
          created_at: string
          date: string
          id: string
          notes: string | null
          tenant_id: string
          updated_at: string
          vehicle_id: string
        }
        Insert: {
          available?: boolean
          created_at?: string
          date: string
          id?: string
          notes?: string | null
          tenant_id: string
          updated_at?: string
          vehicle_id: string
        }
        Update: {
          available?: boolean
          created_at?: string
          date?: string
          id?: string
          notes?: string | null
          tenant_id?: string
          updated_at?: string
          vehicle_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "vehicle_daily_availability_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vehicle_daily_availability_vehicle_id_fkey"
            columns: ["vehicle_id"]
            isOneToOne: false
            referencedRelation: "vehicles"
            referencedColumns: ["id"]
          },
        ]
      }
      vehicle_documents: {
        Row: {
          file_path: string
          id: string
          notes: string | null
          tenant_id: string
          title: string
          uploaded_at: string
          uploaded_by: string | null
          vehicle_id: string
        }
        Insert: {
          file_path: string
          id?: string
          notes?: string | null
          tenant_id?: string
          title: string
          uploaded_at?: string
          uploaded_by?: string | null
          vehicle_id: string
        }
        Update: {
          file_path?: string
          id?: string
          notes?: string | null
          tenant_id?: string
          title?: string
          uploaded_at?: string
          uploaded_by?: string | null
          vehicle_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "vehicle_documents_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vehicle_documents_vehicle_id_fkey"
            columns: ["vehicle_id"]
            isOneToOne: false
            referencedRelation: "vehicles"
            referencedColumns: ["id"]
          },
        ]
      }
      vehicle_extinguishers: {
        Row: {
          active: boolean
          created_at: string
          created_by: string | null
          document_path: string | null
          expiry_date: string
          id: string
          last_revision_date: string | null
          notes: string | null
          serial_number: string | null
          tenant_id: string
          vehicle_id: string
        }
        Insert: {
          active?: boolean
          created_at?: string
          created_by?: string | null
          document_path?: string | null
          expiry_date: string
          id?: string
          last_revision_date?: string | null
          notes?: string | null
          serial_number?: string | null
          tenant_id: string
          vehicle_id: string
        }
        Update: {
          active?: boolean
          created_at?: string
          created_by?: string | null
          document_path?: string | null
          expiry_date?: string
          id?: string
          last_revision_date?: string | null
          notes?: string | null
          serial_number?: string | null
          tenant_id?: string
          vehicle_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "vehicle_extinguishers_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vehicle_extinguishers_vehicle_id_fkey"
            columns: ["vehicle_id"]
            isOneToOne: false
            referencedRelation: "vehicles"
            referencedColumns: ["id"]
          },
        ]
      }
      vehicle_fuel: {
        Row: {
          approval_status: string
          approved_at: string | null
          approved_by: string | null
          cost: number | null
          created_at: string
          created_by: string | null
          fiscal_document_name: string | null
          fiscal_document_url: string | null
          fuel_date: string
          fuel_type: string | null
          id: string
          km_at_fuel: number | null
          liters: number | null
          notes: string | null
          station: string | null
          submitted_via_qr: boolean
          tenant_id: string
          vehicle_id: string
        }
        Insert: {
          approval_status?: string
          approved_at?: string | null
          approved_by?: string | null
          cost?: number | null
          created_at?: string
          created_by?: string | null
          fiscal_document_name?: string | null
          fiscal_document_url?: string | null
          fuel_date: string
          fuel_type?: string | null
          id?: string
          km_at_fuel?: number | null
          liters?: number | null
          notes?: string | null
          station?: string | null
          submitted_via_qr?: boolean
          tenant_id: string
          vehicle_id: string
        }
        Update: {
          approval_status?: string
          approved_at?: string | null
          approved_by?: string | null
          cost?: number | null
          created_at?: string
          created_by?: string | null
          fiscal_document_name?: string | null
          fiscal_document_url?: string | null
          fuel_date?: string
          fuel_type?: string | null
          id?: string
          km_at_fuel?: number | null
          liters?: number | null
          notes?: string | null
          station?: string | null
          submitted_via_qr?: boolean
          tenant_id?: string
          vehicle_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "vehicle_fuel_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vehicle_fuel_vehicle_id_fkey"
            columns: ["vehicle_id"]
            isOneToOne: false
            referencedRelation: "vehicles"
            referencedColumns: ["id"]
          },
        ]
      }
      vehicle_inspections: {
        Row: {
          created_at: string
          created_by: string | null
          document_path: string | null
          expiry_date: string
          id: string
          inspection_center: string | null
          inspection_date: string
          is_current: boolean
          notes: string | null
          outcome: string | null
          outcome_notes: string | null
          tenant_id: string
          vehicle_id: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          document_path?: string | null
          expiry_date: string
          id?: string
          inspection_center?: string | null
          inspection_date: string
          is_current?: boolean
          notes?: string | null
          outcome?: string | null
          outcome_notes?: string | null
          tenant_id: string
          vehicle_id: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          document_path?: string | null
          expiry_date?: string
          id?: string
          inspection_center?: string | null
          inspection_date?: string
          is_current?: boolean
          notes?: string | null
          outcome?: string | null
          outcome_notes?: string | null
          tenant_id?: string
          vehicle_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "vehicle_inspections_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vehicle_inspections_vehicle_id_fkey"
            columns: ["vehicle_id"]
            isOneToOne: false
            referencedRelation: "vehicles"
            referencedColumns: ["id"]
          },
        ]
      }
      vehicle_insurances: {
        Row: {
          annual_amount_cents: number | null
          company: string
          created_at: string
          created_by: string | null
          document_path: string | null
          expiry_date: string
          id: string
          is_current: boolean
          notes: string | null
          policy_number: string | null
          tenant_id: string
          vehicle_id: string
        }
        Insert: {
          annual_amount_cents?: number | null
          company: string
          created_at?: string
          created_by?: string | null
          document_path?: string | null
          expiry_date: string
          id?: string
          is_current?: boolean
          notes?: string | null
          policy_number?: string | null
          tenant_id: string
          vehicle_id: string
        }
        Update: {
          annual_amount_cents?: number | null
          company?: string
          created_at?: string
          created_by?: string | null
          document_path?: string | null
          expiry_date?: string
          id?: string
          is_current?: boolean
          notes?: string | null
          policy_number?: string | null
          tenant_id?: string
          vehicle_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "vehicle_insurances_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vehicle_insurances_vehicle_id_fkey"
            columns: ["vehicle_id"]
            isOneToOne: false
            referencedRelation: "vehicles"
            referencedColumns: ["id"]
          },
        ]
      }
      vehicle_km_logs: {
        Row: {
          created_at: string
          driver_name: string
          end_at: string | null
          end_km: number | null
          id: string
          notes: string | null
          start_at: string
          start_km: number
          vehicle_id: string
        }
        Insert: {
          created_at?: string
          driver_name: string
          end_at?: string | null
          end_km?: number | null
          id?: string
          notes?: string | null
          start_at?: string
          start_km: number
          vehicle_id: string
        }
        Update: {
          created_at?: string
          driver_name?: string
          end_at?: string | null
          end_km?: number | null
          id?: string
          notes?: string | null
          start_at?: string
          start_km?: number
          vehicle_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "vehicle_km_logs_vehicle_id_fkey"
            columns: ["vehicle_id"]
            isOneToOne: false
            referencedRelation: "vehicles"
            referencedColumns: ["id"]
          },
        ]
      }
      vehicle_maintenance: {
        Row: {
          cost: number | null
          created_at: string
          created_by: string | null
          description: string
          execution_mode: string
          id: string
          km_at_service: number | null
          maintenance_date: string
          maintenance_kind: string
          notes: string | null
          provider: string | null
          replaced_parts: Json
          tenant_id: string
          vehicle_id: string
        }
        Insert: {
          cost?: number | null
          created_at?: string
          created_by?: string | null
          description: string
          execution_mode?: string
          id?: string
          km_at_service?: number | null
          maintenance_date: string
          maintenance_kind?: string
          notes?: string | null
          provider?: string | null
          replaced_parts?: Json
          tenant_id: string
          vehicle_id: string
        }
        Update: {
          cost?: number | null
          created_at?: string
          created_by?: string | null
          description?: string
          execution_mode?: string
          id?: string
          km_at_service?: number | null
          maintenance_date?: string
          maintenance_kind?: string
          notes?: string | null
          provider?: string | null
          replaced_parts?: Json
          tenant_id?: string
          vehicle_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "vehicle_maintenance_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vehicle_maintenance_vehicle_id_fkey"
            columns: ["vehicle_id"]
            isOneToOne: false
            referencedRelation: "vehicles"
            referencedColumns: ["id"]
          },
        ]
      }
      vehicle_qr_reports: {
        Row: {
          created_at: string
          description: string
          id: string
          photo_urls: string[] | null
          reporter_name: string | null
          severity: string
          status: string
          vehicle_id: string
        }
        Insert: {
          created_at?: string
          description: string
          id?: string
          photo_urls?: string[] | null
          reporter_name?: string | null
          severity?: string
          status?: string
          vehicle_id: string
        }
        Update: {
          created_at?: string
          description?: string
          id?: string
          photo_urls?: string[] | null
          reporter_name?: string | null
          severity?: string
          status?: string
          vehicle_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "vehicle_qr_reports_vehicle_id_fkey"
            columns: ["vehicle_id"]
            isOneToOne: false
            referencedRelation: "vehicles"
            referencedColumns: ["id"]
          },
        ]
      }
      vehicle_spare_parts: {
        Row: {
          cost: number | null
          created_at: string
          created_by: string | null
          id: string
          installed_at: string | null
          notes: string | null
          order_date: string
          part_name: string
          quantity: number
          status: string
          supplier: string | null
          tenant_id: string
          vehicle_id: string
        }
        Insert: {
          cost?: number | null
          created_at?: string
          created_by?: string | null
          id?: string
          installed_at?: string | null
          notes?: string | null
          order_date: string
          part_name: string
          quantity?: number
          status?: string
          supplier?: string | null
          tenant_id: string
          vehicle_id: string
        }
        Update: {
          cost?: number | null
          created_at?: string
          created_by?: string | null
          id?: string
          installed_at?: string | null
          notes?: string | null
          order_date?: string
          part_name?: string
          quantity?: number
          status?: string
          supplier?: string | null
          tenant_id?: string
          vehicle_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "vehicle_spare_parts_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vehicle_spare_parts_vehicle_id_fkey"
            columns: ["vehicle_id"]
            isOneToOne: false
            referencedRelation: "vehicles"
            referencedColumns: ["id"]
          },
        ]
      }
      vehicle_tachographs: {
        Row: {
          calibration_date: string
          center: string | null
          certificate_number: string | null
          created_at: string
          created_by: string | null
          document_path: string | null
          expiry_date: string
          id: string
          is_current: boolean
          notes: string | null
          tenant_id: string
          vehicle_id: string
        }
        Insert: {
          calibration_date: string
          center?: string | null
          certificate_number?: string | null
          created_at?: string
          created_by?: string | null
          document_path?: string | null
          expiry_date: string
          id?: string
          is_current?: boolean
          notes?: string | null
          tenant_id: string
          vehicle_id: string
        }
        Update: {
          calibration_date?: string
          center?: string | null
          certificate_number?: string | null
          created_at?: string
          created_by?: string | null
          document_path?: string | null
          expiry_date?: string
          id?: string
          is_current?: boolean
          notes?: string | null
          tenant_id?: string
          vehicle_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "vehicle_tachographs_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vehicle_tachographs_vehicle_id_fkey"
            columns: ["vehicle_id"]
            isOneToOne: false
            referencedRelation: "vehicles"
            referencedColumns: ["id"]
          },
        ]
      }
      vehicle_time_blocks: {
        Row: {
          block_from: string
          block_to: string
          created_at: string
          date: string
          id: string
          reason: string
          reason_notes: string | null
          tenant_id: string
          vehicle_id: string
        }
        Insert: {
          block_from: string
          block_to: string
          created_at?: string
          date: string
          id?: string
          reason: string
          reason_notes?: string | null
          tenant_id: string
          vehicle_id: string
        }
        Update: {
          block_from?: string
          block_to?: string
          created_at?: string
          date?: string
          id?: string
          reason?: string
          reason_notes?: string | null
          tenant_id?: string
          vehicle_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "vehicle_time_blocks_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vehicle_time_blocks_vehicle_id_fkey"
            columns: ["vehicle_id"]
            isOneToOne: false
            referencedRelation: "vehicles"
            referencedColumns: ["id"]
          },
        ]
      }
      vehicles: {
        Row: {
          active: boolean
          blocked_from: string | null
          blocked_reason: string | null
          blocked_until: string | null
          capacity: number | null
          compliance_override_by: string | null
          compliance_override_reason: string | null
          compliance_override_until: string | null
          created_at: string
          default_zone: string | null
          extinguisher_enabled: boolean
          habitual_driver_profile_id: string | null
          habitual_driver_user_id: string | null
          id: string
          inspection_expiry: string | null
          insurance_expiry: string | null
          is_blocked_manual: boolean
          km: number | null
          label: string
          length_meters: number | null
          libretto_document_path: string | null
          libretto_document_path_back: string | null
          libretto_uploaded_at: string | null
          libretto_uploaded_at_back: string | null
          license_number: string | null
          notes: string | null
          plate: string | null
          qr_token: string | null
          radius_vehicle_id: string | null
          road_tax_expiry: string | null
          tachograph_enabled: boolean
          telaio: string | null
          tenant_id: string
          vehicle_size: string | null
        }
        Insert: {
          active?: boolean
          blocked_from?: string | null
          blocked_reason?: string | null
          blocked_until?: string | null
          capacity?: number | null
          compliance_override_by?: string | null
          compliance_override_reason?: string | null
          compliance_override_until?: string | null
          created_at?: string
          default_zone?: string | null
          extinguisher_enabled?: boolean
          habitual_driver_profile_id?: string | null
          habitual_driver_user_id?: string | null
          id?: string
          inspection_expiry?: string | null
          insurance_expiry?: string | null
          is_blocked_manual?: boolean
          km?: number | null
          label: string
          length_meters?: number | null
          libretto_document_path?: string | null
          libretto_document_path_back?: string | null
          libretto_uploaded_at?: string | null
          libretto_uploaded_at_back?: string | null
          license_number?: string | null
          notes?: string | null
          plate?: string | null
          qr_token?: string | null
          radius_vehicle_id?: string | null
          road_tax_expiry?: string | null
          tachograph_enabled?: boolean
          telaio?: string | null
          tenant_id: string
          vehicle_size?: string | null
        }
        Update: {
          active?: boolean
          blocked_from?: string | null
          blocked_reason?: string | null
          blocked_until?: string | null
          capacity?: number | null
          compliance_override_by?: string | null
          compliance_override_reason?: string | null
          compliance_override_until?: string | null
          created_at?: string
          default_zone?: string | null
          extinguisher_enabled?: boolean
          habitual_driver_profile_id?: string | null
          habitual_driver_user_id?: string | null
          id?: string
          inspection_expiry?: string | null
          insurance_expiry?: string | null
          is_blocked_manual?: boolean
          km?: number | null
          label?: string
          length_meters?: number | null
          libretto_document_path?: string | null
          libretto_document_path_back?: string | null
          libretto_uploaded_at?: string | null
          libretto_uploaded_at_back?: string | null
          license_number?: string | null
          notes?: string | null
          plate?: string | null
          qr_token?: string | null
          radius_vehicle_id?: string | null
          road_tax_expiry?: string | null
          tachograph_enabled?: boolean
          telaio?: string | null
          tenant_id?: string
          vehicle_size?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "vehicles_habitual_driver_profile_id_fkey"
            columns: ["habitual_driver_profile_id"]
            isOneToOne: false
            referencedRelation: "driver_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vehicles_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      whatsapp_auto_reply_logs: {
        Row: {
          auto_reply_type: string
          closure_window_key: string
          conversation_id: string | null
          created_at: string
          error_message: string | null
          id: string
          phone_number: string
          provider_message_id: string | null
          send_status: string
          sent_at: string | null
          tenant_id: string
          updated_at: string
        }
        Insert: {
          auto_reply_type: string
          closure_window_key: string
          conversation_id?: string | null
          created_at?: string
          error_message?: string | null
          id?: string
          phone_number: string
          provider_message_id?: string | null
          send_status?: string
          sent_at?: string | null
          tenant_id: string
          updated_at?: string
        }
        Update: {
          auto_reply_type?: string
          closure_window_key?: string
          conversation_id?: string | null
          created_at?: string
          error_message?: string | null
          id?: string
          phone_number?: string
          provider_message_id?: string | null
          send_status?: string
          sent_at?: string | null
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "whatsapp_auto_reply_logs_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "whatsapp_threads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "whatsapp_auto_reply_logs_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      whatsapp_contacts: {
        Row: {
          created_at: string
          customer_full_name: string | null
          customer_id: string | null
          id: string
          manual_contact_name: string | null
          phone_e164: string | null
          profile_name: string | null
          tenant_id: string | null
          updated_at: string
          wa_id: string
          wa_profile_name: string | null
        }
        Insert: {
          created_at?: string
          customer_full_name?: string | null
          customer_id?: string | null
          id?: string
          manual_contact_name?: string | null
          phone_e164?: string | null
          profile_name?: string | null
          tenant_id?: string | null
          updated_at?: string
          wa_id: string
          wa_profile_name?: string | null
        }
        Update: {
          created_at?: string
          customer_full_name?: string | null
          customer_id?: string | null
          id?: string
          manual_contact_name?: string | null
          phone_e164?: string | null
          profile_name?: string | null
          tenant_id?: string | null
          updated_at?: string
          wa_id?: string
          wa_profile_name?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "whatsapp_contacts_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      whatsapp_cost_reconciliations: {
        Row: {
          created_at: string
          difference: number
          estimated_cost: number
          estimated_volume: number
          id: string
          meta_reported_cost: number
          meta_reported_volume: number
          period_end: string
          period_start: string
          pricing_category: string | null
          pricing_type: string | null
          reconciled_at: string
          source_file: string | null
          source_hash: string | null
          tenant_id: string
        }
        Insert: {
          created_at?: string
          difference?: number
          estimated_cost?: number
          estimated_volume?: number
          id?: string
          meta_reported_cost?: number
          meta_reported_volume?: number
          period_end: string
          period_start: string
          pricing_category?: string | null
          pricing_type?: string | null
          reconciled_at?: string
          source_file?: string | null
          source_hash?: string | null
          tenant_id: string
        }
        Update: {
          created_at?: string
          difference?: number
          estimated_cost?: number
          estimated_volume?: number
          id?: string
          meta_reported_cost?: number
          meta_reported_volume?: number
          period_end?: string
          period_start?: string
          pricing_category?: string | null
          pricing_type?: string | null
          reconciled_at?: string
          source_file?: string | null
          source_hash?: string | null
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "whatsapp_cost_reconciliations_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      whatsapp_cost_settings: {
        Row: {
          anomaly_growth_percent: number
          created_at: string
          daily_threshold: number
          max_avg_messages_per_passenger: number
          monthly_threshold: number
          tenant_id: string
          updated_at: string
        }
        Insert: {
          anomaly_growth_percent?: number
          created_at?: string
          daily_threshold?: number
          max_avg_messages_per_passenger?: number
          monthly_threshold?: number
          tenant_id: string
          updated_at?: string
        }
        Update: {
          anomaly_growth_percent?: number
          created_at?: string
          daily_threshold?: number
          max_avg_messages_per_passenger?: number
          monthly_threshold?: number
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "whatsapp_cost_settings_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: true
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      whatsapp_events: {
        Row: {
          created_at: string
          happened_at: string
          id: string
          kind: string | null
          payload_json: Json
          provider_message_id: string | null
          service_id: string | null
          status: string
          template: string | null
          tenant_id: string
          to_phone: string
        }
        Insert: {
          created_at?: string
          happened_at?: string
          id?: string
          kind?: string | null
          payload_json?: Json
          provider_message_id?: string | null
          service_id?: string | null
          status: string
          template?: string | null
          tenant_id: string
          to_phone: string
        }
        Update: {
          created_at?: string
          happened_at?: string
          id?: string
          kind?: string | null
          payload_json?: Json
          provider_message_id?: string | null
          service_id?: string | null
          status?: string
          template?: string | null
          tenant_id?: string
          to_phone?: string
        }
        Relationships: [
          {
            foreignKeyName: "whatsapp_events_service_id_fkey"
            columns: ["service_id"]
            isOneToOne: false
            referencedRelation: "services"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "whatsapp_events_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      whatsapp_message_events: {
        Row: {
          applied_rate_id: string | null
          applied_rate_source: string | null
          applied_rate_valid_from: string | null
          billable: boolean | null
          booking_id: string | null
          cost_calculated_at: string | null
          cost_status: string
          created_at: string
          delivered_at: string | null
          error_code: string | null
          error_message: string | null
          estimated_cost: number | null
          estimated_currency: string
          failed_at: string | null
          id: string
          message_direction: string
          passenger_id: string | null
          pricing_category: string | null
          pricing_model: string | null
          pricing_type: string | null
          raw_metadata: Json
          read_at: string | null
          recipient_country_code: string | null
          recipient_phone: string | null
          sent_at: string | null
          status: string
          status_timestamp: string | null
          template_name: string | null
          tenant_id: string
          updated_at: string
          wamid: string
        }
        Insert: {
          applied_rate_id?: string | null
          applied_rate_source?: string | null
          applied_rate_valid_from?: string | null
          billable?: boolean | null
          booking_id?: string | null
          cost_calculated_at?: string | null
          cost_status?: string
          created_at?: string
          delivered_at?: string | null
          error_code?: string | null
          error_message?: string | null
          estimated_cost?: number | null
          estimated_currency?: string
          failed_at?: string | null
          id?: string
          message_direction?: string
          passenger_id?: string | null
          pricing_category?: string | null
          pricing_model?: string | null
          pricing_type?: string | null
          raw_metadata?: Json
          read_at?: string | null
          recipient_country_code?: string | null
          recipient_phone?: string | null
          sent_at?: string | null
          status: string
          status_timestamp?: string | null
          template_name?: string | null
          tenant_id: string
          updated_at?: string
          wamid: string
        }
        Update: {
          applied_rate_id?: string | null
          applied_rate_source?: string | null
          applied_rate_valid_from?: string | null
          billable?: boolean | null
          booking_id?: string | null
          cost_calculated_at?: string | null
          cost_status?: string
          created_at?: string
          delivered_at?: string | null
          error_code?: string | null
          error_message?: string | null
          estimated_cost?: number | null
          estimated_currency?: string
          failed_at?: string | null
          id?: string
          message_direction?: string
          passenger_id?: string | null
          pricing_category?: string | null
          pricing_model?: string | null
          pricing_type?: string | null
          raw_metadata?: Json
          read_at?: string | null
          recipient_country_code?: string | null
          recipient_phone?: string | null
          sent_at?: string | null
          status?: string
          status_timestamp?: string | null
          template_name?: string | null
          tenant_id?: string
          updated_at?: string
          wamid?: string
        }
        Relationships: [
          {
            foreignKeyName: "whatsapp_message_events_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: false
            referencedRelation: "services"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "whatsapp_message_events_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      whatsapp_message_statuses: {
        Row: {
          billable: boolean | null
          conversation_id: string | null
          created_at: string
          error_code: string | null
          error_message: string | null
          id: string
          pricing_category: string | null
          pricing_model: string | null
          pricing_type: string | null
          raw_status: Json
          recipient_id: string | null
          status: string
          tenant_id: string
          timestamp: string | null
          wa_message_id: string
        }
        Insert: {
          billable?: boolean | null
          conversation_id?: string | null
          created_at?: string
          error_code?: string | null
          error_message?: string | null
          id?: string
          pricing_category?: string | null
          pricing_model?: string | null
          pricing_type?: string | null
          raw_status?: Json
          recipient_id?: string | null
          status: string
          tenant_id: string
          timestamp?: string | null
          wa_message_id: string
        }
        Update: {
          billable?: boolean | null
          conversation_id?: string | null
          created_at?: string
          error_code?: string | null
          error_message?: string | null
          id?: string
          pricing_category?: string | null
          pricing_model?: string | null
          pricing_type?: string | null
          raw_status?: Json
          recipient_id?: string | null
          status?: string
          tenant_id?: string
          timestamp?: string | null
          wa_message_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "whatsapp_message_statuses_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      whatsapp_messages: {
        Row: {
          booking_id: string | null
          contact_id: string | null
          created_at: string
          customer_id: string | null
          direction: string
          id: string
          media_id: string | null
          media_mime_type: string | null
          media_sha256: string | null
          message_type: string | null
          phone_e164: string | null
          raw_message: Json
          reply_to_wa_message_id: string | null
          status: string | null
          template_name: string | null
          tenant_id: string | null
          text_body: string | null
          thread_id: string | null
          timestamp: string | null
          transfer_id: string | null
          updated_at: string
          wa_id: string
          wa_message_id: string | null
        }
        Insert: {
          booking_id?: string | null
          contact_id?: string | null
          created_at?: string
          customer_id?: string | null
          direction: string
          id?: string
          media_id?: string | null
          media_mime_type?: string | null
          media_sha256?: string | null
          message_type?: string | null
          phone_e164?: string | null
          raw_message?: Json
          reply_to_wa_message_id?: string | null
          status?: string | null
          template_name?: string | null
          tenant_id?: string | null
          text_body?: string | null
          thread_id?: string | null
          timestamp?: string | null
          transfer_id?: string | null
          updated_at?: string
          wa_id: string
          wa_message_id?: string | null
        }
        Update: {
          booking_id?: string | null
          contact_id?: string | null
          created_at?: string
          customer_id?: string | null
          direction?: string
          id?: string
          media_id?: string | null
          media_mime_type?: string | null
          media_sha256?: string | null
          message_type?: string | null
          phone_e164?: string | null
          raw_message?: Json
          reply_to_wa_message_id?: string | null
          status?: string | null
          template_name?: string | null
          tenant_id?: string | null
          text_body?: string | null
          thread_id?: string | null
          timestamp?: string | null
          transfer_id?: string | null
          updated_at?: string
          wa_id?: string
          wa_message_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "whatsapp_messages_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: false
            referencedRelation: "services"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "whatsapp_messages_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "whatsapp_contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "whatsapp_messages_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "whatsapp_messages_thread_id_fkey"
            columns: ["thread_id"]
            isOneToOne: false
            referencedRelation: "whatsapp_threads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "whatsapp_messages_transfer_id_fkey"
            columns: ["transfer_id"]
            isOneToOne: false
            referencedRelation: "services"
            referencedColumns: ["id"]
          },
        ]
      }
      whatsapp_pricing_rates: {
        Row: {
          country_code: string
          created_at: string
          currency: string
          id: string
          is_confirmed: boolean
          pricing_category: string
          pricing_model: string | null
          pricing_type: string | null
          source: string
          tenant_id: string
          unit_price: number
          updated_at: string
          valid_from: string
          valid_to: string | null
        }
        Insert: {
          country_code: string
          created_at?: string
          currency?: string
          id?: string
          is_confirmed?: boolean
          pricing_category: string
          pricing_model?: string | null
          pricing_type?: string | null
          source?: string
          tenant_id: string
          unit_price: number
          updated_at?: string
          valid_from: string
          valid_to?: string | null
        }
        Update: {
          country_code?: string
          created_at?: string
          currency?: string
          id?: string
          is_confirmed?: boolean
          pricing_category?: string
          pricing_model?: string | null
          pricing_type?: string | null
          source?: string
          tenant_id?: string
          unit_price?: number
          updated_at?: string
          valid_from?: string
          valid_to?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "whatsapp_pricing_rates_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      whatsapp_templates: {
        Row: {
          body_parameter_count: number
          body_text: string | null
          category: string | null
          created_at: string
          header_format: string | null
          id: string
          language_code: string
          meta_template_id: string
          name: string
          raw_json: Json
          status: string
          synced_at: string
          tenant_id: string
          updated_at: string
        }
        Insert: {
          body_parameter_count?: number
          body_text?: string | null
          category?: string | null
          created_at?: string
          header_format?: string | null
          id?: string
          language_code: string
          meta_template_id: string
          name: string
          raw_json?: Json
          status: string
          synced_at?: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          body_parameter_count?: number
          body_text?: string | null
          category?: string | null
          created_at?: string
          header_format?: string | null
          id?: string
          language_code?: string
          meta_template_id?: string
          name?: string
          raw_json?: Json
          status?: string
          synced_at?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "whatsapp_templates_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      whatsapp_threads: {
        Row: {
          assigned_to: string | null
          booking_id: string | null
          contact_id: string | null
          created_at: string
          customer_id: string | null
          id: string
          last_message_at: string | null
          last_message_preview: string | null
          match_status: string
          match_suggestions: Json
          phone_e164: string | null
          status: string
          tenant_id: string | null
          transfer_id: string | null
          unread_count: number
          updated_at: string
          wa_id: string
        }
        Insert: {
          assigned_to?: string | null
          booking_id?: string | null
          contact_id?: string | null
          created_at?: string
          customer_id?: string | null
          id?: string
          last_message_at?: string | null
          last_message_preview?: string | null
          match_status?: string
          match_suggestions?: Json
          phone_e164?: string | null
          status?: string
          tenant_id?: string | null
          transfer_id?: string | null
          unread_count?: number
          updated_at?: string
          wa_id: string
        }
        Update: {
          assigned_to?: string | null
          booking_id?: string | null
          contact_id?: string | null
          created_at?: string
          customer_id?: string | null
          id?: string
          last_message_at?: string | null
          last_message_preview?: string | null
          match_status?: string
          match_suggestions?: Json
          phone_e164?: string | null
          status?: string
          tenant_id?: string | null
          transfer_id?: string | null
          unread_count?: number
          updated_at?: string
          wa_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "whatsapp_threads_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: false
            referencedRelation: "services"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "whatsapp_threads_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "whatsapp_contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "whatsapp_threads_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "whatsapp_threads_transfer_id_fkey"
            columns: ["transfer_id"]
            isOneToOne: false
            referencedRelation: "services"
            referencedColumns: ["id"]
          },
        ]
      }
      whatsapp_webhook_events: {
        Row: {
          dedupe_key: string | null
          event_type: string | null
          id: string
          object: string | null
          processed_at: string | null
          processing_error: string | null
          provider: string
          raw_payload: Json
          received_at: string
          signature_valid: boolean
          tenant_id: string | null
        }
        Insert: {
          dedupe_key?: string | null
          event_type?: string | null
          id?: string
          object?: string | null
          processed_at?: string | null
          processing_error?: string | null
          provider?: string
          raw_payload: Json
          received_at?: string
          signature_valid?: boolean
          tenant_id?: string | null
        }
        Update: {
          dedupe_key?: string | null
          event_type?: string | null
          id?: string
          object?: string | null
          processed_at?: string | null
          processing_error?: string | null
          provider?: string
          raw_payload?: Json
          received_at?: string
          signature_valid?: boolean
          tenant_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "whatsapp_webhook_events_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      ops_bus_allocation_details: {
        Row: {
          agency_name: string | null
          allocation_id: string | null
          bus_label: string | null
          bus_line_id: string | null
          bus_unit_id: string | null
          created_at: string | null
          customer_name: string | null
          customer_phone: string | null
          direction: Database["public"]["Enums"]["service_direction"] | null
          driver_name: string | null
          driver_phone: string | null
          family_code: string | null
          family_name: string | null
          hotel_id: string | null
          hotel_name: string | null
          hotel_pickup_time: string | null
          line_code: string | null
          line_name: string | null
          notes: string | null
          pax_assigned: number | null
          root_allocation_id: string | null
          service_date: string | null
          service_id: string | null
          service_time: string | null
          split_from_allocation_id: string | null
          stop_city: string | null
          stop_id: string | null
          stop_name: string | null
          stop_pickup_note: string | null
          stop_pickup_time: string | null
          tenant_id: string | null
        }
        Relationships: [
          {
            foreignKeyName: "services_hotel_id_fkey"
            columns: ["hotel_id"]
            isOneToOne: false
            referencedRelation: "hotels"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tenant_bus_allocations_bus_line_id_fkey"
            columns: ["bus_line_id"]
            isOneToOne: false
            referencedRelation: "tenant_bus_lines"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tenant_bus_allocations_bus_unit_id_fkey"
            columns: ["bus_unit_id"]
            isOneToOne: false
            referencedRelation: "tenant_bus_units"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tenant_bus_allocations_service_id_fkey"
            columns: ["service_id"]
            isOneToOne: false
            referencedRelation: "services"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tenant_bus_allocations_split_from_allocation_id_fkey"
            columns: ["split_from_allocation_id"]
            isOneToOne: false
            referencedRelation: "ops_bus_allocation_details"
            referencedColumns: ["allocation_id"]
          },
          {
            foreignKeyName: "tenant_bus_allocations_split_from_allocation_id_fkey"
            columns: ["split_from_allocation_id"]
            isOneToOne: false
            referencedRelation: "tenant_bus_allocations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tenant_bus_allocations_stop_id_fkey"
            columns: ["stop_id"]
            isOneToOne: false
            referencedRelation: "tenant_bus_line_stops"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tenant_bus_allocations_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Functions: {
      acquire_email_import_lock: {
        Args: {
          p_cooldown_seconds: number
          p_force?: boolean
          p_mailbox: string
          p_tenant_id: string
          p_ttl_seconds: number
        }
        Returns: {
          acquired: boolean
          last_success_at: string
          lock_expires_at: string
          reason: string
        }[]
      }
      acquire_medmar_service_issuance_locks: {
        Args: {
          p_holder?: string
          p_service_ids: string[]
          p_tenant_id: string
          p_ttl_seconds: number
        }
        Returns: {
          acquired: boolean
          conflicting_service_ids: string[]
          expires_at: string
          lock_token: string
        }[]
      }
      allocate_bus_service: {
        Args: {
          p_bus_line_id: string
          p_bus_unit_id: string
          p_created_by_user_id: string
          p_direction: Database["public"]["Enums"]["service_direction"]
          p_notes: string
          p_pax_assigned: number
          p_service_id: string
          p_stop_id: string
          p_stop_name: string
          p_tenant_id: string
        }
        Returns: Json
      }
      apply_cancellation_penalty: {
        Args: {
          p_amount_cents: number
          p_base_amount_cents?: number
          p_base_amount_source?: string
          p_confirm_rectification?: boolean
          p_expected_active_ids?: string[]
          p_idempotency_key?: string
          p_notes?: string
          p_penalty_type: string
          p_percentage?: number
          p_scope: string
          p_service_id: string
          p_tenant_id: string
          p_user_id?: string
          p_user_name?: string
          p_user_role?: string
        }
        Returns: {
          out_email_kind: string
          out_email_status: string
          penalty_id: string
          previous_communicated: boolean
          replayed: boolean
          superseded_ids: string[]
        }[]
      }
      cancel_service_practice: {
        Args: {
          p_note?: string
          p_reason: string
          p_scope: string
          p_service_id: string
          p_tenant_id: string
          p_user_id?: string
        }
        Returns: {
          assignments_cleared: number
          bus_allocations_cleared: number
          out_service_id: string
        }[]
      }
      current_agency_id: { Args: never; Returns: string }
      current_tenant_id: { Args: never; Returns: string }
      current_user_role: {
        Args: never
        Returns: Database["public"]["Enums"]["app_role"]
      }
      delete_shuttle_schedule: {
        Args: {
          p_old_booking_service_kind: string
          p_old_customer_name: string
          p_old_departure_time: string
          p_old_direction: string
          p_old_hotel_id: string
          p_old_meeting_point: string
          p_old_vessel: string
          p_tenant_id: string
          p_today: string
        }
        Returns: {
          deleted_count: number
          deleted_date_from: string
          deleted_date_to: string
          deleted_weekdays: number[]
        }[]
      }
      finalize_cancellation_request: {
        Args: {
          p_agency_counter_cents?: number
          p_agency_response?: string
          p_agency_response_note?: string
          p_penalty_cents?: number
          p_penalty_note?: string
          p_request_id: string
          p_status?: string
          p_tenant_id: string
          p_user_id?: string
        }
        Returns: {
          assignments_cleared: number
          service_id: string
        }[]
      }
      has_capability: { Args: { cap: string }; Returns: boolean }
      increment_pickup_run_pax: {
        Args: { p_delta: number; p_run_id: string }
        Returns: undefined
      }
      is_admin: { Args: never; Returns: boolean }
      is_agency: { Args: never; Returns: boolean }
      is_driver: { Args: never; Returns: boolean }
      is_driver_assigned_service: {
        Args: { target_service_id: string }
        Returns: boolean
      }
      is_operator: { Args: never; Returns: boolean }
      move_bus_allocation: {
        Args: {
          p_allocation_id: string
          p_created_by_user_id: string
          p_pax_moved: number
          p_reason: string
          p_tenant_id: string
          p_to_bus_unit_id: string
        }
        Returns: Json
      }
      next_booking_practice_number: {
        Args: { p_tenant_id: string }
        Returns: string
      }
      next_quote_number: { Args: { p_tenant_id: string }; Returns: string }
      patch_shuttle_schedule: {
        Args: {
          p_new_rows: Json
          p_old_booking_service_kind: string
          p_old_customer_name: string
          p_old_departure_time: string
          p_old_direction: string
          p_old_hotel_id: string
          p_old_meeting_point: string
          p_old_vessel: string
          p_tenant_id: string
          p_today: string
        }
        Returns: {
          deleted_count: number
          deleted_date_from: string
          deleted_date_to: string
          deleted_weekdays: number[]
          inserted_count: number
        }[]
      }
      release_email_import_lock: {
        Args: {
          p_error?: string
          p_mailbox: string
          p_success: boolean
          p_tenant_id: string
        }
        Returns: undefined
      }
      release_medmar_service_issuance_locks: {
        Args: { p_lock_token: string; p_tenant_id: string }
        Returns: number
      }
      reorder_bus_line_stops: {
        Args: {
          p_bus_line_id: string
          p_direction: Database["public"]["Enums"]["service_direction"]
          p_stop_ids: string[]
          p_tenant_id: string
        }
        Returns: Json
      }
      restore_cancelled_service: {
        Args: {
          p_penalty_action?: string
          p_scope: string
          p_service_id: string
          p_tenant_id: string
          p_user_id?: string
          p_user_name?: string
          p_void_reason?: string
        }
        Returns: {
          kept_penalty_ids: string[]
          new_status: string
          out_service_id: string
          previous_status: string
          stale_assignments_cleared: number
          stale_bus_allocations_cleared: number
          voided_penalty_ids: string[]
        }[]
      }
      unaccent: { Args: { "": string }; Returns: string }
      vehicle_document_object_authorized: {
        Args: { object_name: string }
        Returns: boolean
      }
    }
    Enums: {
      app_role: "admin" | "operator" | "driver" | "agency" | "supervisor"
      booking_qr_direction: "outbound" | "return"
      booking_qr_status: "active" | "used" | "cancelled"
      hotel_geo_accuracy: "unknown" | "area" | "street" | "rooftop"
      hotel_geo_source: "manual" | "google" | "nominatim" | "import" | "unknown"
      hotel_geo_status: "missing" | "generic" | "approximate" | "verified"
      import_source_kind:
        | "email_body"
        | "email_attachment_pdf"
        | "email_attachment_other"
        | "manual"
      import_status: "pending" | "parsed" | "matched" | "failed"
      match_status: "unmatched" | "matched" | "needs_review" | "ignored"
      pricing_apply_mode: "manual" | "auto_rule" | "fallback"
      pricing_match_quality: "certain" | "partial" | "review"
      pricing_rule_kind: "fixed" | "per_pax"
      route_point_type: "port" | "hotel" | "address" | "custom"
      service_direction: "arrival" | "departure"
      service_status:
        | "new"
        | "assigned"
        | "partito"
        | "arrivato"
        | "completato"
        | "cancelled"
        | "problema"
        | "needs_review"
        | "pending_cancellation"
        | "caricato"
        | "scaricato"
      service_type: "transfer" | "bus_tour"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      app_role: ["admin", "operator", "driver", "agency", "supervisor"],
      booking_qr_direction: ["outbound", "return"],
      booking_qr_status: ["active", "used", "cancelled"],
      hotel_geo_accuracy: ["unknown", "area", "street", "rooftop"],
      hotel_geo_source: ["manual", "google", "nominatim", "import", "unknown"],
      hotel_geo_status: ["missing", "generic", "approximate", "verified"],
      import_source_kind: [
        "email_body",
        "email_attachment_pdf",
        "email_attachment_other",
        "manual",
      ],
      import_status: ["pending", "parsed", "matched", "failed"],
      match_status: ["unmatched", "matched", "needs_review", "ignored"],
      pricing_apply_mode: ["manual", "auto_rule", "fallback"],
      pricing_match_quality: ["certain", "partial", "review"],
      pricing_rule_kind: ["fixed", "per_pax"],
      route_point_type: ["port", "hotel", "address", "custom"],
      service_direction: ["arrival", "departure"],
      service_status: [
        "new",
        "assigned",
        "partito",
        "arrivato",
        "completato",
        "cancelled",
        "problema",
        "needs_review",
        "pending_cancellation",
        "caricato",
        "scaricato",
      ],
      service_type: ["transfer", "bus_tour"],
    },
  },
} as const
