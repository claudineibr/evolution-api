import { createHmac, timingSafeEqual } from 'crypto';

export function verifyMetaSignature(secret: string, body: Buffer, signature: string): boolean {
  if (!secret || !body || !/^sha256=[a-f0-9]{64}$/.test(signature || '')) return false;
  const expected = createHmac('sha256', secret).update(body).digest();
  const supplied = Buffer.from(signature.slice(7), 'hex');
  return supplied.length === expected.length && timingSafeEqual(expected, supplied);
}
