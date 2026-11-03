# Fees, follow-ups and payments

## Rules (Postgres is the source of truth — `supabase/migrations/20261101000007_payments.sql`)

**Fee** = doctor-specific fee for the mode and consult type, otherwise the department default; a follow-up with no follow-up fee is charged the first-consult fee. Healthcare services are GST-exempt, so the total is the fee. The fee is **frozen on the appointment when the slot is held**, so later fee changes never alter a quoted booking.

**Follow-up engine** (`determine_consult_type`, policy in `follow_up_policy`, editable under Admin → Policies):
1. *Index consult* = the patient's latest **completed, paid** consult that matches the doctor rule (same doctor / same department / any) and ended before the new slot. Free follow-ups, no-shows and cancelled consults are never index consults.
2. New slot within **`free_window_days`** of the index consult ending (boundary inclusive) → follow-up. It is free while fewer than **`free_follow_up_count`** free follow-ups were used against that index (cancelled ones don't count); otherwise the follow-up fee applies.
3. Otherwise an active **admin override** makes it free: per patient, optional doctor, 1–5 consults, valid until a date (≤ 180 days), reason required, revocable. Each use consumes one.

**Refunds**
- Patient cancels: `cancellation_tiers` (hours before start → %), default ≥ 2 h → 100 %, later → 0 %. A tier for 0 h is mandatory so every moment is covered.
- Doctor, admin or system cancels: 100 %. Free consults: nothing to refund.
- Finance / admin can refund any captured payment **fully or partially** (reason required). The total of non-failed refunds can never exceed the amount paid. Payment status: `captured → partially_refunded → refunded`; refund status: `initiated → processed | failed` (failed can be retried).
- Payment completes after the 10-minute hold lapsed: the booking is reinstated if the slot is still free, otherwise the money is **refunded in full automatically**.

Every policy, fee, override and refund change goes through an RPC that checks the role, requires a reason and writes it to the audit log.

## Flow
```
Pay ─▶ payments-create-order ─▶ prepare_payment (owner, hold alive, not free; amount from DB)
                               └▶ provider.createOrder ─▶ register_payment_order (one open order per booking)
     ◀─ checkout (Razorpay Standard Checkout | test gateway dialog)
     ─▶ payments-verify ─▶ HMAC(order|payment, key secret) ─▶ gateway lookup (status, amount; capture if authorised)
                         └▶ capture_payment (idempotent) ─▶ appointment confirmed, slot booked, receipt no., notification
Razorpay ─▶ payments-webhook ─▶ HMAC(body, webhook secret) ─▶ payment_webhook_events (event id = idempotency key)
                              └▶ payment.captured / order.paid / payment.failed / refund.* / settlement.processed
Refund ─▶ payments-refund ─▶ request_refund | cancel_appointment ─▶ claim_refund (row lock + 5-min lease)
                            └▶ provider.refund(receipt = our refund id) ─▶ settle_refund
```
Free follow-ups never reach the payment functions (`confirm_free_booking`; `prepare_payment` rejects them).

## PaymentProvider
`supabase/functions/_shared/payments/provider.ts` — `createOrder`, `verifyPaymentSignature`, `verifyWebhookSignature`, `getPayment`, `capture`, `refund`, `findRefund`. Implementations: `RazorpayProvider` (REST, paise, Basic auth) and `MockProvider` (same signature scheme, for local / CI). The browser side (`src/services/payments`) only opens the checkout and passes the signed result to the server.

## Razorpay test mode
1. Dashboard → Test mode → API keys: `rzp_test_…` key id + secret. Webhooks: URL `https://<project>.supabase.co/functions/v1/payments-webhook`, a secret, events `payment.authorized, payment.captured, order.paid, payment.failed, refund.processed, refund.failed, settlement.processed`.
2. `supabase secrets set PAYMENTS_PROVIDER=razorpay RAZORPAY_KEY_ID=rzp_test_… RAZORPAY_KEY_SECRET=… RAZORPAY_WEBHOOK_SECRET=…`
3. `supabase functions deploy payments-create-order payments-verify payments-webhook payments-refund payments-receipt` (`payments-webhook` has `verify_jwt = false` in `config.toml`; it is authenticated by signature).
4. Schedule `payments-refund {"sweep": true}` with the service key every few minutes (pg_cron + pg_net) to retry refunds that could not be sent.
Locally: export the three `RAZORPAY_*` variables before `npm run stack:up`. Without them the stack uses the test gateway (`PAYMENTS_ALLOW_MOCK=true`; never set this in production — the functions refuse to fall back to the mock otherwise).

Secrets live only in function env vars; the browser gets the public key id. No clinical data is sent to the gateway (notes carry the booking reference only), printed on receipts or included in the reconciliation export.

## Admin screens
- **Fees** — department defaults and per-doctor fees (shown as *Own*, *Dept* or *= first*), edit with reason, revert a doctor to the department fee.
- **Policies** — follow-up window / count / doctor rule with a plain-language preview, cancellation refund tiers, follow-up overrides (search patient by name, mobile or MRN).
- **Payments** — date / status / reference filters, collected / refunded / net totals, detail drawer (gateway ids, receipt, settlement, refund history with retry), full or partial refund with the policy amount shown for reference, cancel booking (admin), receipt PDF, **Reconciliation CSV** (one row per capture and refund, IST, no patient names; Excel-safe).
Finance can change fees and refund; policies and overrides are admin-only.

## Tests
| | |
|---|---|
| `supabase/tests/payments_rules.sql` (in `npm run db:test`) | 83 checks: follow-up window boundaries, count, doctor rules, index rules, overrides (grant / scope / expiry / consumption / revoke / audit / roles), fees (precedence, fallback, frozen, audit), capture idempotency + late payments, refund tiers and boundaries, partial / full / failed / retried refunds, cancellations, reconciliation, receipt access |
| `supabase/functions/_shared/payments/payments.test.ts` | signatures, Razorpay request shapes (paise, auth, receipts), mock round trip, receipt PDF |
| `src/features/admin/admin.test.ts` | CSV escaping / formula injection, effective fee, refundable amount |
| `npm run e2e:payments-api` | real API: order idempotency, decline, forged signature, webhook signature + replay, receipt privacy, partial / full refunds, cancellation refund, export, sweep |
| `npm run e2e:payments` | browser: patient pays (decline then UPI) → receipt; admin fees, policies, overrides, partial refund, CSV; finance read-only |
