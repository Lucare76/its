-- Statements are financial snapshots. No existing document, amount or payment is deleted.
begin;
alter table public.agency_invoices
 add column if not exists invoice_number text,
 add column if not exists date_basis text not null default 'legacy' check(date_basis in ('arrival','departure','legacy')),
 add column if not exists paid_cents integer not null default 0 check(paid_cents>=0),
 add column if not exists waived_cents integer not null default 0 check(waived_cents>=0),
 add column if not exists review_draft jsonb not null default '[]',
 add column if not exists review_draft_updated_at timestamptz;
alter table public.services add column if not exists agency_paid_amount_cents integer not null default 0 check(agency_paid_amount_cents>=0);
alter table public.service_cancellation_penalties add column if not exists paid_amount_cents integer not null default 0 check(paid_amount_cents>=0);
-- Preserve historic full-payment flags. Partial amounts did not exist before this migration.
update public.services set agency_paid_amount_cents=greatest(0,coalesce(agency_quoted_price_cents,source_total_amount_cents,0)) where agency_payment_status='paid' and agency_paid_amount_cents=0;
update public.agency_invoices set paid_cents=greatest(total_cents,0) where status='paid' and paid_cents=0;
with paid_lines as(select i.tenant_id,(x->>'service_id')::uuid service_id,max((x->>'importo_cents')::integer) amount from public.agency_invoices i cross join lateral jsonb_array_elements(i.invoice_data) x where i.status='paid' and x->>'service_id' ~ '^[0-9a-fA-F-]{36}$' and x->>'importo_cents' ~ '^[0-9]+$' group by 1,2)
update public.services s set agency_paid_amount_cents=greatest(s.agency_paid_amount_cents,least(l.amount,coalesce(s.agency_quoted_price_cents,s.source_total_amount_cents,0))),agency_payment_status=case when l.amount>=coalesce(s.agency_quoted_price_cents,s.source_total_amount_cents,0) then 'paid' else s.agency_payment_status end from paid_lines l where s.tenant_id=l.tenant_id and s.id=l.service_id and s.status::text<>'cancelled';
create table if not exists public.agency_statement_counters(tenant_id uuid not null references public.tenants(id), year integer not null, last_number integer not null, primary key(tenant_id,year));
alter table public.agency_statement_counters enable row level security;
revoke all on public.agency_statement_counters from public,anon,authenticated;
grant all on public.agency_statement_counters to service_role;
-- Number historical documents deterministically, without changing their content or payment flags.
with numbered as(select id,tenant_id,extract(year from created_at)::integer y,row_number() over(partition by tenant_id,extract(year from created_at) order by created_at,id)::integer n from public.agency_invoices)
update public.agency_invoices i set invoice_number='EC-'||n.y||'-'||lpad(n.n::text,5,'0') from numbered n where n.id=i.id and i.invoice_number is null;
insert into public.agency_statement_counters select tenant_id,extract(year from created_at)::integer,max(split_part(invoice_number,'-',3)::integer) from public.agency_invoices group by 1,2 on conflict(tenant_id,year) do update set last_number=greatest(agency_statement_counters.last_number,excluded.last_number);
create unique index if not exists agency_invoice_number_unique on public.agency_invoices(tenant_id,invoice_number);
-- Historic overlaps are retained for review. New documents are protected transactionally below.
-- A/R can be represented by one row or by two explicitly linked legs.
-- Never join passengers/practices by name: only the tenant-scoped stored link.
create or replace function public.agency_statement_dates(p_tenant_id uuid,p_service_id uuid)
returns table(arrival_date date,departure_date date) language sql stable security invoker set search_path=public as $$
 select coalesce(s.arrival_date,l.arrival_date,case when s.direction::text='arrival' then s.date end,case when l.direction::text='arrival' then l.date end),
 coalesce(s.departure_date,l.departure_date,case when s.direction::text='departure' then s.date end,case when l.direction::text='departure' then l.date end)
 from public.services s left join public.services l on l.id=s.linked_service_id and l.tenant_id=s.tenant_id where s.id=p_service_id and s.tenant_id=p_tenant_id
$$;
revoke all on function public.agency_statement_dates(uuid,uuid) from public,anon,authenticated;
grant execute on function public.agency_statement_dates(uuid,uuid) to service_role;

create or replace function public.create_agency_statement(p_tenant_id uuid,p_agency_id uuid,p_from date,p_to date,p_basis text)
returns jsonb language plpgsql security invoker set search_path=public as $$
declare a public.agencies%rowtype; i public.agency_invoices%rowtype; s public.services%rowtype; p public.service_cancellation_penalties%rowtype; items jsonb:='[]'; line jsonb; amount integer; seq integer; yr integer; chosen date; paid integer; waived integer; conflict_id uuid; bus_stop text; booking_dates record;
begin
 if p_from is null or p_to is null or p_from>p_to or p_basis not in('arrival','departure') then raise exception 'STATEMENT_INVALID_PERIOD'; end if;
 -- Serializes generation, manual and scheduled, for this agency.
 select * into a from public.agencies where id=p_agency_id and tenant_id=p_tenant_id for update;
 if not found then raise exception 'STATEMENT_AGENCY_NOT_FOUND'; end if;
 select * into i from public.agency_invoices where tenant_id=p_tenant_id and agency_id=a.id and period_from=p_from and period_to=p_to and date_basis in(p_basis,'legacy') order by created_at limit 1;
 if found then return jsonb_build_object('invoice',to_jsonb(i),'reused',true); end if;
 -- Old aliases must be linked explicitly; do not silently omit them or guess who owes money.
 if exists(select 1 from public.services svc cross join lateral public.agency_statement_dates(p_tenant_id,svc.id) d where svc.tenant_id=p_tenant_id and svc.agency_id is null and nullif(trim(svc.billing_party_name),'') is not null and lower(trim(svc.billing_party_name))<>lower(trim(a.name)) and (position(lower(trim(svc.billing_party_name)) in lower(trim(a.name)))>0 or position(lower(trim(a.name)) in lower(trim(svc.billing_party_name)))>0) and (case when p_basis='arrival' then d.arrival_date else d.departure_date end) between p_from and p_to and svc.is_draft=false and coalesce(svc.approval_status::text,'confirmed') in('confirmed','approved')) then raise exception 'STATEMENT_AGENCY_LINK_REQUIRED'; end if;

 for s in select svc.* from public.services svc cross join lateral public.agency_statement_dates(p_tenant_id,svc.id) d where svc.tenant_id=p_tenant_id and (svc.agency_id=a.id or (svc.agency_id is null and lower(trim(svc.billing_party_name))=lower(trim(a.name))))
 and svc.is_draft=false and (case when p_basis='arrival' then d.arrival_date else d.departure_date end) between p_from and p_to order by svc.id for update of svc loop
  select * into booking_dates from public.agency_statement_dates(p_tenant_id,s.id);
  -- Imported legacy services without an approval status remain billable; explicit pending/rejected are not.
  if coalesce(s.approval_status::text,'confirmed') not in('confirmed','approved') then continue; end if;
  p:=null; amount:=null;
  if s.status::text='cancelled' then
   select * into p from public.service_cancellation_penalties where tenant_id=p_tenant_id and status='active' and (service_id=s.id or linked_service_id=s.id) for update;
   if not found or p.penalty_amount_cents<=0 then continue; end if;
   -- A whole-practice penalty is charged once, never on both linked legs.
   if exists(select 1 from jsonb_array_elements(items) x where x->>'penalty_id'=p.id::text) then continue; end if;
   amount:=p.penalty_amount_cents; paid:=least(amount,p.paid_amount_cents); waived:=0;
  else
   amount:=coalesce(s.agency_quoted_price_cents,s.source_total_amount_cents);
   if amount is null or amount<0 then raise exception 'STATEMENT_MISSING_PRICE:%',s.id; end if;
   paid:=least(amount,s.agency_paid_amount_cents); waived:=case when s.agency_payment_status='waived' then amount else 0 end;
  end if;
  select inv.id into conflict_id from public.agency_invoices inv cross join lateral jsonb_array_elements(inv.invoice_data) x where inv.tenant_id=p_tenant_id and (x->>'service_id'=s.id::text or (p.id is not null and x->>'penalty_id'=p.id::text)) limit 1;
  if found then raise exception 'STATEMENT_ALREADY_INCLUDED:%',conflict_id; end if;
  chosen:=case when p_basis='arrival' then booking_dates.arrival_date else booking_dates.departure_date end;
  select string_agg(distinct st.stop_name,' / ' order by st.stop_name) into bus_stop from public.tenant_bus_allocations ba join public.tenant_bus_line_stops st on st.id=ba.stop_id and st.tenant_id=ba.tenant_id where ba.tenant_id=p_tenant_id and ba.service_id=s.id and ba.direction='arrival';
  line:=jsonb_build_object('service_id',s.id,'penalty_id',p.id,'numero_pratica',coalesce(substring(s.notes from '\[practice:([^\]]+)\]'),s.practice_number,'—'),'cliente_nome',coalesce(nullif(trim(concat_ws(' ',s.customer_first_name,s.customer_last_name)),''),s.customer_name,'—'),'data_servizio',chosen,'arrival_date',booking_dates.arrival_date,'departure_date',booking_dates.departure_date,'tipo_servizio',coalesce(s.booking_service_kind::text,s.service_type::text,'transfer'),'pax',s.pax,'importo_cents',amount,'paid_cents',paid,'waived_cents',waived,'booking_service_kind',s.booking_service_kind,'service_type',s.service_type,'vessel',s.vessel,'meeting_point',s.meeting_point,'transport_code',s.transport_code,'include_ferry_tickets',s.include_ferry_tickets,'ferry_details',jsonb_build_object('carrier_company',s.ferry_details->'carrier_company','transport_reference_outward',s.ferry_details->'transport_reference_outward','transport_reference_return',s.ferry_details->'transport_reference_return','arrival_transport_code',s.ferry_details->'arrival_transport_code','departure_transport_code',s.ferry_details->'departure_transport_code'),'bus_city_origin',s.bus_city_origin,'bus_stop_name',coalesce(bus_stop,s.bus_city_origin));
  items:=items||jsonb_build_array(line);
 end loop;
 if jsonb_array_length(items)=0 then raise exception 'STATEMENT_NO_SERVICES'; end if;
 select jsonb_agg(x order by x->>'data_servizio',x->>'numero_pratica',x->>'service_id') into items from jsonb_array_elements(items) x;
 yr:=extract(year from timezone('Europe/Rome',now()));
 insert into public.agency_statement_counters values(p_tenant_id,yr,1) on conflict(tenant_id,year) do update set last_number=agency_statement_counters.last_number+1 returning last_number into seq;
 insert into public.agency_invoices(tenant_id,agency_id,agency_name,period_from,period_to,date_basis,invoice_number,invoice_data,services_count,total_cents,paid_cents,waived_cents)
 select p_tenant_id,a.id,a.name,p_from,p_to,p_basis,'EC-'||yr||'-'||lpad(seq::text,greatest(5,length(seq::text)),'0'),items,jsonb_array_length(items),sum((x->>'importo_cents')::integer),sum((x->>'paid_cents')::integer),sum((x->>'waived_cents')::integer) from jsonb_array_elements(items) x returning * into i;
 if i.total_cents>0 and i.paid_cents+i.waived_cents>=i.total_cents then update public.agency_invoices set status='paid',paid_at=now() where id=i.id returning * into i; end if;
 return jsonb_build_object('invoice',to_jsonb(i),'reused',false);
end $$;

-- Recompute balances from verified payments, never from an agency's declaration.
create or replace function public.refresh_agency_statement(p_tenant_id uuid,p_invoice_id uuid) returns void language plpgsql security invoker set search_path=public as $$
declare i public.agency_invoices%rowtype; x jsonb; lines jsonb:='[]'; paid integer; waived integer; totalpaid integer:=0; totalwaived integer:=0; s public.services%rowtype; p public.service_cancellation_penalties%rowtype;
begin
 select * into i from public.agency_invoices where id=p_invoice_id and tenant_id=p_tenant_id for update;
 if not found then raise exception 'STATEMENT_NOT_FOUND'; end if;
 for x in select * from jsonb_array_elements(i.invoice_data) loop
  if nullif(x->>'penalty_id','') is not null then
   select * into p from public.service_cancellation_penalties where id=(x->>'penalty_id')::uuid and tenant_id=p_tenant_id;
   if not found then raise exception 'STATEMENT_PENALTY_NOT_FOUND'; end if;
   paid:=least((x->>'importo_cents')::integer,p.paid_amount_cents); waived:=0;
  else
   select * into s from public.services where id=(x->>'service_id')::uuid and tenant_id=p_tenant_id;
   if not found then raise exception 'STATEMENT_SERVICE_NOT_FOUND'; end if;
   paid:=least((x->>'importo_cents')::integer,s.agency_paid_amount_cents);
   waived:=case when s.agency_payment_status='waived' then (x->>'importo_cents')::integer else 0 end;
  end if;
  totalpaid:=totalpaid+paid; totalwaived:=totalwaived+waived;
  lines:=lines||jsonb_build_array(x||jsonb_build_object('paid_cents',paid,'waived_cents',waived));
 end loop;
 update public.agency_invoices set invoice_data=lines,paid_cents=totalpaid,waived_cents=totalwaived,
 status=case when totalpaid+totalwaived>=total_cents and total_cents>0 then 'paid' when sent_at is not null then 'sent' else 'draft' end,
 paid_at=case when totalpaid+totalwaived>=total_cents and total_cents>0 then coalesce(paid_at,now()) else null end
 where id=i.id and tenant_id=p_tenant_id;
end $$;

create table if not exists public.agency_statement_payment_events(
 id uuid primary key default gen_random_uuid(),tenant_id uuid not null references public.tenants(id),invoice_id uuid not null references public.agency_invoices(id),idempotency_key uuid not null,amount_cents integer not null check(amount_cents>0),paid_on date not null,method text not null,note text,user_id uuid,created_at timestamptz not null default now(),unique(tenant_id,idempotency_key));
alter table public.agency_statement_payment_events enable row level security;
revoke all on public.agency_statement_payment_events from public,anon,authenticated;
grant all on public.agency_statement_payment_events to service_role;
create table if not exists public.agency_statement_payment_reports(
 id uuid primary key default gen_random_uuid(),tenant_id uuid not null references public.tenants(id),agency_id uuid not null references public.agencies(id),invoice_id uuid not null references public.agency_invoices(id),amount_cents integer not null check(amount_cents>0),paid_on date not null,method text not null,note text,status text not null default 'pending' check(status in('pending','verified','rejected')),created_at timestamptz not null default now(),verified_at timestamptz,verified_by uuid);
create unique index if not exists agency_statement_one_pending_report on public.agency_statement_payment_reports(tenant_id,invoice_id) where status='pending';
alter table public.agency_statement_payment_reports enable row level security;
revoke all on public.agency_statement_payment_reports from public,anon,authenticated;
grant all on public.agency_statement_payment_reports to service_role;

create or replace function public.pay_agency_statement(p_tenant_id uuid,p_invoice_id uuid,p_amount integer,p_key uuid,p_user_id uuid,p_note text,p_paid_on date,p_method text,p_report_id uuid default null)
returns jsonb language plpgsql security invoker set search_path=public as $$
declare i public.agency_invoices%rowtype; a uuid; x jsonb; remaining integer; portion integer; balance integer; s public.services%rowtype; p public.service_cancellation_penalties%rowtype; report public.agency_statement_payment_reports%rowtype;
begin
 select agency_id into a from public.agency_invoices where id=p_invoice_id and tenant_id=p_tenant_id;
 perform 1 from public.agencies where id=a and tenant_id=p_tenant_id for update;
 select * into i from public.agency_invoices where id=p_invoice_id and tenant_id=p_tenant_id for update;
 if not found then raise exception 'STATEMENT_NOT_FOUND'; end if;
 if exists(select 1 from public.agency_statement_payment_events where tenant_id=p_tenant_id and idempotency_key=p_key and invoice_id=p_invoice_id) then return jsonb_build_object('replayed',true); end if;
 if p_report_id is not null then
  select * into report from public.agency_statement_payment_reports where id=p_report_id and invoice_id=i.id and tenant_id=p_tenant_id for update;
  if not found or report.status<>'pending' or p_amount is distinct from report.amount_cents then raise exception 'STATEMENT_PAYMENT_REPORT_INVALID'; end if;
 end if;
 perform public.refresh_agency_statement(p_tenant_id,i.id);
 select * into i from public.agency_invoices where id=i.id;
 balance:=greatest(0,i.total_cents-i.paid_cents-i.waived_cents); remaining:=coalesce(p_amount,balance);
 if remaining<=0 then if p_report_id is not null then raise exception 'STATEMENT_PAYMENT_EXCEEDS_BALANCE'; end if; return jsonb_build_object('replayed',true); end if;
 if remaining>balance then raise exception 'STATEMENT_PAYMENT_EXCEEDS_BALANCE'; end if;
 insert into public.agency_statement_payment_events(tenant_id,invoice_id,idempotency_key,amount_cents,paid_on,method,note,user_id) values(p_tenant_id,i.id,p_key,remaining,p_paid_on,p_method,p_note,p_user_id);
 for x in select * from jsonb_array_elements(i.invoice_data) loop
  portion:=least(remaining,greatest(0,(x->>'importo_cents')::integer-coalesce((x->>'paid_cents')::integer,0)-coalesce((x->>'waived_cents')::integer,0)));
  if portion>0 then
   if nullif(x->>'penalty_id','') is not null then
    update public.service_cancellation_penalties set paid_amount_cents=paid_amount_cents+portion where id=(x->>'penalty_id')::uuid and tenant_id=p_tenant_id and status='active';
    if not found then raise exception 'STATEMENT_PENALTY_CHANGED'; end if;
   else
    select * into s from public.services where id=(x->>'service_id')::uuid and tenant_id=p_tenant_id for update;
    update public.services set agency_paid_amount_cents=agency_paid_amount_cents+portion,agency_payment_status=case when agency_paid_amount_cents+portion>=coalesce(agency_quoted_price_cents,source_total_amount_cents,0) then 'paid' else 'unpaid' end,agency_paid_at=p_paid_on where id=s.id and tenant_id=p_tenant_id;
   end if;
   remaining:=remaining-portion;
  end if;
 end loop;
 perform public.refresh_agency_statement(p_tenant_id,i.id);
 update public.agency_invoices set paid_by_user_id=p_user_id,payment_note=p_note where id=i.id and tenant_id=p_tenant_id;
 if p_report_id is not null then update public.agency_statement_payment_reports set status='verified',verified_at=now(),verified_by=p_user_id where id=p_report_id and tenant_id=p_tenant_id; end if;
 return jsonb_build_object('replayed',false);
end $$;

-- Keep single-service payment actions and every linked statement synchronized.
create or replace function public.set_agency_service_payment(p_tenant_id uuid,p_service_id uuid,p_status text,p_amount integer default null) returns void language plpgsql security invoker set search_path=public as $$
declare s public.services%rowtype; i record; amount integer;
begin
 if p_status not in('paid','unpaid','waived') then raise exception 'PAYMENT_INVALID_STATUS'; end if;
 -- Same lock order as invoice payments: agency, invoice, service.
 select * into s from public.services where id=p_service_id and tenant_id=p_tenant_id;
 if not found then raise exception 'STATEMENT_SERVICE_NOT_FOUND'; end if;
 perform 1 from public.agencies where id=s.agency_id and tenant_id=p_tenant_id for update;
 perform 1 from public.agency_invoices inv where inv.tenant_id=p_tenant_id and exists(select 1 from jsonb_array_elements(inv.invoice_data) x where x->>'service_id'=s.id::text) order by inv.id for update;
 select * into s from public.services where id=p_service_id and tenant_id=p_tenant_id for update;
 amount:=case when p_status='paid' then coalesce(s.agency_quoted_price_cents,s.source_total_amount_cents,0) else coalesce(p_amount,0) end;
 if amount<0 or amount>coalesce(s.agency_quoted_price_cents,s.source_total_amount_cents,0) then raise exception 'STATEMENT_PAYMENT_EXCEEDS_BALANCE'; end if;
 update public.services set agency_payment_status=p_status,agency_paid_amount_cents=amount,agency_paid_at=case when amount>0 then current_date else null end where id=s.id and tenant_id=p_tenant_id;
 for i in select id from public.agency_invoices inv where inv.tenant_id=p_tenant_id and exists(select 1 from jsonb_array_elements(inv.invoice_data) x where x->>'service_id'=s.id::text) loop perform public.refresh_agency_statement(p_tenant_id,i.id); end loop;
end $$;

-- One atomic review submission: no race, no partial disputes, drafts never notify.
create or replace function public.review_agency_statement(p_tenant_id uuid,p_agency_id uuid,p_invoice_id uuid,p_action text,p_corrections jsonb,p_user_id uuid default null) returns jsonb language plpgsql security invoker set search_path=public as $$
declare i public.agency_invoices%rowtype; c jsonb; line jsonb; result jsonb:='[]'; d uuid;
begin
 select * into i from public.agency_invoices where id=p_invoice_id and tenant_id=p_tenant_id and agency_id=p_agency_id for update;
 if not found then raise exception 'STATEMENT_NOT_FOUND'; end if;
 if i.agency_review_status<>'pending' then raise exception 'STATEMENT_ALREADY_REVIEWED'; end if;
 if p_action not in('draft','approve','dispute') or jsonb_typeof(p_corrections)<>'array' then raise exception 'STATEMENT_REVIEW_INVALID'; end if;
 if (select count(*) from jsonb_array_elements(p_corrections))<>(select count(distinct x->>'service_id') from jsonb_array_elements(p_corrections) x) then raise exception 'STATEMENT_REVIEW_DUPLICATE_LINE'; end if;
 for c in select * from jsonb_array_elements(p_corrections) loop
  select x into line from jsonb_array_elements(i.invoice_data) x where x->>'service_id'=c->>'service_id';
  if not found or jsonb_typeof(line->'importo_cents')<>'number' or coalesce(line->>'importo_cents','') !~ '^[0-9]+$' then raise exception 'STATEMENT_REVIEW_INVALID_LINE'; end if;
  if not exists(select 1 from public.services s where s.id=(c->>'service_id')::uuid and s.tenant_id=p_tenant_id and (s.agency_id=p_agency_id or(s.agency_id is null and lower(trim(s.billing_party_name))=lower(trim(i.agency_name))))) then raise exception 'STATEMENT_REVIEW_INVALID_LINE'; end if;
  if (c->>'proposed_price_cents')::integer<0 or (c->>'proposed_price_cents')::integer>9999900 or nullif(c->>'proposed_price_cents','') is null then raise exception 'STATEMENT_REVIEW_INVALID_LINE'; end if;
 end loop;
 if p_action='draft' then update public.agency_invoices set review_draft=p_corrections,review_draft_updated_at=now() where id=i.id; return jsonb_build_object('draft',true); end if;
 if p_action='dispute' and jsonb_array_length(p_corrections)=0 then raise exception 'STATEMENT_REVIEW_EMPTY'; end if;
 if p_action='approve' and jsonb_array_length(p_corrections)>0 then raise exception 'STATEMENT_REVIEW_HAS_DRAFT'; end if;
 if p_action='dispute' then
  for c in select * from jsonb_array_elements(p_corrections) loop
   select x into line from jsonb_array_elements(i.invoice_data) x where x->>'service_id'=c->>'service_id';
   insert into public.agency_invoice_disputes(tenant_id,agency_id,agency_invoice_id,service_id,original_price_cents,proposed_price_cents,agency_note,status,created_by) values(p_tenant_id,p_agency_id,i.id,(c->>'service_id')::uuid,(line->>'importo_cents')::integer,(c->>'proposed_price_cents')::integer,c->>'note','pending',p_user_id) returning id into d;
   result:=result||jsonb_build_array(jsonb_build_object('id',d,'service_id',c->>'service_id'));
  end loop;
 end if;
 update public.agency_invoices set agency_review_status=case when p_action='approve' then 'approved' else 'disputed' end,agency_reviewed_at=now(),review_draft='[]',review_draft_updated_at=null where id=i.id;
 return jsonb_build_object('draft',false,'disputes',result);
end $$;

create or replace function public.resolve_statement_dispute(p_tenant_id uuid,p_dispute_id uuid,p_action text,p_user_id uuid,p_note text) returns void language plpgsql security invoker set search_path=public as $$
declare d public.agency_invoice_disputes%rowtype; i public.agency_invoices%rowtype; line jsonb; lines jsonb; total integer;
begin
 select * into d from public.agency_invoice_disputes where id=p_dispute_id and tenant_id=p_tenant_id;
 if not found then raise exception 'STATEMENT_DISPUTE_NOT_FOUND'; end if;
 perform 1 from public.agencies where id=d.agency_id and tenant_id=p_tenant_id for update;
 select * into i from public.agency_invoices where id=d.agency_invoice_id and tenant_id=p_tenant_id for update;
 select * into d from public.agency_invoice_disputes where id=p_dispute_id and tenant_id=p_tenant_id for update;
 if d.status<>'pending' or p_action not in('approve','reject') then raise exception 'STATEMENT_ALREADY_REVIEWED'; end if;
 if p_action='approve' then
  if i.id is null then raise exception 'STATEMENT_NOT_FOUND'; end if;
  select x into line from jsonb_array_elements(i.invoice_data) x where x->>'service_id'=d.service_id::text;
  if not found or nullif(line->>'penalty_id','') is not null then raise exception 'STATEMENT_PENALTY_REQUIRES_RECTIFICATION'; end if;
  perform public.refresh_agency_statement(p_tenant_id,i.id);
  select * into i from public.agency_invoices where id=i.id and tenant_id=p_tenant_id;
  select x into line from jsonb_array_elements(i.invoice_data) x where x->>'service_id'=d.service_id::text;
  if coalesce((line->>'paid_cents')::integer,0)>d.proposed_price_cents then raise exception 'STATEMENT_CORRECTION_BELOW_PAID'; end if;
  update public.services set agency_quoted_price_cents=d.proposed_price_cents,agency_payment_status=case when agency_payment_status='waived' then 'waived' when agency_paid_amount_cents>=d.proposed_price_cents then 'paid' else 'unpaid' end where id=d.service_id and tenant_id=p_tenant_id;
  select jsonb_agg(case when x->>'service_id'=d.service_id::text then x||jsonb_build_object('importo_cents',d.proposed_price_cents) else x end order by ord) into lines from jsonb_array_elements(i.invoice_data) with ordinality t(x,ord);
  select sum((x->>'importo_cents')::integer) into total from jsonb_array_elements(lines) x;
  update public.agency_invoices set invoice_data=lines,total_cents=total where id=i.id and tenant_id=p_tenant_id;
  perform public.refresh_agency_statement(p_tenant_id,i.id);
 end if;
 update public.agency_invoice_disputes set status=case when p_action='approve' then 'approved' else 'rejected' end,resolved_by=p_user_id,resolved_at=now(),resolution_note=p_note where id=d.id and tenant_id=p_tenant_id;
end $$;
revoke all on function public.resolve_statement_dispute(uuid,uuid,text,uuid,text) from public,anon,authenticated;
grant execute on function public.resolve_statement_dispute(uuid,uuid,text,uuid,text) to service_role;

-- Own agency documents only; operational roles retain tenant-wide access.
drop policy if exists agency_invoices_tenant_read on public.agency_invoices;
create policy agency_invoices_tenant_read on public.agency_invoices for select to authenticated using(exists(select 1 from public.memberships m where m.user_id=auth.uid() and m.tenant_id=agency_invoices.tenant_id and (m.role::text in('admin','operator','supervisor') or (m.role::text='agency' and m.agency_id=agency_invoices.agency_id))));
grant select on public.agency_statement_payment_reports to authenticated;
create policy agency_statement_reports_read on public.agency_statement_payment_reports for select to authenticated using(exists(select 1 from public.memberships m where m.user_id=auth.uid() and m.tenant_id=agency_statement_payment_reports.tenant_id and (m.role::text in('admin','operator') or (m.role::text='agency' and m.agency_id=agency_statement_payment_reports.agency_id))));

-- One source for the operational account and ledger, including active penalties.
create or replace function public.agency_accounting_rows(p_tenant_id uuid,p_agency_id uuid default null)
returns setof jsonb language sql stable security invoker set search_path=public as $$
 with charges as (
  select s.id service_id,null::uuid penalty_id,s.tenant_id,s.agency_id,s.billing_party_name,coalesce(s.agency_quoted_price_cents,s.source_total_amount_cents) amount,s.agency_paid_amount_cents paid,s.agency_payment_status payment_status,s.agency_paid_at paid_at
  from public.services s where s.tenant_id=p_tenant_id and s.status::text<>'cancelled' and s.is_draft=false and coalesce(s.approval_status::text,'confirmed') in('confirmed','approved') and coalesce(s.agency_quoted_price_cents,s.source_total_amount_cents) is not null
  union all
  select s.id,p.id,s.tenant_id,s.agency_id,s.billing_party_name,p.penalty_amount_cents,p.paid_amount_cents,case when p.paid_amount_cents>=p.penalty_amount_cents then 'paid' else 'unpaid' end,null::date
  from public.service_cancellation_penalties p join public.services s on s.id=p.service_id and s.tenant_id=p.tenant_id where p.tenant_id=p_tenant_id and p.status='active' and p.penalty_amount_cents>0 and s.status::text='cancelled'
 )
 select jsonb_build_object('id',s.id,'penalty_id',c.penalty_id,'customer_name',s.customer_name,'customer_first_name',s.customer_first_name,'customer_last_name',s.customer_last_name,'booking_service_kind',case when c.penalty_id is not null then 'cancellation_penalty' else s.booking_service_kind::text end,'arrival_date',d.arrival_date,'departure_date',d.departure_date,'pax',s.pax,'status',s.status,'approval_status',s.approval_status,'agency_quoted_price_cents',c.amount,'agency_paid_amount_cents',least(c.amount,c.paid),'agency_payment_status',c.payment_status,'agency_paid_at',c.paid_at,'agency_id',a.id,'agency_name',a.name,'hotel_name',coalesce(h.name,'—'))
 from charges c join public.services s on s.id=c.service_id and s.tenant_id=c.tenant_id cross join lateral public.agency_statement_dates(p_tenant_id,s.id) d join public.agencies a on a.tenant_id=c.tenant_id and (a.id=c.agency_id or(c.agency_id is null and lower(trim(a.name))=lower(trim(c.billing_party_name)))) left join public.hotels h on h.id=s.hotel_id and h.tenant_id=s.tenant_id
 where (p_agency_id is null or a.id=p_agency_id) order by s.arrival_date,s.id
$$;
revoke all on function public.agency_accounting_rows(uuid,uuid) from public,anon,authenticated;
grant execute on function public.agency_accounting_rows(uuid,uuid) to service_role;

-- Guard every writer, including the old application during the schema-first rollout.
create or replace function public.guard_agency_statement_insert() returns trigger language plpgsql security invoker set search_path=public as $$
declare yr integer; seq integer;
begin
 if new.agency_id is null then raise exception 'STATEMENT_AGENCY_NOT_FOUND'; end if;
 perform 1 from public.agencies where id=new.agency_id and tenant_id=new.tenant_id for update;
 if not found then raise exception 'STATEMENT_AGENCY_NOT_FOUND'; end if;
 if exists(select 1 from public.agency_invoices i where i.tenant_id=new.tenant_id and i.agency_id=new.agency_id and i.period_from=new.period_from and i.period_to=new.period_to and (i.date_basis=new.date_basis or i.date_basis='legacy' or new.date_basis='legacy')) then raise exception 'STATEMENT_DUPLICATE_PERIOD'; end if;
 if exists(select 1 from public.agency_invoices i cross join lateral jsonb_array_elements(i.invoice_data) old_line cross join lateral jsonb_array_elements(new.invoice_data) new_line where i.tenant_id=new.tenant_id and (old_line->>'service_id'=new_line->>'service_id' or (nullif(new_line->>'penalty_id','') is not null and old_line->>'penalty_id'=new_line->>'penalty_id'))) then raise exception 'STATEMENT_ALREADY_INCLUDED'; end if;
 if new.invoice_number is null then
  yr:=extract(year from timezone('Europe/Rome',now()));
  insert into public.agency_statement_counters values(new.tenant_id,yr,1) on conflict(tenant_id,year) do update set last_number=agency_statement_counters.last_number+1 returning last_number into seq;
  new.invoice_number:='EC-'||yr||'-'||lpad(seq::text,greatest(5,length(seq::text)),'0');
 end if;
 return new;
end $$;
revoke all on function public.guard_agency_statement_insert() from public,anon,authenticated;
grant execute on function public.guard_agency_statement_insert() to service_role;
create trigger agency_statement_insert_guard before insert on public.agency_invoices for each row execute function public.guard_agency_statement_insert();
alter table public.agency_invoices alter column invoice_number set not null;
-- Financial mutations always go through the tenant/role checked HTTP routes and atomic RPCs.
revoke insert,update,delete on public.agency_invoices,public.agency_invoice_disputes from anon,authenticated;

-- No browser may call financial RPCs directly. HTTP routes enforce tenant and role/agency/token scope.
revoke all on function public.create_agency_statement(uuid,uuid,date,date,text),public.refresh_agency_statement(uuid,uuid),public.pay_agency_statement(uuid,uuid,integer,uuid,uuid,text,date,text,uuid),public.set_agency_service_payment(uuid,uuid,text,integer),public.review_agency_statement(uuid,uuid,uuid,text,jsonb,uuid) from public,anon,authenticated;
grant execute on function public.create_agency_statement(uuid,uuid,date,date,text),public.refresh_agency_statement(uuid,uuid),public.pay_agency_statement(uuid,uuid,integer,uuid,uuid,text,date,text,uuid),public.set_agency_service_payment(uuid,uuid,text,integer),public.review_agency_statement(uuid,uuid,uuid,text,jsonb,uuid) to service_role;
notify pgrst,'reload schema';
commit;
