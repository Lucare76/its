-- Una email inbound puo generare al massimo un servizio.
-- Conserva i duplicati storici, sganciando il riferimento dai record successivi.
with ranked as (
  select id, row_number() over (
    partition by tenant_id, inbound_email_id
    order by created_at asc, id asc
  ) as duplicate_rank
  from public.services
  where inbound_email_id is not null
)
update public.services as service
set inbound_email_id = null
from ranked
where service.id = ranked.id
  and ranked.duplicate_rank > 1;

create unique index if not exists uq_services_tenant_inbound_email
  on public.services (tenant_id, inbound_email_id)
  where inbound_email_id is not null;
