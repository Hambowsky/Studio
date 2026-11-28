import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.ts';

// Passwords (client logins, David's mailboxes) are kept encrypted, so a copy of the database alone does not give them away. The key is
// CREDENTIALS_KEY when set, otherwise a random one made once in the data folder (keep it with the database).
let key: Buffer | undefined;
const secretKey = () => key ??= process.env.CREDENTIALS_KEY ? crypto.createHash('sha256').update(process.env.CREDENTIALS_KEY).digest() : (() => {
  const file = path.join(DATA_DIR, 'credentials.key');
  if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(32).toString('base64'), { mode: 0o600, flag: 'wx' });
  return Buffer.from(fs.readFileSync(file, 'utf8'), 'base64');
})();
export const seal = (text: string) => { if (!text) return '';
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', secretKey(), iv), body = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), body].map(b => b.toString('base64')).join('.'); };
export const unseal = (sealed: string) => { if (!sealed) return '';
  try { const [iv, tag, body] = sealed.split('.').map(b => Buffer.from(b, 'base64')), d = crypto.createDecipheriv('aes-256-gcm', secretKey(), iv); d.setAuthTag(tag);
    return Buffer.concat([d.update(body), d.final()]).toString('utf8'); } catch { return ''; } }; // a lost key reads as blank, to be typed in again
