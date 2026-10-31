// Standalone PostgreSQL regression suite. Never connects to a live database.
// Install @electric-sql/pglite in an isolated directory, then set ITS_PGLITE_MODULE
// to its dist/index.js (or install it locally) and run this file with Node.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
const { PGlite } = await import(
  process.env.ITS_PGLITE_MODULE || "@electric-sql/pglite"
);
const db = new PGlite();
await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;
create function auth.uid() returns uuid language sql as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;create table memberships(user_id uuid,tenant_id uuid,role text,agency_id uuid);create table hotels(id uuid,tenant_id uuid,name text);create table tenants(id uuid primary key);create table agencies(id uuid primary key,tenant_id uuid,name text);
create table services(id uuid primary key,tenant_id uuid,agency_id uuid,agency_payment_status text default 'unpaid',agency_paid_at date,agency_quoted_price_cents integer,source_total_amount_cents integer,arrival_date date,departure_date date,date date,is_draft boolean default false,approval_status text,status text,notes text,practice_number text,customer_first_name text,customer_last_name text,customer_name text,booking_service_kind text,service_type text,pax integer,vessel text,meeting_point text,transport_code text,include_ferry_tickets boolean,ferry_details jsonb,bus_city_origin text,billing_party_name text,hotel_id uuid,direction text,linked_service_id uuid);
create table agency_invoices(id uuid primary key default gen_random_uuid(),tenant_id uuid,agency_id uuid,agency_name text,period_from date,period_to date,status text default 'draft',total_cents integer,services_count integer,invoice_data jsonb default '[]',created_at timestamptz default now(),sent_at timestamptz,paid_at timestamptz,paid_by_user_id uuid,payment_note text,agency_review_status text default 'pending',agency_reviewed_at timestamptz);
create table service_cancellation_penalties(id uuid primary key,tenant_id uuid,service_id uuid,linked_service_id uuid,status text,penalty_amount_cents integer);
create table tenant_bus_allocations(tenant_id uuid,service_id uuid,stop_id uuid,direction text);create table tenant_bus_line_stops(id uuid,tenant_id uuid,stop_name text);
create table agency_invoice_disputes(id uuid primary key default gen_random_uuid(),tenant_id uuid,agency_id uuid,agency_invoice_id uuid,service_id uuid,original_price_cents integer,proposed_price_cents integer,agency_note text,status text,created_by uuid,resolved_by uuid,resolved_at timestamptz,resolution_note text);
`);

await db.exec('alter table agency_invoices enable row level security;grant select on agency_invoices,memberships to authenticated;grant usage on schema auth to authenticated;');
const T = randomUUID(),
  A = randomUUID(),
  OTHER = randomUUID(),
  OA = randomUUID();
await db.query("insert into tenants values($1),($2)", [T, OTHER]);
await db.query(
  "insert into agencies values($1,$2,'Test Agency'),($3,$4,'Test Agency')",
  [A, T, OA, OTHER],
);
const legacyService = randomUUID(),
  legacyInvoice = randomUUID();
await db.query(
  "insert into services(id,tenant_id,agency_id,agency_quoted_price_cents,arrival_date,departure_date,status,approval_status,customer_name) values($1,$2,$3,5000,'2026-01-01','2026-01-03','new','confirmed','Legacy')",
  [legacyService, T, A],
);
await db.query(
  "insert into agency_invoices(id,tenant_id,agency_id,agency_name,period_from,period_to,status,total_cents,invoice_data) values($1,$2,$3,'Test Agency','2026-01-01','2026-01-31','paid',5000,$4)",
  [
    legacyInvoice,
    T,
    A,
    JSON.stringify([{ service_id: legacyService, importo_cents: 5000 }]),
  ],
);
await db.exec(
  readFileSync(
    new URL(
      "../../supabase/migrations/20261031061147_agency_statement_accounting.sql",
      import.meta.url,
    ),
    "utf8",
  ),
);
let checks = 0;
async function check(name, fn) {
  await fn();
  checks++;
  console.log("PASS", name);
}
async function service(fields = {}) {
  const id = randomUUID(),
    values = {
      id,
      tenant_id: T,
      agency_id: A,
      agency_quoted_price_cents: 26200,
      arrival_date: "2026-10-31",
      departure_date: "2026-11-14",
      status: "new",
      approval_status: "confirmed",
      customer_name: "Synthetic test",
      ...fields,
    };
  const keys = Object.keys(values);
  await db.query(
    `insert into services(${keys.join(",")}) values(${keys.map((_, i) => "$" + (i + 1)).join(",")})`,
    Object.values(values),
  );
  return id;
}
async function make(
  from = "2026-10-25",
  to = "2026-10-31",
  basis = "arrival",
  agency = A,
  tenant = T,
) {
  return (
    await db.query("select create_agency_statement($1,$2,$3,$4,$5) r", [
      tenant,
      agency,
      from,
      to,
      basis,
    ])
  ).rows[0].r;
}
async function row(id) {
  return (await db.query("select * from agency_invoices where id=$1", [id]))
    .rows[0];
}
async function pay(id, amount = null, key = randomUUID(), report = null) {
  return db.query(
    "select pay_agency_statement($1,$2,$3,$4,null,'Synthetic','2026-10-31','Bonifico',$5)",
    [T, id, amount, key, report],
  );
}
await check(
  "historic paid statements synchronize services and receive a stable number",
  async () => {
    assert.equal(
      (
        await db.query(
          "select agency_paid_amount_cents from services where id=$1",
          [legacyService],
        )
      ).rows[0].agency_paid_amount_cents,
      5000,
    );
    assert.match((await row(legacyInvoice)).invoice_number, /^EC-2026-\d{5}$/);
  },
);
const s = await service();
for (const approval_status of [
  "pending_operator",
  "price_mismatch",
  "rejected",
])
  await service({ approval_status });
await service({ is_draft: true });
await service({ status: "cancelled" });
await service({ tenant_id: OTHER, agency_id: OA });
const doc = await make(),
  I = doc.invoice.id;
await check(
  "arrival criterion includes full booking with return outside period and excludes pending rejected drafts cancelled and other tenant",
  async () => {
    assert.equal(doc.invoice.services_count, 1);
    assert.equal(doc.invoice.total_cents, 26200);
    assert.equal(doc.invoice.invoice_data[0].departure_date, "2026-11-14");
  },
);
await check("same period reuses document and number", async () => {
  const x = await make();
  assert.equal(x.reused, true);
  assert.equal(x.invoice.id, I);
  assert.equal(x.invoice.invoice_number, doc.invoice.invoice_number);
});
await check("overlapping period cannot invoice same booking twice", async () =>
  assert.rejects(() => make("2026-10-01", "2026-11-01"), /ALREADY_INCLUDED/),
);
await check(
  "switching to departure criterion cannot invoice same booking twice",
  async () =>
    assert.rejects(
      () => make("2026-11-01", "2026-11-30", "departure"),
      /ALREADY_INCLUDED/,
    ),
);
await check(
  "departure criterion excludes booking whose return is outside period",
  async () =>
    assert.rejects(
      () => make("2026-10-25", "2026-10-31", "departure"),
      /NO_SERVICES/,
    ),
);
await check("invalid reversed period and criterion fail closed", async () => {
  await assert.rejects(
    () => make("2026-11-01", "2026-10-01"),
    /INVALID_PERIOD/,
  );
  await assert.rejects(
    () => make("2026-11-01", "2026-11-30", "invalid"),
    /INVALID_PERIOD/,
  );
});
await check("unknown agency and cross tenant scope are rejected", async () =>
  assert.rejects(
    () => make("2026-10-01", "2026-10-31", "arrival", OA, T),
    /AGENCY_NOT_FOUND/,
  ),
);
const key = randomUUID();
await check("partial payment updates document service and ledger", async () => {
  await pay(I, 10000, key);
  assert.equal((await row(I)).paid_cents, 10000);
  const rows = (
    await db.query("select agency_accounting_rows($1,$2) r", [T, A])
  ).rows.map((r) => r.r);
  assert.equal(rows.find((r) => r.id === s).agency_paid_amount_cents, 10000);
});
await check("same payment key cannot debit twice", async () => {
  await pay(I, 10000, key);
  assert.equal((await row(I)).paid_cents, 10000);
});
await check("overpayment fails without changing any amount", async () => {
  await assert.rejects(() => pay(I, 20000), /EXCEEDS_BALANCE/);
  assert.equal((await row(I)).paid_cents, 10000);
});
await check("full settlement uses remaining balance", async () => {
  await pay(I);
  const i = await row(I);
  assert.equal(i.paid_cents, 26200);
  assert.equal(i.status, "paid");
  await pay(I);
  assert.equal((await row(I)).paid_cents, 26200);
});
await check(
  "single practice payment reversal and settlement refresh statement",
  async () => {
    await db.query("select set_agency_service_payment($1,$2,'unpaid')", [T, s]);
    assert.equal((await row(I)).paid_cents, 0);
    await db.query("select set_agency_service_payment($1,$2,'paid')", [T, s]);
    assert.equal((await row(I)).status, "paid");
  },
);
await check("waived amounts are separated from cash received", async () => {
  await db.query("select set_agency_service_payment($1,$2,'waived')", [T, s]);
  const i = await row(I);
  assert.equal(i.paid_cents, 0);
  assert.equal(i.waived_cents, 26200);
  await db.query("select set_agency_service_payment($1,$2,'unpaid')", [T, s]);
});
const corrections = JSON.stringify([
  { service_id: s, proposed_price_cents: 25000, note: "Synthetic" },
]);
async function review(action, cs = corrections) {
  return db.query("select review_agency_statement($1,$2,$3,$4,$5,null)", [
    T,
    A,
    I,
    action,
    cs,
  ]);
}
await check(
  "saving review draft creates no dispute and leaves official amounts untouched",
  async () => {
    await review("draft");
    assert.equal((await row(I)).agency_review_status, "pending");
    assert.equal((await row(I)).total_cents, 26200);
    assert.equal(
      (await db.query("select count(*) n from agency_invoice_disputes")).rows[0]
        .n,
      0,
    );
  },
);
await check(
  "invalid or repeated correction lines roll back entire batch",
  async () => {
    await assert.rejects(
      () =>
        review(
          "dispute",
          JSON.stringify([
            { service_id: s, proposed_price_cents: 25000 },
            { service_id: randomUUID(), proposed_price_cents: 1 },
          ]),
        ),
      /INVALID_LINE/,
    );
    await assert.rejects(
      () =>
        review(
          "dispute",
          JSON.stringify([
            { service_id: s, proposed_price_cents: 1 },
            { service_id: s, proposed_price_cents: 2 },
          ]),
        ),
      /DUPLICATE_LINE/,
    );
    assert.equal((await row(I)).agency_review_status, "pending");
  },
);
await check("final batch commits once only and clears draft", async () => {
  await review("dispute");
  await assert.rejects(() => review("dispute"), /ALREADY_REVIEWED/);
  assert.equal((await row(I)).review_draft.length, 0);
  assert.equal(
    (await db.query("select count(*) n from agency_invoice_disputes")).rows[0]
      .n,
    1,
  );
});
await check(
  "operator approval updates snapshot total and service price together",
  async () => {
    const d = (await db.query("select id from agency_invoice_disputes")).rows[0]
      .id;
    await db.query(
      "select resolve_statement_dispute($1,$2,'approve',null,'Synthetic')",
      [T, d],
    );
    assert.equal((await row(I)).total_cents, 25000);
    assert.equal(
      (
        await db.query(
          "select agency_quoted_price_cents p from services where id=$1",
          [s],
        )
      ).rows[0].p,
      25000,
    );
  },
);
const penaltyService = await service({
    status: "cancelled",
    arrival_date: "2026-12-01",
    departure_date: "2026-12-04",
  }),
  linked = await service({
    status: "cancelled",
    arrival_date: "2026-12-01",
    departure_date: "2026-12-04",
  }),
  P = randomUUID();
await db.query(
  "insert into service_cancellation_penalties(id,tenant_id,service_id,linked_service_id,status,penalty_amount_cents) values($1,$2,$3,$4,'active',3000)",
  [P, T, penaltyService, linked],
);
const penDoc = await make("2026-12-01", "2026-12-31");
await check(
  "whole practice penalty is billed once, full cancelled service price excluded",
  async () => {
    assert.equal(penDoc.invoice.services_count, 1);
    assert.equal(penDoc.invoice.total_cents, 3000);
    assert.equal(penDoc.invoice.invoice_data[0].penalty_id, P);
  },
);
await check(
  "penalty payment does not mark original cancelled service price as paid",
  async () => {
    await pay(penDoc.invoice.id);
    assert.equal((await row(penDoc.invoice.id)).paid_cents, 3000);
    assert.equal(
      (
        await db.query(
          "select agency_paid_amount_cents p from services where id=$1",
          [penaltyService],
        )
      ).rows[0].p,
      0,
    );
  },
);
await check(
  "payments reported by agency do not change balances before operator verifies",
  async () => {
    const R = randomUUID();
    await db.query(
      "insert into agency_statement_payment_reports(id,tenant_id,agency_id,invoice_id,amount_cents,paid_on,method) values($1,$2,$3,$4,10000,'2026-10-31','Bonifico')",
      [R, T, A, I],
    );
    assert.equal((await row(I)).paid_cents, 0);
    await pay(I, 10000, R, R);
    assert.equal((await row(I)).paid_cents, 10000);
    assert.equal(
      (
        await db.query(
          "select status from agency_statement_payment_reports where id=$1",
          [R],
        )
      ).rows[0].status,
      "verified",
    );
  },
);
await check("only server role may execute financial RPCs", async () => {
  for (const r of ["anon", "authenticated"]) {
    const x = await db.query(
      "select has_function_privilege($1,'public.pay_agency_statement(uuid,uuid,integer,uuid,uuid,text,date,text,uuid)','EXECUTE') v",
      [r],
    );
    assert.equal(x.rows[0].v, false);
  }
});

await check('missing price blocks generation; explicit zero is accepted',async()=>{const id=await service({arrival_date:'2027-01-01',departure_date:'2027-01-02',agency_quoted_price_cents:null});await assert.rejects(()=>make('2027-01-01','2027-01-31'),/MISSING_PRICE/);await db.query('update services set agency_quoted_price_cents=0 where id=$1',[id]);assert.equal((await make('2027-01-01','2027-01-31')).invoice.total_cents,0);});
await check('agreed price wins over imported amount and agency practice reference is preserved',async()=>{await service({arrival_date:'2027-02-01',departure_date:'2027-02-03',agency_quoted_price_cents:7000,source_total_amount_cents:99000,notes:'[practice:26/014732]',practice_number:'ITS-2027-1'});const x=await make('2027-02-01','2027-02-28');assert.equal(x.invoice.total_cents,7000);assert.equal(x.invoice.invoice_data[0].numero_pratica,'26/014732');});
await check('imported amount is fallback only when agreed amount is absent',async()=>{await service({arrival_date:'2027-03-01',departure_date:'2027-03-03',agency_quoted_price_cents:null,source_total_amount_cents:1234});assert.equal((await make('2027-03-01','2027-03-31')).invoice.total_cents,1234);});
await check('simultaneous repeated generation returns a single document',async()=>{await service({arrival_date:'2027-04-01',departure_date:'2027-04-03'});const x=await Promise.all([make('2027-04-01','2027-04-30'),make('2027-04-01','2027-04-30')]);assert.equal(x[0].invoice.id,x[1].invoice.id);assert.equal(x.filter(v=>v.reused).length,1);});
await check('already paid practices produce settled statements with no residual',async()=>{await service({arrival_date:'2027-05-01',departure_date:'2027-05-03',agency_payment_status:'paid',agency_paid_amount_cents:26200});const x=await make('2027-05-01','2027-05-31');assert.equal(x.invoice.paid_cents,26200);assert.equal(x.invoice.status,'paid');});
await check('correction below verified payments rolls back official amount and dispute state',async()=>{const d=randomUUID();await db.query("insert into agency_invoice_disputes(id,tenant_id,agency_id,agency_invoice_id,service_id,original_price_cents,proposed_price_cents,status) values($1,$2,$3,$4,$5,25000,5000,'pending')",[d,T,A,I,s]);await assert.rejects(()=>db.query("select resolve_statement_dispute($1,$2,'approve',null,'Synthetic')",[T,d]),/BELOW_PAID/);assert.equal((await row(I)).total_cents,25000);assert.equal((await db.query('select status from agency_invoice_disputes where id=$1',[d])).rows[0].status,'pending');});
await check('a service reassigned to another agency cannot be revised through an old statement',async()=>{const id=await service({arrival_date:'2027-06-01',departure_date:'2027-06-03'}),i=(await make('2027-06-01','2027-06-30')).invoice.id;await db.query('update services set agency_id=$1 where id=$2',[OA,id]);await assert.rejects(()=>db.query('select review_agency_statement($1,$2,$3,$4,$5,null)',[T,A,i,'dispute',JSON.stringify([{service_id:id,proposed_price_cents:1}])]),/INVALID_LINE/);});

await check('agency RLS exposes only own documents and payment reports, never another tenant',async()=>{const u=randomUUID();await db.query("insert into memberships values($1,$2,'agency',$3)",[u,T,A]);await db.query("insert into agency_invoices(tenant_id,agency_id,agency_name,period_from,period_to,total_cents) values($1,$2,'Other','2027-01-01','2027-01-31',1)",[OTHER,OA]);await db.query("select set_config('request.jwt.claim.sub',$1,false)",[u]);await db.exec('set role authenticated');const visible=(await db.query('select tenant_id,agency_id from agency_invoices')).rows;assert.ok(visible.length>0);assert.ok(visible.every(r=>r.tenant_id===T&&r.agency_id===A));const reports=(await db.query('select tenant_id,agency_id from agency_statement_payment_reports')).rows;assert.ok(reports.every(r=>r.tenant_id===T&&r.agency_id===A));await db.exec('reset role');});

await check('explicitly linked legs use booking arrival to include return charge outside period',async()=>{const out=await service({arrival_date:null,departure_date:null,date:'2027-07-31',direction:'arrival',agency_quoted_price_cents:1000}),back=await service({arrival_date:null,departure_date:null,date:'2027-08-14',direction:'departure',agency_quoted_price_cents:2000,linked_service_id:out});await db.query('update services set linked_service_id=$1 where id=$2',[back,out]);const x=await make('2027-07-25','2027-07-31');assert.equal(x.invoice.total_cents,3000);assert.equal(x.invoice.services_count,2);assert.ok(x.invoice.invoice_data.every(i=>i.arrival_date==='2027-07-31'&&i.departure_date==='2027-08-14'));});
console.log(`Verified ${checks} PostgreSQL accounting scenarios.`);
await db.close();
