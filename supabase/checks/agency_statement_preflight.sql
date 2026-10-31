-- READ ONLY. Run before applying 20261031061147_agency_statement_accounting.sql.
-- Existing duplicate documents are retained, never deleted automatically.
select tenant_id,agency_id,period_from,period_to,count(*) documents
from public.agency_invoices group by 1,2,3,4 having count(*)>1;
select count(*) malformed_snapshot_rows from public.agency_invoices i cross join lateral jsonb_array_elements(i.invoice_data) x
where jsonb_typeof(x->'importo_cents') is distinct from 'number' or coalesce(x->>'importo_cents','') !~ '^[0-9]+$';
select count(*) paid_statements_with_cancelled_services from public.agency_invoices i cross join lateral jsonb_array_elements(i.invoice_data) x join public.services s on s.id::text=x->>'service_id' and s.tenant_id=i.tenant_id where i.status='paid' and s.status::text='cancelled';
select column_name,data_type from information_schema.columns where table_schema='public' and table_name='services' and column_name in('agency_id','agency_payment_status','agency_paid_at','arrival_date','departure_date','linked_service_id','direction','agency_quoted_price_cents','source_total_amount_cents');
