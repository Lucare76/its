-- Backfill outbound WhatsApp templates into whatsapp_messages.
--
-- IMPORTANT: run 0213_whatsapp_reply_context.sql before this migration.
--
-- This migration is intentionally defensive:
-- - it does not use services.customer_id
-- - it does not use services.message_id
-- - it does not use services.phone_e164
-- - it works even if public.whatsapp_events does not exist
-- - it does not rely on temporary/staging tables
-- - it can be run more than once

do $$
declare
  events_source_sql text := '';
  backfill_cte_sql text;
begin
  if to_regclass('public.whatsapp_events') is not null then
    events_source_sql := $events$
      union all
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
          when regexp_replace(coalesce(e.to_phone, s.phone, ''), '[^0-9+]', '', 'g') like '+%'
            then regexp_replace(coalesce(e.to_phone, s.phone, ''), '[^0-9+]', '', 'g')
          when regexp_replace(coalesce(e.to_phone, s.phone, ''), '[^0-9+]', '', 'g') like '00%'
            then '+' || substring(regexp_replace(coalesce(e.to_phone, s.phone, ''), '[^0-9+]', '', 'g') from 3)
          else '+' || regexp_replace(coalesce(e.to_phone, s.phone, ''), '[^0-9]', '', 'g')
        end as phone_e164,
        2 as source_priority
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
    $events$;
  end if;

  backfill_cte_sql := format($cte$
    with status_backfill as (
      select distinct on (s.tenant_id, s.wa_message_id)
        s.tenant_id,
        null::uuid as service_id,
        s.wa_message_id as provider_message_id,
        s.recipient_id as to_phone,
        null::text as template,
        s.status,
        coalesce(s.timestamp, s.created_at, timezone('utc'::text, now())) as happened_at,
        coalesce(s.raw_status, '{}'::jsonb) as payload_json,
        null::text as customer_name,
        case
          when regexp_replace(coalesce(s.recipient_id, ''), '[^0-9+]', '', 'g') like '+%%'
            then regexp_replace(coalesce(s.recipient_id, ''), '[^0-9+]', '', 'g')
          when regexp_replace(coalesce(s.recipient_id, ''), '[^0-9+]', '', 'g') like '00%%'
            then '+' || substring(regexp_replace(coalesce(s.recipient_id, ''), '[^0-9+]', '', 'g') from 3)
          else '+' || regexp_replace(coalesce(s.recipient_id, ''), '[^0-9]', '', 'g')
        end as phone_e164,
        1 as source_priority
      from public.whatsapp_message_statuses s
      where s.tenant_id is not null
        and s.wa_message_id is not null
        and s.recipient_id is not null
        and s.status in ('sent', 'delivered', 'read')
        and not exists (
          select 1
          from public.whatsapp_messages m
          where m.tenant_id = s.tenant_id
            and m.wa_message_id = s.wa_message_id
        )
      order by s.tenant_id, s.wa_message_id, s.created_at asc
    ),
    raw_backfill as (
      select * from status_backfill
      %s
    ),
    backfill as (
      select distinct on (tenant_id, provider_message_id)
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
        regexp_replace(phone_e164, '[^0-9]', '', 'g') as wa_id
      from raw_backfill
      where length(regexp_replace(phone_e164, '[^0-9]', '', 'g')) between 7 and 15
      order by tenant_id, provider_message_id, source_priority asc, happened_at asc
    )
  $cte$, events_source_sql);

  execute backfill_cte_sql || $sql$
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
    from backfill
    order by tenant_id, wa_id, happened_at desc
    on conflict (tenant_id, wa_id) do update
      set phone_e164 = excluded.phone_e164,
          profile_name = coalesce(public.whatsapp_contacts.profile_name, excluded.profile_name),
          updated_at = timezone('utc'::text, now())
  $sql$;

  execute backfill_cte_sql || $sql$
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
    from backfill b
    join public.whatsapp_contacts c
      on c.tenant_id = b.tenant_id
     and c.wa_id = b.wa_id
    order by b.tenant_id, b.wa_id, b.happened_at desc
    on conflict (tenant_id, wa_id) do update
      set phone_e164 = excluded.phone_e164,
          contact_id = coalesce(public.whatsapp_threads.contact_id, excluded.contact_id),
          booking_id = coalesce(public.whatsapp_threads.booking_id, excluded.booking_id),
          transfer_id = coalesce(public.whatsapp_threads.transfer_id, excluded.transfer_id),
          updated_at = timezone('utc'::text, now())
  $sql$;

  execute backfill_cte_sql || $sql$
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
    from backfill b
    join public.whatsapp_contacts c
      on c.tenant_id = b.tenant_id
     and c.wa_id = b.wa_id
    join public.whatsapp_threads t
      on t.tenant_id = b.tenant_id
     and t.wa_id = b.wa_id
    on conflict (tenant_id, wa_message_id) do nothing
  $sql$;
end $$;

-- Backfill reply linkage for inbound messages already archived with a Meta
-- context.id before reply_to_wa_message_id existed.
update public.whatsapp_messages
set reply_to_wa_message_id = raw_message #>> '{context,id}'
where direction = 'inbound'
  and reply_to_wa_message_id is null
  and nullif(raw_message #>> '{context,id}', '') is not null;
