-- Outbox rows for channels that were not used (no opt-in, opted out, no phone) are kept as 'skipped' so
-- the admin Outbox can show why a patient did not get a WhatsApp / SMS. Own migration: a new enum value
-- can't be used in the transaction that adds it.
alter type notification_status add value if not exists 'skipped';
