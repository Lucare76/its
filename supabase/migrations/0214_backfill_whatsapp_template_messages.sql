-- Backfill outbound WhatsApp templates into whatsapp_messages.
--
-- IMPORTANT: run 0213_whatsapp_reply_context.sql before this migration.
--
-- This migration is intentionally defensive:
-- - it does not use services.customer_id
-- - it works even if public.whatsapp_events does not exist
-- - it can be run more than once

create temp table if not exists tmp_whatsapp_template_backfill (
  tenant_id uuid not null,
  service_id uuid null,
  provider_message_id text not null,
  to_phone text null,
  template text null,
  status text null,
  happened_at timestamptz not null,
  payload_json jsonb null,
  customer_name text null,
  phone_e164 text not null,
  wa_id text not null
) on commit drop;

truncate table tmp_whatsapp_template_backfill;

-- Source 1: services.message_id. This exists in the current production schema
-- and is enough to restore the outbound bubble matched by Meta context.id.
insert into tmp_whatsapp_template_backfill (
  tenant_id,
  service_id,
  provider_message_id,
  to_phone,
  template,
  status,
  happened_at,
  payload_json,
  customer_name,
  phone_e164,
  wa_id
)
select
  src.tenant_id,
  src.service_id,
  src.provider_message_id,
  src.to_phone,
  src.template,
  src.status,
  src.happened_at,
  src.payload_json,
  src.customer_name,
  src.phone_e164,
  regexp_replace(src.phone_e164, '[^0-9]', '', 'g') as wa_id
from (
  select
    s.tenant_id,
    s.id as service_id,
    s.message_id as provider_message_id,
    coalesce(s.phone_e164, s.phone) as to_phone,
    null::text as template,
    coalesce(s.reminder_status::text, 'sent') as status,
    coalesce(s.sent_at, timezone('utc'::text, now())) as happened_at,
    jsonb_build_object('source', 'services.message_id') as payload_json,
    s.customer_name,
    case
      when regexp_replace(coalesce(s.phone_e164, s.phone, ''), '[^0-9+]', '', 'g') like '+%'
        then regexp_replace(coalesce(s.phone_e164, s.phone, ''), '[^0-9+]', '', 'g')
      when regexp_replace(coalesce(s.phone_e164, s.phone, ''), '[^0-9+]', '', 'g') like '00%'
        then '+' || substring(regexp_replace(coalesce(s.phone_e164, s.phone, ''), '[^0-9+]', '', 'g') from 3)
      else '+' || regexp_replace(coalesce(s.phone_e164, s.phone, ''), '[^0-9]', '', 'g')
    end as phone_e164
  from public.services s
  where s.tenant_id is not null
    and s.message_id is not null
    and not exists (
      select 1
      from public.whatsapp_messages m
      where m.tenant_id = s.tenant_id
        and m.wa_message_id = s.message_id
    )
) src
where length(regexp_replace(src.phone_e164, '[^0-9]', '', 'g')) between 7 and 15;

-- Source 2: whatsapp_events, only when that legacy table exists.
do $$
begin
  if to_regclass('public.whatsapp_events') is not null then
    execute $sql$
      insert into tmp_whatsapp_template_backfill (
        tenant_id,
        service_id,
        provider_message_id,
        to_phone,
        template,
        status,
        happened_at,
        payload_json,
        customer_name,
        phone_e164,
        wa_id
      )
      select
        src.tenant_id,
        src.service_id,
        src.provider_message_id,
        src.to_phone,
        src.template,
        src.status,
        src.happened_at,
        src.payload_json,
        src.customer_name,
        src.phone_e164,
        regexp_replace(src.phone_e164, '[^0-9]', '', 'g') as wa_id
      from (
        select
          e.tenant_id,
          e.service_id,
          e.provider_message_id,
          e.to_phone,
          e.template,
          e.status,
          coalesce(e.happened_at, e.created_at, timezone('utc'::text, now())) as happened_at,
          e.payload_json,
          s.customer_name,
          case
            when regexp_replace(coalesce(e.to_phone, s.phone_e164, s.phone, ''), '[^0-9+]', '', 'g') like '+%'
              then regexp_replace(coalesce(e.to_phone, s.phone_e164, s.phone, ''), '[^0-9+]', '', 'g')
            when regexp_replace(coalesce(e.to_phone, s.phone_e164, s.phone, ''), '[^0-9+]', '', 'g') like '00%'
              then '+' || substring(regexp_replace(coalesce(e.to_phone, s.phone_e164, s.phone, ''), '[^0-9+]', '', 'g') from 3)
            else '+' || regexp_replace(coalesce(e.to_phone, s.phone_e164, s.phone, ''), '[^0-9]', '', 'g')
          end as phone_e164
        from public.whatsapp_events e
        left join public.services s
          on s.id = e.service_id
         and s.tenant_id = e.tenant_id
        where e.tenant_id is not null
          and e.provider_message_id is not null
          and e.status in ('sent', 'delivered', 'read')
          and not exists (
            select 1
            from public.whatsapp_messages m
            where m.tenant_id = e.tenant_id
              and m.wa_message_id = e.provider_message_id
          )
      ) src
      where length(regexp_replace(src.phone_e164, '[^0-9]', '', 'g')) between 7 and 15
      on conflict do nothing
    $sql$;
  end if;
end $$;

insert into public.whatsapp_contacts (
  tenant_id,
  wa_id,
  phone_e164,
  profile_name,
  customer_id,
  updated_at
)
select distinct on (tenant_id, wa_id)
  tenant_id,
  wa_id,
  phone_e164,
  nullif(customer_name, ''),
  null::uuid,
  timezone('utc'::text, now())
from tmp_whatsapp_template_backfill
order by tenant_id, wa_id, happened_at desc
on conflict (tenant_id, wa_id) do update
  set phone_e164 = excluded.phone_e164,
      profile_name = coalesce(public.whatsapp_contacts.profile_name, excluded.profile_name),
      updated_at = timezone('utc'::text, now());

insert into public.whatsapp_threads (
  tenant_id,
  wa_id,
  phone_e164,
  contact_id,
  customer_id,
  booking_id,
  transfer_id,
  last_message_at,
  last_message_preview,
  unread_count,
  status,
  match_status,
  match_suggestions,
  updated_at
)
select distinct on (b.tenant_id, b.wa_id)
  b.tenant_id,
  b.wa_id,
  b.phone_e164,
  c.id,
  null::uuid,
  b.service_id,
  b.service_id,
  b.happened_at,
  coalesce('Template ' || nullif(b.template, ''), 'Template WhatsApp'),
  0,
  'open',
  case when b.service_id is not null then 'matched' else 'needs_review' end,
  '[]'::jsonb,
  timezone('utc'::text, now())
from tmp_whatsapp_template_backfill b
join public.whatsapp_contacts c
  on c.tenant_id = b.tenant_id
 and c.wa_id = b.wa_id
order by b.tenant_id, b.wa_id, b.happened_at desc
on conflict (tenant_id, wa_id) do update
  set phone_e164 = excluded.phone_e164,
      contact_id = coalesce(public.whatsapp_threads.contact_id, excluded.contact_id),
      booking_id = coalesce(public.whatsapp_threads.booking_id, excluded.booking_id),
      transfer_id = coalesce(public.whatsapp_threads.transfer_id, excluded.transfer_id),
      updated_at = timezone('utc'::text, now());

insert into public.whatsapp_messages (
  tenant_id,
  wa_message_id,
  reply_to_wa_message_id,
  direction,
  wa_id,
  phone_e164,
  contact_id,
  thread_id,
  customer_id,
  booking_id,
  transfer_id,
  message_type,
  template_name,
  text_body,
  media_id,
  media_mime_type,
  media_sha256,
  status,
  timestamp,
  raw_message,
  created_at
)
select
  b.tenant_id,
  b.provider_message_id,
  null,
  'outbound',
  b.wa_id,
  b.phone_e164,
  c.id,
  t.id,
  null::uuid,
  b.service_id,
  b.service_id,
  'template',
  b.template,
  coalesce('Template ' || nullif(b.template, ''), 'Template WhatsApp'),
  null,
  null,
  null,
  b.status,
  b.happened_at,
  jsonb_build_object(
    'id', b.provider_message_id,
    'source', 'backfill_whatsapp_templates',
    'template', b.template,
    'payload_json', coalesce(b.payload_json, '{}'::jsonb)
  ),
  b.happened_at
from tmp_whatsapp_template_backfill b
join public.whatsapp_contacts c
  on c.tenant_id = b.tenant_id
 and c.wa_id = b.wa_id
join public.whatsapp_threads t
  on t.tenant_id = b.tenant_id
 and t.wa_id = b.wa_id
on conflict (tenant_id, wa_message_id) do nothing;

-- Backfill reply linkage for inbound messages already archived with a Meta
-- context.id before reply_to_wa_message_id existed.
update public.whatsapp_messages
set reply_to_wa_message_id = raw_message #>> '{context,id}'
where direction = 'inbound'
  and reply_to_wa_message_id is null
  and nullif(raw_message #>> '{context,id}', '') is not null;

drop table if exists tmp_whatsapp_template_backfill;
