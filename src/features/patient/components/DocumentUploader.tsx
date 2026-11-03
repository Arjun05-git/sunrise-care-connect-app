import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Camera, Eye, FileText, ImageIcon, Paperclip, RotateCw, Trash2, Upload, X } from 'lucide-react';
import { isNative, takePhoto } from '@/lib/native';
import type { DocumentTag, MedicalDocument } from '@/domain/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useAuth } from '@/auth/AuthProvider';
import { deleteDocument, qk, signedDocumentUrl, uploadDocument, useLooseDocuments } from '../api';
import { ACCEPT, formatBytes, MAX_FILES_PER_CONSULT, MAX_UPLOAD_BYTES, validateFile } from '../documents';

const TAGS: DocumentTag[] = ['lab_report', 'imaging', 'prescription', 'discharge_summary', 'photo', 'other'];

interface Pending {
  key: string;
  file: File;
  progress: number;
  error?: string;
  abort: AbortController;
}

interface Preview {
  name: string;
  mime: string;
  url: string;
}

/**
 * Upload reports / photos for the doctor. Files are checked (type by extension AND magic bytes,
 * size ≤ 10 MB) before upload, uploaded with progress to the private bucket, previewed via a
 * local object URL or a 60-second signed URL, and can be removed until the consult starts.
 */
export function DocumentUploader({ patientId, value, onChange }: { patientId: string; value: MedicalDocument[]; onChange: (docs: MedicalDocument[]) => void }) {
  const { t } = useTranslation();
  const { session } = useAuth();
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [tag, setTag] = useState<DocumentTag>('lab_report');
  const [pending, setPending] = useState<Pending[]>([]);
  const [preview, setPreview] = useState<Preview | null>(null);
  const localUrls = useRef(new Map<string, string>());
  const loose = useLooseDocuments(patientId);
  const latest = useRef(value);
  latest.current = value;

  useEffect(() => () => localUrls.current.forEach((u) => URL.revokeObjectURL(u)), []);

  const earlier = (loose.data ?? []).filter((d) => !value.some((v) => v.id === d.id));
  const slotsLeft = MAX_FILES_PER_CONSULT - value.length - pending.filter((p) => !p.error).length;

  const start = async (file: File) => {
    const check = await validateFile(file);
    if (!check.ok) {
      toast.error(t(`patient.docs.err.${check.error}`, { name: file.name, max: formatBytes(MAX_UPLOAD_BYTES) }));
      return;
    }
    const p: Pending = { key: crypto.randomUUID(), file, progress: 0, abort: new AbortController() };
    setPending((s) => [...s, p]);
    try {
      const doc = await uploadDocument(file, { patientId, userId: session!.user.id, tag, mime: check.mime, ext: check.ext },
        (pct) => setPending((s) => s.map((x) => (x.key === p.key ? { ...x, progress: pct } : x))), p.abort.signal);
      localUrls.current.set(doc.id, URL.createObjectURL(file));
      setPending((s) => s.filter((x) => x.key !== p.key));
      onChange([...latest.current, doc]);
      void qc.invalidateQueries({ queryKey: qk.looseDocs(patientId) });
    } catch (e) {
      const code = (e as Error).message;
      if (code === 'aborted') setPending((s) => s.filter((x) => x.key !== p.key));
      else setPending((s) => s.map((x) => (x.key === p.key ? { ...x, error: ['size', 'type', 'active_content'].includes(code) ? code : 'upload' } : x)));
    }
  };

  const onFiles = (files: FileList | null) => {
    if (!files) return;
    const list = Array.from(files);
    if (list.length > slotsLeft) toast.error(t('patient.docs.err.tooMany', { count: MAX_FILES_PER_CONSULT }));
    list.slice(0, Math.max(0, slotsLeft)).forEach((f) => void start(f));
    if (input.current) input.current.value = '';
  };

  const open = async (doc: MedicalDocument) => {
    try {
      const url = localUrls.current.get(doc.id) ?? (await signedDocumentUrl(doc.storage_path));
      setPreview({ name: doc.file_name, mime: doc.mime_type, url });
    } catch {
      toast.error(t('common.error'));
    }
  };

  const remove = async (doc: MedicalDocument) => {
    try {
      await deleteDocument(doc);
      onChange(latest.current.filter((d) => d.id !== doc.id));
      void qc.invalidateQueries({ queryKey: qk.looseDocs(patientId) });
      toast.success(t('patient.docs.deleted'));
    } catch {
      toast.error(t('common.error'));
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-40 flex-1 space-y-1.5">
          <Label htmlFor="doc-tag">{t('patient.docs.type')}</Label>
          <Select value={tag} onValueChange={(v) => setTag(v as DocumentTag)}>
            <SelectTrigger id="doc-tag"><SelectValue /></SelectTrigger>
            <SelectContent>{TAGS.map((x) => <SelectItem key={x} value={x}>{t(`patient.docs.tag.${x}`)}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <input ref={input} type="file" accept={ACCEPT} multiple className="sr-only" id="doc-input" tabIndex={-1} aria-label={t('patient.docs.upload')} onChange={(e) => onFiles(e.target.files)} />
        <Button type="button" variant="secondary" disabled={slotsLeft <= 0} onClick={() => input.current?.click()}><Upload aria-hidden />{t('patient.docs.upload')}</Button>
        {isNative() && <Button type="button" variant="secondary" disabled={slotsLeft <= 0} onClick={() => void takePhoto('camera').then((f) => f && start(f))}><Camera aria-hidden />{t('native.takePhoto')}</Button>}
      </div>
      <p className="text-xs text-muted-foreground">{t('patient.docs.rules', { max: formatBytes(MAX_UPLOAD_BYTES), count: MAX_FILES_PER_CONSULT })}</p>

      {(value.length > 0 || pending.length > 0) && (
        <ul className="space-y-2" aria-label={t('patient.docs.attached')}>
          {value.map((d) => (
            <li key={d.id} className="flex items-center gap-3 rounded-xl border bg-card p-2.5">
              <Thumb mime={d.mime_type} url={localUrls.current.get(d.id)} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{d.file_name}</p>
                <p className="text-xs text-muted-foreground">{t(`patient.docs.tag.${d.tag}`)} · {formatBytes(d.size_bytes)}</p>
              </div>
              <Button type="button" variant="ghost" size="icon" onClick={() => void open(d)} aria-label={t('patient.docs.previewName', { name: d.file_name })}><Eye className="h-4 w-4" /></Button>
              <Button type="button" variant="ghost" size="icon" onClick={() => void remove(d)} aria-label={t('patient.docs.deleteName', { name: d.file_name })}><Trash2 className="h-4 w-4 text-destructive" /></Button>
            </li>
          ))}
          {pending.map((p) => (
            <li key={p.key} className="flex items-center gap-3 rounded-xl border border-dashed bg-card p-2.5">
              <Thumb mime={p.file.type} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{p.file.name}</p>
                {p.error ? (
                  <p className="text-xs text-destructive" role="alert">{t(`patient.docs.err.${p.error}`, { name: p.file.name, max: formatBytes(MAX_UPLOAD_BYTES) })}</p>
                ) : (
                  <Progress value={p.progress} className="mt-1.5 h-1.5" aria-label={t('patient.docs.uploading', { name: p.file.name, pct: p.progress })} />
                )}
              </div>
              {p.error ? (
                <>
                  <Button type="button" variant="ghost" size="icon" aria-label={t('common.retry')} onClick={() => { setPending((s) => s.filter((x) => x.key !== p.key)); void start(p.file); }}><RotateCw className="h-4 w-4" /></Button>
                  <Button type="button" variant="ghost" size="icon" aria-label={t('common.close')} onClick={() => setPending((s) => s.filter((x) => x.key !== p.key))}><X className="h-4 w-4" /></Button>
                </>
              ) : (
                <Button type="button" variant="ghost" size="icon" aria-label={t('common.cancel')} onClick={() => p.abort.abort()}><X className="h-4 w-4" /></Button>
              )}
            </li>
          ))}
        </ul>
      )}

      {earlier.length > 0 && (
        <div className="rounded-xl bg-muted/60 p-3">
          <p className="mb-2 text-sm font-medium">{t('patient.docs.earlier')}</p>
          <ul className="space-y-1.5">
            {earlier.map((d) => (
              <li key={d.id} className="flex items-center gap-2 text-sm">
                <Paperclip className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                <span className="min-w-0 flex-1 truncate">{d.file_name}</span>
                <Badge variant="neutral">{t(`patient.docs.tag.${d.tag}`)}</Badge>
                <Button type="button" variant="link" size="sm" disabled={slotsLeft <= 0} onClick={() => onChange([...value, d])}>{t('patient.docs.attach')}</Button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <Dialog open={!!preview} onOpenChange={(o) => !o && setPreview(null)}>
        <DialogContent closeLabel={t('common.close')} className="max-w-3xl">
          <DialogHeader>
            <DialogTitle className="truncate pr-8">{preview?.name}</DialogTitle>
            <DialogDescription className="sr-only">{t('patient.docs.preview')}</DialogDescription>
          </DialogHeader>
          {preview && (preview.mime === 'application/pdf'
            ? <iframe title={preview.name} src={preview.url} className="h-[70dvh] w-full rounded-lg border" />
            : <img src={preview.url} alt={preview.name} className="max-h-[70dvh] w-full rounded-lg object-contain" />)}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Thumb({ mime, url }: { mime: string; url?: string }) {
  if (url && mime.startsWith('image/')) return <img src={url} alt="" className="h-11 w-11 shrink-0 rounded-lg object-cover" />;
  const Icon = mime === 'application/pdf' ? FileText : ImageIcon;
  return <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-primary-soft"><Icon className="h-5 w-5 text-primary" aria-hidden /></span>;
}
