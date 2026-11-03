/** Environment access that works on Supabase Edge (Deno) and on Node (scripts/local-stack/gateway.ts). */
type DenoLike = { env: { get(k: string): string | undefined } };
export function env(key: string): string | undefined {
  const deno = (globalThis as { Deno?: DenoLike }).Deno;
  if (deno) return deno.env.get(key) ?? undefined;
  return (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env[key];
}
export function requireEnv(key: string): string {
  const v = env(key);
  if (!v) throw new Error(`missing_env_${key}`);
  return v;
}
