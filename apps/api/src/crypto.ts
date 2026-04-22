import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';

function getKey(): Buffer {
  const raw = process.env.ENCRYPTION_KEY ?? '';
  if (!raw) throw new Error('ENCRYPTION_KEY is not set');
  // Accept hex of 64 chars (32 bytes) or derive via sha256 from any string
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, 'hex');
  return createHash('sha256').update(raw).digest();
}

export function encryptToken(plaintext: string): { enc: string; iv: string; tag: string } {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', getKey(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { enc: enc.toString('base64'), iv: iv.toString('base64'), tag: tag.toString('base64') };
}

export function decryptToken(enc: string, iv: string, tag: string): string {
  const decipher = createDecipheriv('aes-256-gcm', getKey(), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  const dec = Buffer.concat([decipher.update(Buffer.from(enc, 'base64')), decipher.final()]);
  return dec.toString('utf8');
}

export function maskToken(token: string): string {
  if (!token) return '';
  if (token.length <= 8) return '••••';
  return `${token.slice(0, 4)}••••${token.slice(-4)}`;
}
