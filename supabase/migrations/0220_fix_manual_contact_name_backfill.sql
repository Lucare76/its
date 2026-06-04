-- Backfill manual_contact_name for contacts where the operator entered a name
-- via ensureWhatsAppContact (gestionale route), which previously only wrote to
-- profile_name / customer_full_name but never set manual_contact_name.
--
-- Safe condition: copy profile_name → manual_contact_name only when:
--   1. manual_contact_name is not already set
--   2. profile_name has at least one alphanumeric character (not just punctuation/phone)
--   3. profile_name differs from wa_profile_name (i.e. it's not just the WhatsApp profile)
--   4. profile_name does not look like a raw phone number

update public.whatsapp_contacts
set manual_contact_name = btrim(profile_name)
where manual_contact_name is null
  and profile_name is not null
  and btrim(profile_name) ~ '[[:alnum:]]'
  and btrim(profile_name) !~ '^[+0-9 ()-]+$'
  and (
    wa_profile_name is null
    or btrim(profile_name) is distinct from btrim(wa_profile_name)
  );
