-- New outcome for a consultation neither side joined. Kept in its own migration: a new enum value
-- can't be used in the transaction that adds it (the rules that use it follow in 20261101000012).
alter type appointment_outcome add value if not exists 'both_no_show';
