-- =============================================================================
-- Private storage buckets. Clients only ever get short-lived signed URLs (60 s).
-- Object paths contain IDs only – never names or clinical words.
--   medical-documents/patients/<patient_id>/<document_id>.<ext>
--   prescriptions/<appointment_id>/<prescription_id>-v<version>.pdf   (written by edge function)
--   signatures/<doctor_id>.png                                          (admin uploads)
-- =============================================================================
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
  ('medical-documents', 'medical-documents', false, 10485760, array['application/pdf', 'image/jpeg', 'image/png', 'audio/webm', 'audio/ogg', 'audio/mp4']),
  ('prescriptions', 'prescriptions', false, 5242880, array['application/pdf']),
  ('signatures', 'signatures', false, 1048576, array['image/png'])
on conflict (id) do nothing;

-- patient_id is the 2nd path segment
create or replace function public.storage_patient_id(name text)
returns uuid language sql immutable as $$
  select case when split_part(name, '/', 1) = 'patients' then nullif(split_part(name, '/', 2), '')::uuid end;
$$;

create policy "docs read" on storage.objects for select using (
  bucket_id = 'medical-documents' and (
    public.storage_patient_id(name) in (select public.my_patient_ids())
    or public.doctor_sees_patient(public.storage_patient_id(name))
    or public.staff_ok('admin')
  )
);
create policy "docs upload" on storage.objects for insert with check (
  bucket_id = 'medical-documents' and (
    public.storage_patient_id(name) in (select public.my_patient_ids())
    or public.doctor_sees_patient(public.storage_patient_id(name))
  )
);
create policy "docs delete" on storage.objects for delete using (
  bucket_id = 'medical-documents' and public.storage_patient_id(name) in (select public.my_patient_ids())
);
-- prescriptions & signatures: service role only (edge functions); reads via signed URLs minted server-side.
create policy "signatures admin" on storage.objects for all using (bucket_id = 'signatures' and public.staff_ok('admin')) with check (bucket_id = 'signatures' and public.staff_ok('admin'));
