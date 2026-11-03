import { env, requireEnv } from '../env.ts';
import { MockProvider } from './mock.ts';
import type { PaymentProvider, ProviderName } from './provider.ts';
import { RazorpayProvider } from './razorpay.ts';

export * from './provider.ts';
export { MockProvider } from './mock.ts';
export { RazorpayProvider } from './razorpay.ts';

/** Gateway for new orders: Razorpay when its keys are configured (PAYMENTS_PROVIDER=razorpay), otherwise the mock. */
export function activeProviderName(): ProviderName {
  const wanted = env('PAYMENTS_PROVIDER') ?? (env('RAZORPAY_KEY_ID') ? 'razorpay' : 'mock');
  if (wanted === 'razorpay') return 'razorpay';
  if (env('PAYMENTS_ALLOW_MOCK') !== 'true') throw new Error('mock_payments_disabled'); // never silently mock in production
  return 'mock';
}

/** Provider for an existing payment row (refunds keep working after switching gateways). */
export function providerFor(name: ProviderName): PaymentProvider {
  if (name === 'razorpay') return new RazorpayProvider(requireEnv('RAZORPAY_KEY_ID'), requireEnv('RAZORPAY_KEY_SECRET'), env('RAZORPAY_WEBHOOK_SECRET') ?? '');
  return mockProvider();
}

export function mockProvider(): MockProvider {
  return new MockProvider(requireEnv('MOCK_GATEWAY_SECRET'), requireEnv('MOCK_WEBHOOK_SECRET'));
}
