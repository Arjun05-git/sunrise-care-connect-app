// Signs the local anon / service_role JWTs with the dev secret (HS256). Local development only.
import { createHmac } from 'node:crypto';
const secret = process.argv[2];
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const sign = (role) => {
  const body = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ iss: 'supabase-local', role, iat: 1735689600, exp: 2051222400 })}`;
  return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`;
};
console.log(`ANON_KEY=${sign('anon')}\nSERVICE_KEY=${sign('service_role')}`);
