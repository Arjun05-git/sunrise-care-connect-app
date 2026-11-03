import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ExternalLink, History } from 'lucide-react';
import { formatDateTime } from '@/domain/time';
import { PageHeader } from '@/components/layout/PageHeader';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Textarea } from '@/components/ui/textarea';
import { ErrorState, ListSkeleton } from '@/components/feedback/states';
import { cn } from '@/lib/utils';
import { ReadOnlyNote, ReasonDialog, useAdminError, useHasRole } from '../components';
import { CONSENT_KEYS, cqk, DOCUMENT_KEYS, latest, publishContent, useContent, type ContentKey, type ContentVersion } from '../console-api';

const REQUIRED: ContentKey[] = ['teleconsultation', 'data_processing', 'terms'];

/**
 * Consent wording and legal pages, versioned. A wording fix keeps the version (revision + 1); a new
 * version makes every patient accept the required consents again on their next visit.
 */
export function ContentPage() {
  const { t } = useTranslation();
  const isAdmin = useHasRole('admin');
  const content = useContent();
  const [key, setKey] = useState<ContentKey>('teleconsultation');
  const rows = content.data ?? [];
  return (
    <div className="space-y-4">
      <PageHeader title={t('admin.content')} subtitle={t('adm.cont.subtitle')} />
      {!isAdmin && <ReadOnlyNote>{t('adm.cont.readOnly')}</ReadOnlyNote>}
      {content.isPending ? <ListSkeleton rows={4} /> : content.isError ? <ErrorState onRetry={() => void content.refetch()} /> : (
        <div className="grid gap-4 lg:grid-cols-[16rem_1fr] [&>*]:min-w-0">
          <nav aria-label={t('admin.content')} className="space-y-3">
            {[['consents', CONSENT_KEYS], ['documents', DOCUMENT_KEYS]].map(([group, keys]) => (
              <div key={group as string}>
                <p className="mb-1 px-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t(`adm.cont.${group as string}`)}</p>
                <ul className="space-y-0.5">
                  {(keys as ContentKey[]).map((k) => {
                    const cur = latest(rows, k);
                    return (
                      <li key={k}><button type="button" onClick={() => setKey(k)} aria-current={key === k}
                        className={cn('flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm', key === k ? 'bg-primary-soft font-semibold text-primary-soft-foreground' : 'hover:bg-accent')}>
                        {t(`adm.cont.key.${k}`)}<span className={cn('text-xs tabular-nums', key !== k && 'text-muted-foreground')}>v{cur?.version}{cur && cur.revision > 1 ? `·r${cur.revision}` : ''}</span>
                      </button></li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </nav>
          <Editor key={key} k={key} rows={rows} />
        </div>
      )}
    </div>
  );
}

function Editor({ k, rows }: { k: ContentKey; rows: ContentVersion[] }) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const errText = useAdminError();
  const isAdmin = useHasRole('admin');
  const cur = latest(rows, k);
  const doc = DOCUMENT_KEYS.includes(k);
  const [v, setV] = useState({ title_en: '', title_ml: '', body_en: '', body_ml: '' });
  const [newVersion, setNewVersion] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (cur) setV({ title_en: cur.title_en, title_ml: cur.title_ml, body_en: cur.body_en, body_ml: cur.body_ml }); }, [cur]);
  const limit = doc ? 20000 : 1500;
  const changed = !!cur && (v.body_en.trim() !== cur.body_en || v.body_ml.trim() !== cur.body_ml || v.title_en.trim() !== cur.title_en || v.title_ml.trim() !== cur.title_ml);
  const ok = v.body_en.trim().length >= 10 && v.body_ml.trim().length >= 10 && (changed || newVersion);
  const history = rows.filter((r) => r.key === k);
  const nextVersion = cur ? `${Number(cur.version.split('.')[0]) + 1}.0` : '1.0';

  const publish = async (reason: string) => {
    setBusy(true);
    try {
      const r = await publishContent(k, v, newVersion, reason);
      toast.success(r.reconsent ? t('adm.cont.publishedReconsent', { version: r.version, count: r.affected_users }) : t('adm.cont.published', { version: r.version, revision: r.revision }));
      setConfirm(false);
      setNewVersion(false);
      await qc.invalidateQueries({ queryKey: cqk.content });
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex-row flex-wrap items-start justify-between gap-2 space-y-0">
          <div><CardTitle>{t(`adm.cont.key.${k}`)}</CardTitle>
            <CardDescription>{REQUIRED.includes(k) ? t('adm.cont.required') : doc ? t('adm.cont.document') : t('adm.cont.optional')}</CardDescription></div>
          <div className="flex items-center gap-2">
            {cur && <Badge variant="outline" data-ref="content-version">v{cur.version} · r{cur.revision}</Badge>}
            {doc && <Button size="sm" variant="ghost" asChild><a href={`/legal/${k}`} target="_blank" rel="noopener"><ExternalLink aria-hidden />{t('adm.cont.view')}</a></Button>}
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <fieldset disabled={!isAdmin} className="grid gap-3 md:grid-cols-2">
            {doc && <>
              <div className="space-y-1.5"><Label htmlFor="c-ten">{t('adm.cont.titleEn')}</Label><Input id="c-ten" value={v.title_en} maxLength={120} onChange={(e) => setV({ ...v, title_en: e.target.value })} /></div>
              <div className="space-y-1.5"><Label htmlFor="c-tml">{t('adm.cont.titleMl')}</Label><Input id="c-tml" lang="ml" value={v.title_ml} maxLength={120} onChange={(e) => setV({ ...v, title_ml: e.target.value })} /></div>
            </>}
            <div className="space-y-1.5"><Label htmlFor="c-en">{t('adm.cont.bodyEn')}</Label>
              <Textarea id="c-en" rows={doc ? 14 : 5} maxLength={limit} value={v.body_en} onChange={(e) => setV({ ...v, body_en: e.target.value })} />
              <p className="text-right text-xs tabular-nums text-muted-foreground">{v.body_en.length}/{limit}</p></div>
            <div className="space-y-1.5"><Label htmlFor="c-ml">{t('adm.cont.bodyMl')}</Label>
              <Textarea id="c-ml" lang="ml" rows={doc ? 14 : 5} maxLength={limit} value={v.body_ml} onChange={(e) => setV({ ...v, body_ml: e.target.value })} />
              <p className="text-right text-xs tabular-nums text-muted-foreground">{v.body_ml.length}/{limit}</p></div>
          </fieldset>
          {isAdmin && (
            <>
              <RadioGroup value={newVersion ? 'new' : 'fix'} onValueChange={(x) => setNewVersion(x === 'new')} className="grid gap-2 md:grid-cols-2" aria-label={t('adm.cont.kind')}>
                <label className="flex items-start gap-2 rounded-lg border p-3 text-sm"><RadioGroupItem value="fix" className="mt-0.5" />
                  <span><span className="font-medium">{t('adm.cont.fix')}</span><span className="block text-xs text-muted-foreground">{t('adm.cont.fixHint', { version: cur?.version })}</span></span></label>
                <label className="flex items-start gap-2 rounded-lg border p-3 text-sm"><RadioGroupItem value="new" className="mt-0.5" data-ref="new-version" />
                  <span><span className="font-medium">{t('adm.cont.newVersion', { version: nextVersion })}</span>
                    <span className="block text-xs text-muted-foreground">{REQUIRED.includes(k) ? t('adm.cont.newVersionHint') : t('adm.cont.newVersionDocHint')}</span></span></label>
              </RadioGroup>
              <div className="flex justify-end"><Button disabled={!ok} onClick={() => setConfirm(true)} data-ref="publish">{t('adm.cont.publish')}</Button></div>
            </>
          )}
          <ReasonDialog open={confirm} onOpenChange={setConfirm} title={t('adm.cont.publishTitle', { name: t(`adm.cont.key.${k}`) })}
            description={newVersion && REQUIRED.includes(k) ? t('adm.cont.publishReconsent') : undefined} confirmLabel={t('adm.cont.publish')} busy={busy} onConfirm={(r) => void publish(r)} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2"><CardTitle className="flex items-center gap-2 text-base"><History className="h-4 w-4" aria-hidden />{t('adm.cont.history')}</CardTitle></CardHeader>
        <CardContent>
          <ol className="divide-y text-sm" data-ref="content-history">
            {history.map((h) => (
              <li key={h.id} className="flex flex-wrap items-baseline gap-x-3 py-2">
                <span className="font-mono text-xs font-semibold">v{h.version} · r{h.revision}</span>
                <span className="text-muted-foreground">{formatDateTime(h.published_at, i18n.language)}</span>
                <span className="flex-1">{h.reason}</span>
              </li>
            ))}
          </ol>
        </CardContent>
      </Card>
    </div>
  );
}
