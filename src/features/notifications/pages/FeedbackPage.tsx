import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, Star } from 'lucide-react';
import { formatDateTime } from '@/domain/time';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { CardSkeleton } from '@/components/feedback/states';
import { getSupabase } from '@/lib/supabase';
import { cn } from '@/lib/utils';
import { submitRating } from '../api';

/** Feedback after a completed consultation (target of the feedback-request message). */
export function FeedbackPage() {
  const { id = '' } = useParams();
  const { t, i18n } = useTranslation();
  const appt = useQuery({
    queryKey: ['feedback', id],
    queryFn: async () => {
      const { data, error } = await getSupabase().from('appointments').select('id, status, start_at, doctors(full_name), ratings(stars)').eq('id', id).maybeSingle();
      if (error) throw error;
      return data as unknown as { id: string; status: string; start_at: string; doctors: { full_name: string } | null; ratings: { stars: number }[] | { stars: number } | null } | null;
    },
  });
  const [stars, setStars] = useState(0);
  const [comment, setComment] = useState('');
  const [state, setState] = useState<'idle' | 'busy' | 'done' | 'error'>('idle');
  if (appt.isPending) return <><PageHeader back="/p/appointments" title={t('notify.feedback.title')} /><CardSkeleton /></>;
  const a = appt.data;
  const rated = a && (Array.isArray(a.ratings) ? a.ratings.length > 0 : !!a.ratings);
  const send = async () => {
    setState('busy');
    try {
      await submitRating(id, stars, comment);
      setState('done');
    } catch {
      setState('error');
    }
  };
  return (
    <div className="mx-auto max-w-md space-y-4">
      <PageHeader back="/p/appointments" title={t('notify.feedback.title')} subtitle={a ? `${a.doctors?.full_name} · ${formatDateTime(a.start_at, i18n.language)}` : undefined} />
      <Card>
        <CardContent className="space-y-4 p-5">
          {!a || a.status !== 'completed' ? <p className="text-sm">{t('notify.feedback.notAvailable')}</p> : rated || state === 'done' ? (
            <div className="space-y-3 text-center" role="status">
              <CheckCircle2 className="mx-auto h-10 w-10 text-success" aria-hidden />
              <p className="font-semibold">{t('notify.feedback.thanks')}</p>
              <Button variant="outline" asChild><Link to="/p">{t('patient.review.goHome')}</Link></Button>
            </div>
          ) : (
            <>
              <fieldset>
                <legend className="mb-2 text-sm font-medium">{t('notify.feedback.question', { doctor: a.doctors?.full_name })}</legend>
                <div className="flex justify-center gap-1" role="radiogroup" aria-label={t('notify.feedback.stars')}>
                  {[1, 2, 3, 4, 5].map((n) => (
                    <button key={n} type="button" role="radio" aria-checked={stars === n} aria-label={t('notify.feedback.star', { count: n })} onClick={() => setStars(n)}
                      className="rounded-lg p-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                      <Star className={cn('h-9 w-9', n <= stars ? 'fill-highlight text-highlight' : 'text-muted-foreground')} aria-hidden />
                    </button>
                  ))}
                </div>
              </fieldset>
              <div className="space-y-1.5">
                <Label htmlFor="fb-comment">{t('notify.feedback.comment')}</Label>
                <Textarea id="fb-comment" rows={3} maxLength={500} value={comment} onChange={(e) => setComment(e.target.value)} />
                <p className="text-xs text-muted-foreground">{t('notify.feedback.commentHint')}</p>
              </div>
              {state === 'error' && <p role="alert" className="text-sm text-destructive">{t('common.error')}</p>}
              <Button block disabled={!stars} loading={state === 'busy'} onClick={() => void send()} data-ref="feedback-send">{t('notify.feedback.send')}</Button>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
