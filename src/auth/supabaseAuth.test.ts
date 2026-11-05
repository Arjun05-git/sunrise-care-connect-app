import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SupabaseAuthService } from './supabaseAuth';

interface Opts {
  role?: string;
  aal?: { currentLevel: string; nextLevel: string };
  policy?: { data: unknown; error: unknown };
}

/** A fake Supabase client: just enough surface for a staff password sign-in. Records which tables/RPCs were used. */
function fake({ role = 'admin', aal = { currentLevel: 'aal1', nextLevel: 'aal1' }, policy = { data: { environment: 'production', staff_mfa_required: true }, error: null } }: Opts = {}) {
  const used: string[] = [];
  const rows = (table: string) => (table === 'user_roles' ? { data: [{ role }], error: null } : { data: { full_name: 'Test Staff' }, error: null });
  const sb = {
    auth: {
      signInWithPassword: async () => ({ data: { user: { id: 'u1', phone: null, email: 'staff@example.test' } }, error: null }),
      signOut: async () => ({ error: null }),
      mfa: { getAuthenticatorAssuranceLevel: async () => ({ data: aal, error: null }) },
    },
    from: (table: string) => {
      used.push(`from:${table}`);
      const result = rows(table);
      const q: Record<string, unknown> = { select: () => q, eq: () => q, maybeSingle: async () => result, then: (res: (v: unknown) => unknown) => res(result) };
      return q;
    },
    rpc: async (fn: string) => {
      used.push(`rpc:${fn}`);
      return fn === 'auth_policy' ? policy : { data: null, error: null };
    },
  } as unknown as SupabaseClient;
  return { sb, used };
}

const signIn = async (o?: Opts) => {
  const { sb, used } = fake(o);
  const s = await new SupabaseAuthService(sb).signInWithPassword('staff@example.test', 'pw');
  return { s, used };
};

describe('staff sign-in asks the database whether MFA is required', () => {
  it('requires the code when the database policy says so', async () => {
    expect((await signIn()).s.stepUpPending).toBe(true);
  });

  it('skips the code only when the database policy says it is not required (demo)', async () => {
    const { s } = await signIn({ policy: { data: { environment: 'demo', staff_mfa_required: false }, error: null } });
    expect(s.stepUpPending).toBe(false);
  });

  it('fails closed when the policy cannot be read', async () => {
    const { s } = await signIn({ policy: { data: null, error: { message: 'boom' } } });
    expect(s.stepUpPending).toBe(true);
  });

  it('fails closed when the policy answer is malformed', async () => {
    const { s } = await signIn({ policy: { data: { environment: 'demo' }, error: null } });
    expect(s.stepUpPending).toBe(true);
  });

  it('never reads the editable app_settings table for this decision', async () => {
    const { used } = await signIn({ policy: { data: { environment: 'demo', staff_mfa_required: false }, error: null } });
    expect(used).not.toContain('from:app_settings');
    expect(used).toContain('rpc:auth_policy');
  });

  it('does not ask at all once the session is already aal2', async () => {
    const { s, used } = await signIn({ aal: { currentLevel: 'aal2', nextLevel: 'aal2' } });
    expect(s.stepUpPending).toBe(false);
    expect(used).not.toContain('rpc:auth_policy');
  });

  it('requires the code when a factor is enrolled, whatever the policy says', async () => {
    const { s } = await signIn({ aal: { currentLevel: 'aal1', nextLevel: 'aal2' }, policy: { data: { environment: 'demo', staff_mfa_required: false }, error: null } });
    expect(s.stepUpPending).toBe(true);
  });
});
