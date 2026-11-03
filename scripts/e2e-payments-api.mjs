/**
 * Payments end to end through the real API (gateway → edge functions → Postgres), no browser:
 * hold → order (idempotent) → test checkout → server signature verify → confirmation; forged signature
 * rejected; webhook signature + idempotency (same event twice); late webhook after verify; receipt PDF;
 * partial + full refunds by finance; patient cancellation refund; reconciliation export; refund sweep.
 *
 *   npm run stack:up   then   node scripts/e2e-payments-api.mjs [http://127.0.0.1:54321]
 */
import { createClient } from '@supabase/supabase-js';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';

const URL_ = process.argv[2] ?? 'http://127.0.0.1:54321';
const keys = Object.fromEntries(readFileSync('.local-stack/keys.env', 'utf8').trim().split('\n').map((l) => l.split(/=(.*)/s).slice(0, 2)));
const ok = (s) => console.log('✓', s);
const assert = (c, msg) => { if (!c) { console.error('✗', msg); process.exit(1); } };
const client = () => createClient(URL_, keys.ANON_KEY, { auth: { persistSession: false } });
const svc = createClient(URL_, keys.SERVICE_KEY, { auth: { persistSession: false } });

async function phoneLogin(phone) {
  const c = client();
  await c.auth.signInWithOtp({ phone });
  const { error } = await c.auth.verifyOtp({ phone, token: '123456', type: 'sms' });
  assert(!error, `login ${phone}: ${error?.message}`);
  return c;
}
async function staffLogin(email) {
  const c = client();
  const { error } = await c.auth.signInWithPassword({ email, password: 'Sunrise@123' });
  assert(!error, `login ${email}`);
  return c;
}
async function fn(c, name, body, raw = false) {
  const { data } = await c.auth.getSession();
  const res = await fetch(`${URL_}/functions/v1/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', apikey: keys.ANON_KEY, authorization: `Bearer ${data.session?.access_token ?? keys.ANON_KEY}` },
    body: JSON.stringify(body),
  });
  return raw ? res : { status: res.status, body: await res.json().catch(() => null) };
}
const webhook = (event, payload, eventId) => {
  const body = JSON.stringify({ event, created_at: Math.floor(Date.now() / 1000), payload });
  const sig = createHmac('sha256', keys.MOCK_WEBHOOK_SECRET).update(body).digest('hex');
  return fetch(`${URL_}/functions/v1/payments-webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-razorpay-signature': sig, 'x-razorpay-event-id': eventId }, body });
};

// ---------------------------------------------------------------- book a paid slot (Rajan → Dr Meera, first consult)
const rajan = await phoneLogin('+919847000002');
const { data: fam } = await rajan.from('patients').select('id').eq('is_primary', true).single();
const doctor = '00000004-0000-4000-8000-000000000002';
async function holdPaid(c, patientId, offsetSlots = 0) {
  const { data: slots } = await c.from('slots').select('id, start_at').eq('doctor_id', doctor).eq('status', 'open').gt('start_at', new Date(Date.now() + 26 * 3600e3).toISOString()).order('start_at').limit(10);
  for (const s of slots.slice(offsetSlots)) {
    const { data: q } = await c.rpc('booking_preview', { p_doctor: doctor, p_patient: patientId, p_slot: s.id, p_mode: 'video' });
    if (q.is_free) continue;
    const { data, error } = await c.rpc('hold_slot', { p_doctor: doctor, p_patient: patientId, p_slot: s.id, p_mode: 'video', p_symptoms: { body_area: 'general', symptoms: ['fever'], duration: 'today', severity: 3, description: 'API payment test', vitals: {} }, p_document_ids: [] });
    assert(!error, `hold: ${error?.message}`);
    return data;
  }
  assert(false, 'no paid slot found');
}
const appt = await holdPaid(rajan, fam.id);
assert(appt.fee_amount > 0 && !appt.is_free, 'paid hold');
ok(`hold ${appt.ref_code}: ₹${appt.fee_amount}, pending payment`);

// ---------------------------------------------------------------- order (idempotent)
const o1 = await fn(rajan, 'payments-create-order', { appointment_id: appt.id });
const o2 = await fn(rajan, 'payments-create-order', { appointment_id: appt.id });
assert(o1.status === 200 && o1.body.amount === appt.fee_amount && o1.body.provider === 'mock', `order: ${JSON.stringify(o1.body)}`);
assert(o2.body.order_id === o1.body.order_id, 'second Pay tap reuses the order');
ok(`order ${o1.body.order_id}: amount from the DB, reused on retry`);
const anjali = await phoneLogin('+919847000001');
const foreign = await fn(anjali, 'payments-create-order', { appointment_id: appt.id });
assert(foreign.status === 404, 'another family cannot create an order for this booking');
ok('another family gets 404');

// ---------------------------------------------------------------- checkout + verify
const fail = await fn(rajan, 'payments-mock-checkout', { order_id: o1.body.order_id, method: 'card', outcome: 'failure' });
assert(fail.status === 402, 'declined payment');
const pay = (await fn(rajan, 'payments-mock-checkout', { order_id: o1.body.order_id, method: 'upi', outcome: 'success' })).body;
const forged = await fn(rajan, 'payments-verify', { order_id: pay.razorpay_order_id, payment_id: pay.razorpay_payment_id.replace(/_(\d+)_/, '_1_'), signature: pay.razorpay_signature });
assert(forged.status === 400 && forged.body.error === 'bad_signature', 'tampered payment id rejected');
ok('decline handled; tampered payment (₹0.01) rejected by signature check');
const v = await fn(rajan, 'payments-verify', { order_id: pay.razorpay_order_id, payment_id: pay.razorpay_payment_id, signature: pay.razorpay_signature });
assert(v.status === 200 && v.body.result === 'confirmed' && /^SCR-\d{4}-\d{6}$/.test(v.body.receipt_no), `verify: ${JSON.stringify(v.body)}`);
const { data: after } = await rajan.from('appointments').select('status').eq('id', appt.id).single();
assert(after.status === 'confirmed', 'confirmed');
ok(`verified → booking confirmed, receipt ${v.body.receipt_no}`);

// ---------------------------------------------------------------- webhook: signature + idempotency (+ the mock's own webhook arriving late)
const entity = { id: pay.razorpay_payment_id, order_id: pay.razorpay_order_id, method: 'upi', amount: appt.fee_amount * 100, status: 'captured' };
const bad = await fetch(`${URL_}/functions/v1/payments-webhook`, { method: 'POST', headers: { 'x-razorpay-signature': 'deadbeef', 'x-razorpay-event-id': 'evt_x' }, body: '{}' });
assert(bad.status === 400, 'unsigned webhook rejected');
const evtId = `evt_test_${Date.now()}`;
const w1 = await webhook('payment.captured', { payment: { entity } }, evtId);
const w2 = await webhook('payment.captured', { payment: { entity } }, evtId);
assert(w1.status === 200 && (await w1.text()) === 'ok' && w2.status === 200 && (await w2.text()) === 'duplicate', 'webhook idempotency');
await new Promise((r) => setTimeout(r, 2500)); // mock gateway's own payment.captured webhook
const { data: pays } = await svc.from('payments').select('id, status, receipt_no, verified_via').eq('appointment_id', appt.id);
const { count: notes } = await svc.from('notifications').select('id', { count: 'exact', head: true }).eq('template_key', 'payment_received').eq('channel', 'in_app').eq('variables->>ref', appt.ref_code);
assert(pays.length === 1 && pays[0].status === 'captured' && pays[0].verified_via === 'checkout' && notes === 1, `single capture: ${JSON.stringify(pays)} notes=${notes}`);
ok('bad webhook signature → 400; same event twice → processed once; late webhooks after verify → no double capture');

// ---------------------------------------------------------------- receipt PDF
const rec = await fn(rajan, 'payments-receipt', { payment_id: pays[0].id }, true);
const pdf = Buffer.from(await rec.arrayBuffer());
assert(rec.status === 200 && rec.headers.get('content-type') === 'application/pdf' && pdf.subarray(0, 5).toString() === '%PDF-', 'receipt pdf');
assert(!/fever|API payment test/i.test(pdf.toString('latin1')), 'no clinical content in the receipt');
assert((await fn(anjali, 'payments-receipt', { payment_id: pays[0].id })).status === 404, 'other family cannot get the receipt');
ok(`receipt PDF (${pdf.length} bytes), no clinical text, private to the family`);

// ---------------------------------------------------------------- refunds by finance: partial then the rest
const finance = await staffLogin('finance@sunrise.demo');
assert((await fn(rajan, 'payments-refund', { payment_id: pays[0].id, amount: 100, reason: 'Patient asking' })).status === 403, 'patient cannot refund');
const r1 = await fn(finance, 'payments-refund', { payment_id: pays[0].id, amount: 100, reason: 'Partial: audio quality issue' });
assert(r1.status === 200 && r1.body.refund.status === 'processed', `partial refund ${JSON.stringify(r1.body)}`);
const over = await fn(finance, 'payments-refund', { payment_id: pays[0].id, amount: appt.fee_amount, reason: 'Too much' });
assert(over.status === 409 && over.body.error === 'invalid_amount', 'over-refund rejected');
let { data: p1 } = await svc.from('payments').select('status').eq('id', pays[0].id).single();
assert(p1.status === 'partially_refunded', 'partially refunded');
const r2 = await fn(finance, 'payments-refund', { payment_id: pays[0].id, amount: appt.fee_amount - 100, reason: 'Remaining amount: goodwill' });
({ data: p1 } = await svc.from('payments').select('status').eq('id', pays[0].id).single());
assert(r2.body.refund.status === 'processed' && p1.status === 'refunded', 'fully refunded');
ok(`refunds: ₹100 partial → partially_refunded; over-refund blocked; ₹${appt.fee_amount - 100} rest → refunded`);

// ---------------------------------------------------------------- patient cancellation → policy refund
const appt2 = await holdPaid(rajan, fam.id, 1);
const ord = (await fn(rajan, 'payments-create-order', { appointment_id: appt2.id })).body;
const pay2 = (await fn(rajan, 'payments-mock-checkout', { order_id: ord.order_id, method: 'netbanking', outcome: 'success' })).body;
await fn(rajan, 'payments-verify', { order_id: pay2.razorpay_order_id, payment_id: pay2.razorpay_payment_id, signature: pay2.razorpay_signature });
const { data: quote } = await rajan.rpc('refund_quote', { p_appt: appt2.id, p_cancelled_by: 'patient' });
const c = await fn(rajan, 'payments-refund', { appointment_id: appt2.id, cancel: true, reason: 'Feeling better' });
assert(c.status === 200 && c.body.amount === quote.amount && c.body.refund?.status === 'processed', `cancel ${JSON.stringify(c.body)}`);
ok(`patient cancels >2 h ahead → ${quote.percent}% (₹${quote.amount}) refunded per policy`);

// ---------------------------------------------------------------- reconciliation export + sweep
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
const { data: rows, error: re } = await finance.rpc('reconciliation_report', { p_from: today, p_to: today });
assert(!re && rows.some((r) => r.ref_code === appt.ref_code && r.kind === 'payment') && rows.filter((r) => r.ref_code === appt.ref_code && r.kind === 'refund').length === 2, 'recon rows');
const { error: pe } = await rajan.rpc('reconciliation_report', { p_from: today, p_to: today });
assert(pe?.message === 'forbidden', 'patients cannot export');
const sweepRes = await fetch(`${URL_}/functions/v1/payments-refund`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${keys.SERVICE_KEY}` }, body: '{"sweep":true}' });
const sweepAnon = await fn(rajan, 'payments-refund', { sweep: true });
assert(sweepRes.status === 200 && sweepAnon.status === 403, 'sweep is service-only');
ok(`reconciliation: ${rows.length} movements today; export staff-only; refund sweep service-only`);
console.log('\nall payment API checks passed');
