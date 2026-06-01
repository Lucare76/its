-- Backfill outbound WhatsApp templates that were logged in whatsapp_events
-- before the chat timeline started persisting every outbound message.

with outbound_events as (
  select
    e.tenant_id,
    e.service_id,
    e.provider_message_id,
    e.to_phone,
    e.template,
    e.status,
    e.happened_at,
    e.payload_json,
    null::uuid as customer_id,
    s.customer_name,
    s.phone as service_phone,
    s.phone_e164 as service_phone_e164
  from public.whatsapp_events e
  left join public.services s
    on s.id = e.service_id
   and s.tenant_id = e.tenant_id
  where e.provider_message_id is not null
    and e.status in ('sent', 'delivered', 'read')
    and not exists (
      select 1
      from public.whatsapp_messages m
      where m.tenant_id = e.tenant_id
        and m.wa_message_id = e.provider_message_id
    )
),
normalized as (
  select
    *,
    case
      when regexp_replace(coalesce(to_phone, service_phone_e164, service_phone, ''), '[^0-9+]', '', 'g') like '+%'
        then regexp_replace(coalesce(to_phone, service_phone_e164, service_phone, ''), '[^0-9+]', '', 'g')
      when regexp_replace(coalesce(to_phone, service_phone_e164, service_phone, ''), '[^0-9+]', '', 'g') like '00%'
        then '+' || substring(regexp_replace(coalesce(to_phone, service_phone_e164, service_phone, ''), '[^0-9+]', '', 'g') from 3)
      else '+' || regexp_replace(coalesce(to_phone, service_phone_e164, service_phone, ''), '[^0-9]', '', 'g')
    end as phone_e164
  from outbound_events
),
valid_events as (
  select
    *,
    regexp_replace(phone_e164, '[^0-9]', '', 'g') as wa_id
  from normalized
  where provider_message_id is not null
    and length(regexp_replace(phone_e164, '[^0-9]', '', 'g')) between 7 and 15
),
inserted_contacts as (
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
    customer_id,
    timezone('utc'::text, now())
  from valid_events
  order by tenant_id, wa_id, happened_at desc
  on conflict (tenant_id, wa_id) do update
    set phone_e164 = excluded.phone_e164,
        profile_name = coalesce(public.whatsapp_contacts.profile_name, excluded.profile_name),
        customer_id = coalesce(public.whatsapp_contacts.customer_id, excluded.customer_id),
        updated_at = timezone('utc'::text, now())
  returning id, tenant_id, wa_id
),
contact_rows as (
  select id, tenant_id, wa_id from inserted_contacts
  union
  select c.id, c.tenant_id, c.wa_id
  from public.whatsapp_contacts c
  join valid_events v
    on v.tenant_id = c.tenant_id
   and v.wa_id = c.wa_id
),
inserted_threads as (
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
  select distinct on (v.tenant_id, v.wa_id)
    v.tenant_id,
    v.wa_id,
    v.phone_e164,
    c.id,
    v.customer_id,
    v.service_id,
    v.service_id,
    v.happened_at,
    coalesce('Template ' || nullif(v.template, ''), 'Template WhatsApp'),
    0,
    'open',
    case when v.service_id is not null then 'matched' else 'needs_review' end,
    '[]'::jsonb,
    timezone('utc'::text, now())
  from valid_events v
  join contact_rows c
    on c.tenant_id = v.tenant_id
   and c.wa_id = v.wa_id
  order by v.tenant_id, v.wa_id, v.happened_at desc
  on conflict (tenant_id, wa_id) do nothing
  returning id, tenant_id, wa_id
),
thread_rows as (
  select id, tenant_id, wa_id from inserted_threads
  union
  select t.id, t.tenant_id, t.wa_id
  from public.whatsapp_threads t
  join valid_events v
    on v.tenant_id = t.tenant_id
   and v.wa_id = t.wa_id
)
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
  v.tenant_id,
  v.provider_message_id,
  null,
  'outbound',
  v.wa_id,
  v.phone_e164,
  c.id,
  t.id,
  v.customer_id,
  v.service_id,
  v.service_id,
  'template',
  v.template,
  coalesce('Template ' || nullif(v.template, ''), 'Template WhatsApp'),
  null,
  null,
  null,
  v.status,
  v.happened_at,
  jsonb_build_object(
    'id', v.provider_message_id,
    'source', 'backfill_whatsapp_events',
    'template', v.template,
    'payload_json', coalesce(v.payload_json, '{}'::jsonb)
  ),
  v.happened_at
from valid_events v
join contact_rows c
  on c.tenant_id = v.tenant_id
 and c.wa_id = v.wa_id
join thread_rows t
  on t.tenant_id = v.tenant_id
 and t.wa_id = v.wa_id
on conflict (tenant_id, wa_message_id) do nothing;

-- Backfill reply linkage for inbound messages already archived with a Meta
-- context.id before reply_to_wa_message_id existed.
update public.whatsapp_messages
set reply_to_wa_message_id = raw_message #>> '{context,id}'
where direction = 'inbound'
  and reply_to_wa_message_id is null
  and nullif(raw_message #>> '{context,id}', '') is not null;
