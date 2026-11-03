import { lazy, Suspense } from 'react';
import { FullPageLoader } from '@/components/feedback/states';
import { isDemo } from '@/lib/config';
import { BackendRequired } from '@/features/patient/components/common';

// The call screen (and the video SDKs it loads) is only fetched when a consultation is opened.
const ConsultPage = lazy(() => import('./pages/ConsultPage').then((m) => ({ default: m.ConsultPage })));

export function consultPage() {
  return isDemo ? <BackendRequired titleKey="consult.pre.title" /> : <Suspense fallback={<FullPageLoader />}><ConsultPage /></Suspense>;
}
