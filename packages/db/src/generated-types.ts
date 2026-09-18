export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  public: {
    Tables: {
      audit_logs: {
        Row: {
          action: string
          actor_name_snapshot: string
          actor_role: Database["public"]["Enums"]["officer_role"] | null
          actor_type: Database["public"]["Enums"]["audit_actor_type"]
          actor_user_id: string | null
          after_state: Json | null
          before_state: Json | null
          community_id: string | null
          created_at: string
          id: string
          ip: unknown
          object_id: string | null
          object_type: string
          officer_term_id: string | null
          reason: string | null
          user_agent: string | null
        }
        Insert: {
          action: string
          actor_name_snapshot: string
          actor_role?: Database["public"]["Enums"]["officer_role"] | null
          actor_type: Database["public"]["Enums"]["audit_actor_type"]
          actor_user_id?: string | null
          after_state?: Json | null
          before_state?: Json | null
          community_id?: string | null
          created_at?: string
          id?: string
          ip?: unknown
          object_id?: string | null
          object_type: string
          officer_term_id?: string | null
          reason?: string | null
          user_agent?: string | null
        }
        Update: {
          action?: string
          actor_name_snapshot?: string
          actor_role?: Database["public"]["Enums"]["officer_role"] | null
          actor_type?: Database["public"]["Enums"]["audit_actor_type"]
          actor_user_id?: string | null
          after_state?: Json | null
          before_state?: Json | null
          community_id?: string | null
          created_at?: string
          id?: string
          ip?: unknown
          object_id?: string | null
          object_type?: string
          officer_term_id?: string | null
          reason?: string | null
          user_agent?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "audit_logs_actor_user_id_fkey"
            columns: ["actor_user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "audit_logs_community_id_fkey"
            columns: ["community_id"]
            isOneToOne: false
            referencedRelation: "communities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "audit_logs_officer_term_id_fkey"
            columns: ["officer_term_id"]
            isOneToOne: false
            referencedRelation: "officer_terms"
            referencedColumns: ["id"]
          },
        ]
      }
      collection_code_settings: {
        Row: {
          attribute_basis: string | null
          collection_id: string
          community_id: string
          created_at: string
          next_number: number
          per_unit: boolean
          prefix: string | null
          style: Database["public"]["Enums"]["code_style"]
          updated_at: string
        }
        Insert: {
          attribute_basis?: string | null
          collection_id: string
          community_id: string
          created_at?: string
          next_number?: number
          per_unit?: boolean
          prefix?: string | null
          style?: Database["public"]["Enums"]["code_style"]
          updated_at?: string
        }
        Update: {
          attribute_basis?: string | null
          collection_id?: string
          community_id?: string
          created_at?: string
          next_number?: number
          per_unit?: boolean
          prefix?: string | null
          style?: Database["public"]["Enums"]["code_style"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "collection_code_settings_collection_id_fkey"
            columns: ["collection_id"]
            isOneToOne: true
            referencedRelation: "collections"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "collection_code_settings_community_id_fkey"
            columns: ["community_id"]
            isOneToOne: false
            referencedRelation: "communities"
            referencedColumns: ["id"]
          },
        ]
      }
      collection_fields: {
        Row: {
          collection_id: string
          community_id: string
          created_at: string
          id: string
          key: string
          label: string
          options: string[] | null
          required: boolean
          sort_order: number
          type: Database["public"]["Enums"]["member_attribute_type"]
        }
        Insert: {
          collection_id: string
          community_id: string
          created_at?: string
          id?: string
          key: string
          label: string
          options?: string[] | null
          required?: boolean
          sort_order?: number
          type: Database["public"]["Enums"]["member_attribute_type"]
        }
        Update: {
          collection_id?: string
          community_id?: string
          created_at?: string
          id?: string
          key?: string
          label?: string
          options?: string[] | null
          required?: boolean
          sort_order?: number
          type?: Database["public"]["Enums"]["member_attribute_type"]
        }
        Relationships: [
          {
            foreignKeyName: "collection_fields_collection_id_fkey"
            columns: ["collection_id"]
            isOneToOne: false
            referencedRelation: "collections"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "collection_fields_community_id_fkey"
            columns: ["community_id"]
            isOneToOne: false
            referencedRelation: "communities"
            referencedColumns: ["id"]
          },
        ]
      }
      collection_tiers: {
        Row: {
          code_prefix: string | null
          collection_id: string
          community_id: string
          created_at: string
          description: string | null
          hidden: boolean
          id: string
          name: string
          per_order_limit: number | null
          price_kobo: number
          quantity_limit: number | null
          sort_order: number
          updated_at: string
        }
        Insert: {
          code_prefix?: string | null
          collection_id: string
          community_id: string
          created_at?: string
          description?: string | null
          hidden?: boolean
          id?: string
          name: string
          per_order_limit?: number | null
          price_kobo: number
          quantity_limit?: number | null
          sort_order?: number
          updated_at?: string
        }
        Update: {
          code_prefix?: string | null
          collection_id?: string
          community_id?: string
          created_at?: string
          description?: string | null
          hidden?: boolean
          id?: string
          name?: string
          per_order_limit?: number | null
          price_kobo?: number
          quantity_limit?: number | null
          sort_order?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "collection_tiers_collection_id_fkey"
            columns: ["collection_id"]
            isOneToOne: false
            referencedRelation: "collections"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "collection_tiers_community_id_fkey"
            columns: ["community_id"]
            isOneToOne: false
            referencedRelation: "communities"
            referencedColumns: ["id"]
          },
        ]
      }
      collections: {
        Row: {
          allow_anonymous: boolean
          allow_non_members: boolean
          amount_model: Database["public"]["Enums"]["amount_model"]
          archived_at: string | null
          category: Database["public"]["Enums"]["collection_category"]
          closed_at: string | null
          codes_enabled: boolean
          community_id: string
          cover_image_url: string | null
          created_at: string
          created_by: string
          deadline_at: string | null
          description: string | null
          display_options: Json
          fee_mode: Database["public"]["Enums"]["fee_mode"]
          fixed_amount_kobo: number | null
          id: string
          import_run_id: string | null
          imported_at: string | null
          is_imported: boolean
          max_amount_kobo: number | null
          min_amount_kobo: number | null
          name: string
          participation_mode: Database["public"]["Enums"]["participation_mode"]
          payment_plan: Database["public"]["Enums"]["payment_plan"]
          published_at: string | null
          published_by: string | null
          schedule: Database["public"]["Enums"]["collection_schedule"]
          slug: string
          source_id: string | null
          source_system: string | null
          source_table: string | null
          starts_at: string | null
          status: Database["public"]["Enums"]["collection_status"]
          target_amount_kobo: number | null
          thank_you_message: string | null
          updated_at: string
          visibility: Database["public"]["Enums"]["collection_visibility"]
        }
        Insert: {
          allow_anonymous?: boolean
          allow_non_members?: boolean
          amount_model: Database["public"]["Enums"]["amount_model"]
          archived_at?: string | null
          category: Database["public"]["Enums"]["collection_category"]
          closed_at?: string | null
          codes_enabled?: boolean
          community_id: string
          cover_image_url?: string | null
          created_at?: string
          created_by: string
          deadline_at?: string | null
          description?: string | null
          display_options?: Json
          fee_mode?: Database["public"]["Enums"]["fee_mode"]
          fixed_amount_kobo?: number | null
          id?: string
          import_run_id?: string | null
          imported_at?: string | null
          is_imported?: boolean
          max_amount_kobo?: number | null
          min_amount_kobo?: number | null
          name: string
          participation_mode: Database["public"]["Enums"]["participation_mode"]
          payment_plan?: Database["public"]["Enums"]["payment_plan"]
          published_at?: string | null
          published_by?: string | null
          schedule?: Database["public"]["Enums"]["collection_schedule"]
          slug: string
          source_id?: string | null
          source_system?: string | null
          source_table?: string | null
          starts_at?: string | null
          status?: Database["public"]["Enums"]["collection_status"]
          target_amount_kobo?: number | null
          thank_you_message?: string | null
          updated_at?: string
          visibility?: Database["public"]["Enums"]["collection_visibility"]
        }
        Update: {
          allow_anonymous?: boolean
          allow_non_members?: boolean
          amount_model?: Database["public"]["Enums"]["amount_model"]
          archived_at?: string | null
          category?: Database["public"]["Enums"]["collection_category"]
          closed_at?: string | null
          codes_enabled?: boolean
          community_id?: string
          cover_image_url?: string | null
          created_at?: string
          created_by?: string
          deadline_at?: string | null
          description?: string | null
          display_options?: Json
          fee_mode?: Database["public"]["Enums"]["fee_mode"]
          fixed_amount_kobo?: number | null
          id?: string
          import_run_id?: string | null
          imported_at?: string | null
          is_imported?: boolean
          max_amount_kobo?: number | null
          min_amount_kobo?: number | null
          name?: string
          participation_mode?: Database["public"]["Enums"]["participation_mode"]
          payment_plan?: Database["public"]["Enums"]["payment_plan"]
          published_at?: string | null
          published_by?: string | null
          schedule?: Database["public"]["Enums"]["collection_schedule"]
          slug?: string
          source_id?: string | null
          source_system?: string | null
          source_table?: string | null
          starts_at?: string | null
          status?: Database["public"]["Enums"]["collection_status"]
          target_amount_kobo?: number | null
          thank_you_message?: string | null
          updated_at?: string
          visibility?: Database["public"]["Enums"]["collection_visibility"]
        }
        Relationships: [
          {
            foreignKeyName: "collections_community_id_fkey"
            columns: ["community_id"]
            isOneToOne: false
            referencedRelation: "communities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "collections_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "collections_published_by_fkey"
            columns: ["published_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      communities: {
        Row: {
          archived_at: string | null
          contact_email: string | null
          contact_phone_e164: string | null
          contact_verified_at: string | null
          created_at: string
          created_by: string
          default_fee_mode: Database["public"]["Enums"]["fee_mode"]
          description: string | null
          id: string
          institution: string | null
          is_personal: boolean
          location_city: string | null
          location_state: string | null
          logo_url: string | null
          name: string
          show_officers_publicly: boolean
          slug: string
          status: Database["public"]["Enums"]["community_status"]
          term_length_months: number | null
          type: Database["public"]["Enums"]["community_type"]
          updated_at: string
          verification_status: Database["public"]["Enums"]["verification_status"]
          verified_at: string | null
        }
        Insert: {
          archived_at?: string | null
          contact_email?: string | null
          contact_phone_e164?: string | null
          contact_verified_at?: string | null
          created_at?: string
          created_by: string
          default_fee_mode?: Database["public"]["Enums"]["fee_mode"]
          description?: string | null
          id?: string
          institution?: string | null
          is_personal?: boolean
          location_city?: string | null
          location_state?: string | null
          logo_url?: string | null
          name: string
          show_officers_publicly?: boolean
          slug: string
          status?: Database["public"]["Enums"]["community_status"]
          term_length_months?: number | null
          type: Database["public"]["Enums"]["community_type"]
          updated_at?: string
          verification_status?: Database["public"]["Enums"]["verification_status"]
          verified_at?: string | null
        }
        Update: {
          archived_at?: string | null
          contact_email?: string | null
          contact_phone_e164?: string | null
          contact_verified_at?: string | null
          created_at?: string
          created_by?: string
          default_fee_mode?: Database["public"]["Enums"]["fee_mode"]
          description?: string | null
          id?: string
          institution?: string | null
          is_personal?: boolean
          location_city?: string | null
          location_state?: string | null
          logo_url?: string | null
          name?: string
          show_officers_publicly?: boolean
          slug?: string
          status?: Database["public"]["Enums"]["community_status"]
          term_length_months?: number | null
          type?: Database["public"]["Enums"]["community_type"]
          updated_at?: string
          verification_status?: Database["public"]["Enums"]["verification_status"]
          verified_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "communities_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      community_labels: {
        Row: {
          community_id: string
          key: string
          label: string
        }
        Insert: {
          community_id: string
          key: string
          label: string
        }
        Update: {
          community_id?: string
          key?: string
          label?: string
        }
        Relationships: [
          {
            foreignKeyName: "community_labels_community_id_fkey"
            columns: ["community_id"]
            isOneToOne: false
            referencedRelation: "communities"
            referencedColumns: ["id"]
          },
        ]
      }
      community_slug_history: {
        Row: {
          community_id: string
          id: string
          released_at: string
          slug: string
        }
        Insert: {
          community_id: string
          id?: string
          released_at?: string
          slug: string
        }
        Update: {
          community_id?: string
          id?: string
          released_at?: string
          slug?: string
        }
        Relationships: [
          {
            foreignKeyName: "community_slug_history_community_id_fkey"
            columns: ["community_id"]
            isOneToOne: false
            referencedRelation: "communities"
            referencedColumns: ["id"]
          },
        ]
      }
      invite_links: {
        Row: {
          allow_group_choice: boolean
          allow_multi_group: boolean
          approve_joiners: boolean
          community_id: string
          created_at: string
          created_by: string
          expires_at: string | null
          group_ids: string[]
          id: string
          label: string | null
          max_uses: number | null
          revoked_at: string | null
          status: Database["public"]["Enums"]["invite_status"]
          token_hash: string
          token_prefix: string
          updated_at: string
          uses: number
        }
        Insert: {
          allow_group_choice?: boolean
          allow_multi_group?: boolean
          approve_joiners?: boolean
          community_id: string
          created_at?: string
          created_by: string
          expires_at?: string | null
          group_ids?: string[]
          id?: string
          label?: string | null
          max_uses?: number | null
          revoked_at?: string | null
          status?: Database["public"]["Enums"]["invite_status"]
          token_hash: string
          token_prefix: string
          updated_at?: string
          uses?: number
        }
        Update: {
          allow_group_choice?: boolean
          allow_multi_group?: boolean
          approve_joiners?: boolean
          community_id?: string
          created_at?: string
          created_by?: string
          expires_at?: string | null
          group_ids?: string[]
          id?: string
          label?: string | null
          max_uses?: number | null
          revoked_at?: string | null
          status?: Database["public"]["Enums"]["invite_status"]
          token_hash?: string
          token_prefix?: string
          updated_at?: string
          uses?: number
        }
        Relationships: [
          {
            foreignKeyName: "invite_links_community_id_fkey"
            columns: ["community_id"]
            isOneToOne: false
            referencedRelation: "communities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invite_links_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      leadership_terms: {
        Row: {
          community_id: string
          created_at: string
          ends_on: string | null
          id: string
          name: string
          starts_on: string
        }
        Insert: {
          community_id: string
          created_at?: string
          ends_on?: string | null
          id?: string
          name: string
          starts_on: string
        }
        Update: {
          community_id?: string
          created_at?: string
          ends_on?: string | null
          id?: string
          name?: string
          starts_on?: string
        }
        Relationships: [
          {
            foreignKeyName: "leadership_terms_community_id_fkey"
            columns: ["community_id"]
            isOneToOne: false
            referencedRelation: "communities"
            referencedColumns: ["id"]
          },
        ]
      }
      legacy_links: {
        Row: {
          collection_id: string | null
          created_at: string
          created_by: string | null
          id: string
          kind: Database["public"]["Enums"]["legacy_link_kind"]
          new_path: string
          notes: string | null
          old_path: string
          updated_at: string
        }
        Insert: {
          collection_id?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          kind: Database["public"]["Enums"]["legacy_link_kind"]
          new_path: string
          notes?: string | null
          old_path: string
          updated_at?: string
        }
        Update: {
          collection_id?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          kind?: Database["public"]["Enums"]["legacy_link_kind"]
          new_path?: string
          notes?: string | null
          old_path?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "legacy_links_collection_id_fkey"
            columns: ["collection_id"]
            isOneToOne: false
            referencedRelation: "collections"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "legacy_links_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      member_attribute_definitions: {
        Row: {
          community_id: string
          created_at: string
          id: string
          key: string
          label: string
          options: string[] | null
          required_at_join: boolean
          sort_order: number
          type: Database["public"]["Enums"]["member_attribute_type"]
        }
        Insert: {
          community_id: string
          created_at?: string
          id?: string
          key: string
          label: string
          options?: string[] | null
          required_at_join?: boolean
          sort_order?: number
          type: Database["public"]["Enums"]["member_attribute_type"]
        }
        Update: {
          community_id?: string
          created_at?: string
          id?: string
          key?: string
          label?: string
          options?: string[] | null
          required_at_join?: boolean
          sort_order?: number
          type?: Database["public"]["Enums"]["member_attribute_type"]
        }
        Relationships: [
          {
            foreignKeyName: "member_attribute_definitions_community_id_fkey"
            columns: ["community_id"]
            isOneToOne: false
            referencedRelation: "communities"
            referencedColumns: ["id"]
          },
        ]
      }
      member_contacts: {
        Row: {
          community_id: string
          created_at: string
          email: string | null
          id: string
          member_id: string
          name: string
          phone_e164: string | null
          receives_notices: boolean
          relation: string | null
          updated_at: string
        }
        Insert: {
          community_id: string
          created_at?: string
          email?: string | null
          id?: string
          member_id: string
          name: string
          phone_e164?: string | null
          receives_notices?: boolean
          relation?: string | null
          updated_at?: string
        }
        Update: {
          community_id?: string
          created_at?: string
          email?: string | null
          id?: string
          member_id?: string
          name?: string
          phone_e164?: string | null
          receives_notices?: boolean
          relation?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "member_contacts_community_id_fkey"
            columns: ["community_id"]
            isOneToOne: false
            referencedRelation: "communities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "member_contacts_member_id_fkey"
            columns: ["member_id"]
            isOneToOne: false
            referencedRelation: "members"
            referencedColumns: ["id"]
          },
        ]
      }
      member_group_memberships: {
        Row: {
          added_at: string
          added_by: string | null
          group_id: string
          member_id: string
        }
        Insert: {
          added_at?: string
          added_by?: string | null
          group_id: string
          member_id: string
        }
        Update: {
          added_at?: string
          added_by?: string | null
          group_id?: string
          member_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "member_group_memberships_added_by_fkey"
            columns: ["added_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "member_group_memberships_group_id_fkey"
            columns: ["group_id"]
            isOneToOne: false
            referencedRelation: "member_groups"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "member_group_memberships_member_id_fkey"
            columns: ["member_id"]
            isOneToOne: false
            referencedRelation: "members"
            referencedColumns: ["id"]
          },
        ]
      }
      member_groups: {
        Row: {
          community_id: string
          created_at: string
          created_by: string | null
          description: string | null
          id: string
          name: string
          pickable_at_join: boolean
          sort_order: number
          updated_at: string
        }
        Insert: {
          community_id: string
          created_at?: string
          created_by?: string | null
          description?: string | null
          id?: string
          name: string
          pickable_at_join?: boolean
          sort_order?: number
          updated_at?: string
        }
        Update: {
          community_id?: string
          created_at?: string
          created_by?: string | null
          description?: string | null
          id?: string
          name?: string
          pickable_at_join?: boolean
          sort_order?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "member_groups_community_id_fkey"
            columns: ["community_id"]
            isOneToOne: false
            referencedRelation: "communities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "member_groups_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      members: {
        Row: {
          archived_at: string | null
          attributes: Json
          claimed_at: string | null
          community_id: string
          consent_messages_at: string | null
          created_at: string
          created_by: string | null
          email: string | null
          full_name: string
          id: string
          identifier: string | null
          import_run_id: string | null
          imported_at: string | null
          invite_link_id: string | null
          is_entity: boolean
          is_imported: boolean
          joined_via: Database["public"]["Enums"]["member_joined_via"]
          merged_at: string | null
          merged_into_id: string | null
          phone_e164: string | null
          source_id: string | null
          source_system: string | null
          source_table: string | null
          status: Database["public"]["Enums"]["member_status"]
          updated_at: string
          user_id: string | null
        }
        Insert: {
          archived_at?: string | null
          attributes?: Json
          claimed_at?: string | null
          community_id: string
          consent_messages_at?: string | null
          created_at?: string
          created_by?: string | null
          email?: string | null
          full_name: string
          id?: string
          identifier?: string | null
          import_run_id?: string | null
          imported_at?: string | null
          invite_link_id?: string | null
          is_entity?: boolean
          is_imported?: boolean
          joined_via?: Database["public"]["Enums"]["member_joined_via"]
          merged_at?: string | null
          merged_into_id?: string | null
          phone_e164?: string | null
          source_id?: string | null
          source_system?: string | null
          source_table?: string | null
          status?: Database["public"]["Enums"]["member_status"]
          updated_at?: string
          user_id?: string | null
        }
        Update: {
          archived_at?: string | null
          attributes?: Json
          claimed_at?: string | null
          community_id?: string
          consent_messages_at?: string | null
          created_at?: string
          created_by?: string | null
          email?: string | null
          full_name?: string
          id?: string
          identifier?: string | null
          import_run_id?: string | null
          imported_at?: string | null
          invite_link_id?: string | null
          is_entity?: boolean
          is_imported?: boolean
          joined_via?: Database["public"]["Enums"]["member_joined_via"]
          merged_at?: string | null
          merged_into_id?: string | null
          phone_e164?: string | null
          source_id?: string | null
          source_system?: string | null
          source_table?: string | null
          status?: Database["public"]["Enums"]["member_status"]
          updated_at?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "members_community_id_fkey"
            columns: ["community_id"]
            isOneToOne: false
            referencedRelation: "communities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "members_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "members_invite_link_fkey"
            columns: ["invite_link_id"]
            isOneToOne: false
            referencedRelation: "invite_links"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "members_merged_into_id_fkey"
            columns: ["merged_into_id"]
            isOneToOne: false
            referencedRelation: "members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "members_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      obligations: {
        Row: {
          assigned_by: string | null
          cancelled_at: string | null
          collection_id: string
          community_id: string
          created_at: string
          cycle_key: string | null
          due_at: string | null
          exempt: boolean
          exempt_at: string | null
          exempt_by: string | null
          exempt_reason: string | null
          expected_amount_kobo: number
          id: string
          link_token_hash: string | null
          link_token_prefix: string | null
          member_id: string
          status: Database["public"]["Enums"]["obligation_status"]
          updated_at: string
          version: number
          waived_amount_kobo: number
          waived_at: string | null
          waived_by: string | null
          waived_reason: string | null
        }
        Insert: {
          assigned_by?: string | null
          cancelled_at?: string | null
          collection_id: string
          community_id: string
          created_at?: string
          cycle_key?: string | null
          due_at?: string | null
          exempt?: boolean
          exempt_at?: string | null
          exempt_by?: string | null
          exempt_reason?: string | null
          expected_amount_kobo: number
          id?: string
          link_token_hash?: string | null
          link_token_prefix?: string | null
          member_id: string
          status?: Database["public"]["Enums"]["obligation_status"]
          updated_at?: string
          version?: number
          waived_amount_kobo?: number
          waived_at?: string | null
          waived_by?: string | null
          waived_reason?: string | null
        }
        Update: {
          assigned_by?: string | null
          cancelled_at?: string | null
          collection_id?: string
          community_id?: string
          created_at?: string
          cycle_key?: string | null
          due_at?: string | null
          exempt?: boolean
          exempt_at?: string | null
          exempt_by?: string | null
          exempt_reason?: string | null
          expected_amount_kobo?: number
          id?: string
          link_token_hash?: string | null
          link_token_prefix?: string | null
          member_id?: string
          status?: Database["public"]["Enums"]["obligation_status"]
          updated_at?: string
          version?: number
          waived_amount_kobo?: number
          waived_at?: string | null
          waived_by?: string | null
          waived_reason?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "obligations_assigned_by_fkey"
            columns: ["assigned_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "obligations_collection_id_fkey"
            columns: ["collection_id"]
            isOneToOne: false
            referencedRelation: "collections"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "obligations_community_id_fkey"
            columns: ["community_id"]
            isOneToOne: false
            referencedRelation: "communities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "obligations_exempt_by_fkey"
            columns: ["exempt_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "obligations_member_id_fkey"
            columns: ["member_id"]
            isOneToOne: false
            referencedRelation: "members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "obligations_waived_by_fkey"
            columns: ["waived_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      officer_invitations: {
        Row: {
          accepted_at: string | null
          accepted_by: string | null
          community_id: string
          created_at: string
          declined_at: string | null
          expires_at: string
          handover_id: string | null
          id: string
          invited_by: string
          invitee_email: string | null
          invitee_name: string | null
          invitee_phone_e164: string | null
          revoked_at: string | null
          role: Database["public"]["Enums"]["officer_role"]
          scope: Json | null
          status: Database["public"]["Enums"]["officer_invitation_status"]
          title: string | null
          token_hash: string
          token_prefix: string
          updated_at: string
        }
        Insert: {
          accepted_at?: string | null
          accepted_by?: string | null
          community_id: string
          created_at?: string
          declined_at?: string | null
          expires_at?: string
          handover_id?: string | null
          id?: string
          invited_by: string
          invitee_email?: string | null
          invitee_name?: string | null
          invitee_phone_e164?: string | null
          revoked_at?: string | null
          role: Database["public"]["Enums"]["officer_role"]
          scope?: Json | null
          status?: Database["public"]["Enums"]["officer_invitation_status"]
          title?: string | null
          token_hash: string
          token_prefix: string
          updated_at?: string
        }
        Update: {
          accepted_at?: string | null
          accepted_by?: string | null
          community_id?: string
          created_at?: string
          declined_at?: string | null
          expires_at?: string
          handover_id?: string | null
          id?: string
          invited_by?: string
          invitee_email?: string | null
          invitee_name?: string | null
          invitee_phone_e164?: string | null
          revoked_at?: string | null
          role?: Database["public"]["Enums"]["officer_role"]
          scope?: Json | null
          status?: Database["public"]["Enums"]["officer_invitation_status"]
          title?: string | null
          token_hash?: string
          token_prefix?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "officer_invitations_accepted_by_fkey"
            columns: ["accepted_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "officer_invitations_community_id_fkey"
            columns: ["community_id"]
            isOneToOne: false
            referencedRelation: "communities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "officer_invitations_invited_by_fkey"
            columns: ["invited_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      officer_terms: {
        Row: {
          actor_name_snapshot: string
          community_id: string
          created_at: string
          created_by: string | null
          end_reason:
            | Database["public"]["Enums"]["officer_term_end_reason"]
            | null
          ended_at: string | null
          id: string
          leadership_term_id: string | null
          role: Database["public"]["Enums"]["officer_role"]
          scope: Json | null
          start_reason: Database["public"]["Enums"]["officer_term_start_reason"]
          started_at: string
          title: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          actor_name_snapshot: string
          community_id: string
          created_at?: string
          created_by?: string | null
          end_reason?:
            | Database["public"]["Enums"]["officer_term_end_reason"]
            | null
          ended_at?: string | null
          id?: string
          leadership_term_id?: string | null
          role: Database["public"]["Enums"]["officer_role"]
          scope?: Json | null
          start_reason?: Database["public"]["Enums"]["officer_term_start_reason"]
          started_at?: string
          title?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          actor_name_snapshot?: string
          community_id?: string
          created_at?: string
          created_by?: string | null
          end_reason?:
            | Database["public"]["Enums"]["officer_term_end_reason"]
            | null
          ended_at?: string | null
          id?: string
          leadership_term_id?: string | null
          role?: Database["public"]["Enums"]["officer_role"]
          scope?: Json | null
          start_reason?: Database["public"]["Enums"]["officer_term_start_reason"]
          started_at?: string
          title?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "officer_terms_community_id_fkey"
            columns: ["community_id"]
            isOneToOne: false
            referencedRelation: "communities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "officer_terms_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "officer_terms_leadership_term_id_fkey"
            columns: ["leadership_term_id"]
            isOneToOne: false
            referencedRelation: "leadership_terms"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "officer_terms_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      permissions: {
        Row: {
          description: string
          key: string
        }
        Insert: {
          description: string
          key: string
        }
        Update: {
          description?: string
          key?: string
        }
        Relationships: []
      }
      role_permissions: {
        Row: {
          permission: string
          requires_second_approver: boolean
          role: Database["public"]["Enums"]["officer_role"]
          scoped: boolean
        }
        Insert: {
          permission: string
          requires_second_approver?: boolean
          role: Database["public"]["Enums"]["officer_role"]
          scoped?: boolean
        }
        Update: {
          permission?: string
          requires_second_approver?: boolean
          role?: Database["public"]["Enums"]["officer_role"]
          scoped?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "role_permissions_permission_fkey"
            columns: ["permission"]
            isOneToOne: false
            referencedRelation: "permissions"
            referencedColumns: ["key"]
          },
        ]
      }
      users: {
        Row: {
          anonymised_at: string | null
          avatar_url: string | null
          created_at: string
          email: string | null
          full_name: string
          id: string
          identity_level: Database["public"]["Enums"]["identity_level"]
          phone_e164: string | null
          status: Database["public"]["Enums"]["user_status"]
          updated_at: string
        }
        Insert: {
          anonymised_at?: string | null
          avatar_url?: string | null
          created_at?: string
          email?: string | null
          full_name: string
          id: string
          identity_level?: Database["public"]["Enums"]["identity_level"]
          phone_e164?: string | null
          status?: Database["public"]["Enums"]["user_status"]
          updated_at?: string
        }
        Update: {
          anonymised_at?: string | null
          avatar_url?: string | null
          created_at?: string
          email?: string | null
          full_name?: string
          id?: string
          identity_level?: Database["public"]["Enums"]["identity_level"]
          phone_e164?: string | null
          status?: Database["public"]["Enums"]["user_status"]
          updated_at?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      amount_model: "fixed" | "open_amount" | "tiers" | "per_member"
      audit_actor_type:
        | "officer"
        | "member"
        | "contributor"
        | "staff"
        | "system"
      code_style: "sequential" | "random"
      collection_category:
        | "dues"
        | "contribution"
        | "event"
        | "fundraiser"
        | "items"
        | "other"
      collection_schedule: "one_time" | "recurring"
      collection_status:
        | "draft"
        | "scheduled"
        | "active"
        | "paused"
        | "closed"
        | "suspended"
        | "archived"
      collection_visibility: "public" | "unlisted" | "members_only"
      community_status: "active" | "restricted" | "suspended" | "archived"
      community_type:
        | "personal"
        | "university_association"
        | "fellowship"
        | "alumni_association"
        | "cooperative"
        | "estate"
        | "professional_association"
        | "event_committee"
        | "social_group"
        | "school_pta"
        | "community_development"
        | "other"
      fee_mode: "community_absorbs" | "contributor_pays"
      identity_level: "none" | "contact_verified" | "identity_verified"
      invite_status: "active" | "expired" | "exhausted" | "revoked"
      legacy_link_kind:
        | "collection_slug"
        | "collection_uuid"
        | "receipt"
        | "contributor_code"
        | "other"
      member_attribute_type: "text" | "number" | "single_select" | "date"
      member_joined_via:
        | "invite_link"
        | "import"
        | "manual"
        | "payment"
        | "migration"
      member_status:
        | "pending_approval"
        | "unclaimed"
        | "invited"
        | "active"
        | "archived"
        | "merged"
      obligation_status:
        | "unpaid"
        | "in_installments"
        | "overdue"
        | "paid"
        | "exempt"
        | "cancelled"
      officer_invitation_status:
        | "sent"
        | "accepted"
        | "declined"
        | "expired"
        | "revoked"
      officer_role: "owner" | "admin" | "treasurer" | "collector" | "viewer"
      officer_term_end_reason:
        | "handover"
        | "removed"
        | "resigned"
        | "recovered"
        | "account_closed"
      officer_term_start_reason:
        | "created"
        | "invited"
        | "handover"
        | "recovery"
        | "migration"
      participation_mode: "open" | "managed"
      payment_plan: "full_only" | "installments_allowed"
      user_status: "active" | "suspended" | "closed"
      verification_status:
        | "unverified"
        | "pending"
        | "verified"
        | "rejected"
        | "expired"
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
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
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
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
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
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
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
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
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
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
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
      amount_model: ["fixed", "open_amount", "tiers", "per_member"],
      audit_actor_type: ["officer", "member", "contributor", "staff", "system"],
      code_style: ["sequential", "random"],
      collection_category: [
        "dues",
        "contribution",
        "event",
        "fundraiser",
        "items",
        "other",
      ],
      collection_schedule: ["one_time", "recurring"],
      collection_status: [
        "draft",
        "scheduled",
        "active",
        "paused",
        "closed",
        "suspended",
        "archived",
      ],
      collection_visibility: ["public", "unlisted", "members_only"],
      community_status: ["active", "restricted", "suspended", "archived"],
      community_type: [
        "personal",
        "university_association",
        "fellowship",
        "alumni_association",
        "cooperative",
        "estate",
        "professional_association",
        "event_committee",
        "social_group",
        "school_pta",
        "community_development",
        "other",
      ],
      fee_mode: ["community_absorbs", "contributor_pays"],
      identity_level: ["none", "contact_verified", "identity_verified"],
      invite_status: ["active", "expired", "exhausted", "revoked"],
      legacy_link_kind: [
        "collection_slug",
        "collection_uuid",
        "receipt",
        "contributor_code",
        "other",
      ],
      member_attribute_type: ["text", "number", "single_select", "date"],
      member_joined_via: [
        "invite_link",
        "import",
        "manual",
        "payment",
        "migration",
      ],
      member_status: [
        "pending_approval",
        "unclaimed",
        "invited",
        "active",
        "archived",
        "merged",
      ],
      obligation_status: [
        "unpaid",
        "in_installments",
        "overdue",
        "paid",
        "exempt",
        "cancelled",
      ],
      officer_invitation_status: [
        "sent",
        "accepted",
        "declined",
        "expired",
        "revoked",
      ],
      officer_role: ["owner", "admin", "treasurer", "collector", "viewer"],
      officer_term_end_reason: [
        "handover",
        "removed",
        "resigned",
        "recovered",
        "account_closed",
      ],
      officer_term_start_reason: [
        "created",
        "invited",
        "handover",
        "recovery",
        "migration",
      ],
      participation_mode: ["open", "managed"],
      payment_plan: ["full_only", "installments_allowed"],
      user_status: ["active", "suspended", "closed"],
      verification_status: [
        "unverified",
        "pending",
        "verified",
        "rejected",
        "expired",
      ],
    },
  },
} as const

