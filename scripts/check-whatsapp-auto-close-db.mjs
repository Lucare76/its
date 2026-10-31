// Run against an isolated PGlite database, never against production.
// PGLITE_MODULE points to an installed @electric-sql/pglite module.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const { PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite');
const db = new PGlite();
await db.exec(`create role anon; create role authenticated; create role service_role;
create table whatsapp_threads (id text primary key, tenant_id text, status text, match_status text,
unread_count integer, last_message_at timestamptz, updated_at timestamptz);
create table whatsapp_messages (id text primary key, tenant_id text, thread_id text, direction text,
status text, timestamp timestamptz, created_at timestamptz, raw_message jsonb);
create table system_job_runs (job_key text, job_name text, source text, started_at timestamptz,
finished_at timestamptz, status text, processed_count int, success_count int, metadata jsonb);`);
const sql = await readFile(new URL('../supabase/operations/whatsapp_auto_close.sql', import.meta.url), 'utf8');
await db.exec(sql.split('-- Same name updates')[0]);
let checks = 0;
async function scenario(name, change, expected) {
  await db.exec(`begin;
    insert into whatsapp_threads values ('t','a','open','matched',0,now()-interval '25 hours',now()-interval '25 hours');
    insert into whatsapp_messages values ('m','a','t','outbound','sent',now()-interval '25 hours',now()-interval '25 hours','{}');
    ${change}`);
  const result = (await db.query('select close_inactive_whatsapp_threads() as result')).rows[0].result;
  assert.equal(result.closed, expected, name);
  assert.equal((await db.query('select count(*)::int as n from whatsapp_messages')).rows[0].n, change.includes('delete from whatsapp_messages') ? 0 : change.includes("'m2'") ? 2 : 1, `${name}: history retained`);
  assert.equal((await db.query("select count(*)::int as n from system_job_runs where status='success'")).rows[0].n, 1, `${name}: monitored`);
  if (expected) assert.equal((await db.query('select close_inactive_whatsapp_threads() as result')).rows[0].result.closed, 0, `${name}: idempotent`);
  await db.exec('rollback');
  checks++;
}
await scenario('old successful outbound', '', 1);
await scenario('delivered outbound', "update whatsapp_messages set status='delivered';", 1);
await scenario('read outbound', "update whatsapp_messages set status='read';", 1);
for (const [name, change] of [
 ['exact 24 hour boundary', "update whatsapp_threads set last_message_at=now()-interval '24 hours'; update whatsapp_messages set timestamp=now()-interval '24 hours';"],
 ['recent send', "update whatsapp_threads set last_message_at=now();"],
 ['unread customer message', 'update whatsapp_threads set unread_count=1;'],
 ['needs review', "update whatsapp_threads set status='needs_review';"],
 ['ambiguous association', "update whatsapp_threads set match_status='ambiguous';"],
 ['unmatched', "update whatsapp_threads set match_status='unmatched';"],
 ['review association', "update whatsapp_threads set match_status='needs_review';"],
 ['already closed', "update whatsapp_threads set status='closed';"],
 ['manual reopen', 'update whatsapp_threads set updated_at=now();'],
 ['inbound even if marked read', "update whatsapp_messages set direction='inbound';"],
 ['failed send', "update whatsapp_messages set status='failed';"],
 ['queued send', "update whatsapp_messages set status='queued';"],
 ['automatic office reply', `update whatsapp_messages set raw_message='{"source":"office_closed_auto_reply"}';`],
 ['unowned thread', 'update whatsapp_threads set tenant_id=null;'],
 ['different tenant', "update whatsapp_messages set tenant_id='b';"],
 ['no history', 'delete from whatsapp_messages;'],
 ['null timestamp', 'update whatsapp_messages set timestamp=null;'],
 ['inconsistent timestamp', "update whatsapp_messages set timestamp=now()-interval '26 hours';"],
 ['ambiguous tied reply', "insert into whatsapp_messages select 'm2',tenant_id,thread_id,'inbound','received',timestamp,created_at,raw_message from whatsapp_messages;"],
 ['newer inbound', "insert into whatsapp_messages select 'm2',tenant_id,thread_id,'inbound','received',now(),now(),raw_message from whatsapp_messages;"],
]) await scenario(name, change, 0);
const privs = (await db.query(`select has_function_privilege('anon','public.close_inactive_whatsapp_threads()','execute') as anon,
has_function_privilege('authenticated','public.close_inactive_whatsapp_threads()','execute') as authenticated,
has_function_privilege('service_role','public.close_inactive_whatsapp_threads()','execute') as service`)).rows[0];
assert.deepEqual(privs, { anon: false, authenticated: false, service: true });
checks++;
console.log(`${checks} PostgreSQL scenarios passed`);
await db.close();
