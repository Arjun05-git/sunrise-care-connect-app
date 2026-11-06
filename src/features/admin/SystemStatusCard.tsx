import { useTranslation } from 'react-i18next';
import { AlertTriangle } from 'lucide-react';
import { Badge, type BadgeProps } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ErrorState, ListSkeleton } from '@/components/feedback/states';
import { useSystemStatus, type Area, type Mode, type ProviderId, type SystemStatus } from './system-status';

const AREAS: Area[] = ['payments', 'notifications', 'video', 'integrations'];
const VARIANT: Record<Mode, BadgeProps['variant']> = { mock: 'highlight', sandbox: 'warning', live: 'success', unconfigured: 'neutral' };
const INTEGRATIONS: ProviderId[] = ['his', 'leadsquared', 'abdm'];

/** One line per warning code from the server: `<mode>:<provider>` or `open_cors`. */
function WarningLine({ code }: { code: string }) {
  const { t } = useTranslation();
  if (code === 'open_cors') return <li>{t('sys.warn.open_cors')}</li>;
  const [mode, id] = code.split(':') as [Mode, ProviderId];
  const name = INTEGRATIONS.includes(id) ? t(`intg.sys.${id}`) : t(`sys.p.${id}`);
  return <li>{t(`sys.warn.${mode}`, { name })}</li>;
}

/** Admin → Integrations: which services are simulated (mock), test (sandbox) or real (live), and what the database says. */
export function SystemStatusView({ status }: { status: SystemStatus }) {
  const { t } = useTranslation();
  return (
    <Card data-ref="system-status">
      <CardHeader className="flex-row items-start justify-between space-y-0 pb-2">
        <div>
          <CardTitle className="text-base">{t('sys.title')}</CardTitle>
          <CardDescription>{t('sys.subtitle')}</CardDescription>
        </div>
        <Badge variant={status.environment === 'demo' ? 'highlight' : 'default'} data-ref="environment">{t(`sys.env.${status.environment}`)}</Badge>
      </CardHeader>
      <CardContent className="space-y-4">
        {status.warnings.length > 0 && (
          <div role="alert" className="rounded-xl border border-destructive/40 bg-destructive-soft p-3 text-sm text-destructive" data-ref="status-warnings">
            <p className="flex items-center gap-2 font-semibold"><AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />{t('sys.warn.title')}</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-6">{status.warnings.map((w) => <WarningLine key={w} code={w} />)}</ul>
          </div>
        )}
        {AREAS.map((area) => {
          const rows = status.providers.filter((p) => p.area === area);
          if (!rows.length) return null;
          return (
            <section key={area} aria-label={t(`sys.area.${area}`)}>
              <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t(`sys.area.${area}`)}</h3>
              <ul className="divide-y rounded-xl border">
                {rows.map((p) => (
                  <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm" data-ref={`provider-${p.id}`}>
                    <div className="min-w-0">
                      <p className="font-medium">{INTEGRATIONS.includes(p.id) ? t(`intg.sys.${p.id}`) : t(`sys.p.${p.id}`)}</p>
                      <p className="text-xs text-muted-foreground">
                        {p.detail ? t(`sys.detail.${p.detail}`, { defaultValue: p.detail }) : t(`sys.hint.${p.mode}`)}
                        {p.note && <> · {t('sys.unverified')}</>}
                      </p>
                    </div>
                    <Badge variant={VARIANT[p.mode]}>{t(`sys.mode.${p.mode}`)}</Badge>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </CardContent>
    </Card>
  );
}

export function SystemStatusCard() {
  const q = useSystemStatus();
  if (q.isPending) return <ListSkeleton rows={2} />;
  if (q.isError || !q.data) return <ErrorState onRetry={() => void q.refetch()} />;
  return <SystemStatusView status={q.data} />;
}
