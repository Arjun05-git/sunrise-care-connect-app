-- Optional consent for Sunrise to contact the patient about its services (LeadSquared). Never pre-ticked;
-- no LeadSquared event is sent without it. Own file: a new enum value can't be used in the same transaction.
alter type consent_type add value if not exists 'marketing';
