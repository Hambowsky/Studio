// Alerts on David's phone (Web Push): when something new lands under Needs you, or new mail arrives. The studio is
// added to his home screen and each device that turns alerts on is kept here. No AI, no cost.
import webpush from 'web-push';
import { db } from './db.ts';
import { fail } from './config.ts';
import { seal, unseal } from './secret.ts';
import * as dashboard from './dashboard.ts';
import { newMail } from './mail.ts';

const get = <T>(key: string, fallback: T): T => JSON.parse((db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? 'null') ?? fallback;
const put = (key: string, value: unknown) => db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value));

// The key pair that signs every alert, made once. The private half is kept encrypted.
function vapid() {
  let v = get<{ publicKey: string; privateKey: string } | null>('vapid', null);
  if (!v) { const k = webpush.generateVAPIDKeys(); v = { publicKey: k.publicKey, privateKey: seal(k.privateKey) }; put('vapid', v); }
  return { publicKey: v.publicKey, privateKey: unseal(v.privateKey) };
}
export const publicKey = () => vapid().publicKey;

export type Prefs = { needs: boolean; mail: boolean };
export const prefs = (): Prefs => ({ needs: true, mail: true, ...get<Partial<Prefs>>('notify-prefs', {}) });
export const savePrefs = (p: Partial<Prefs>) => { put('notify-prefs', { ...prefs(), ...p }); return prefs(); };

type Sub = { endpoint: string; keys: { p256dh: string; auth: string } };
export function subscribe(sub: Sub, label = '') {
  if (!/^https:\/\//.test(sub.endpoint)) fail(400, 'That is not a push address');
  db.prepare('INSERT INTO push_subs (endpoint, keys, label) VALUES (?, ?, ?) ON CONFLICT (endpoint) DO UPDATE SET keys = excluded.keys, label = excluded.label')
    .run(sub.endpoint, JSON.stringify(sub.keys), label.slice(0, 200));
  return { ok: true, devices: devices() };
}
export const unsubscribe = (endpoint: string) => { db.prepare('DELETE FROM push_subs WHERE endpoint = ?').run(endpoint); return { ok: true, devices: devices() }; };
export const devices = () => db.prepare('SELECT label, created_at, endpoint FROM push_subs ORDER BY created_at').all() as { label: string; created_at: string; endpoint: string }[];

// Sends one alert to every device. A device the push service says is gone is dropped.
export async function push(title: string, body: string, url = '/') {
  const v = vapid(), subs = db.prepare('SELECT endpoint, keys FROM push_subs').all() as { endpoint: string; keys: string }[];
  let sent = 0; const errors: string[] = [];
  await Promise.all(subs.map(async s => {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: JSON.parse(s.keys) }, JSON.stringify({ title, body, url }),
        { vapidDetails: { subject: 'mailto:alerts@redcherryit.com', publicKey: v.publicKey, privateKey: v.privateKey }, TTL: 6 * 3600, urgency: 'high' }); // Android holds back normal priority alerts while the phone is idle
      sent++;
    } catch (err) {
      const e = err as { statusCode?: number; body?: string; message: string };
      if ([404, 410].includes(e.statusCode ?? 0)) unsubscribe(s.endpoint);
      errors.push(`${new URL(s.endpoint).host}: ${e.statusCode ? `${e.statusCode} ${String(e.body ?? '').slice(0, 200)}` : e.message}`);
      console.error('push failed', errors.at(-1));
    }
  }));
  return { sent, devices: subs.length, errors };
}

// What each Needs you number means, as on the Overview.
const NEEDS: Record<string, [string, string, string]> = {
  replies_to_answer: ['lead has replied', 'leads have replied', '#leads'],
  signals_new: ['person asking for help in public', 'people asking for help in public', '#signals'],
  emails_to_approve: ['email waiting for your approval', 'emails waiting for your approval', '#emails'],
  follow_ups_due: ['lead ready for a follow up email', 'leads ready for a follow up email', '#emails'],
  call_backs_due: ['follow up date due', 'follow up dates due', '#leads'],
  emails_to_check: ['email that failed or needs checking', 'emails that failed or need checking', '#emails'],
  sites_down: ["customer's website is down", "customers' websites are down", '#customers'],
  invoices_overdue: ['invoice is overdue', 'invoices are overdue', '#invoices'],
  invoices_to_send: ['renewal invoice ready to check and send', 'renewal invoices ready to check and send', '#invoices'],
  invoices_to_check: ['invoice did not send', 'invoices did not send', '#invoices'],
  renewals_due: ['renewal is due in the next 30 days', 'renewals are due in the next 30 days', '#customers'],
  posts_to_approve: ['post waiting for your approval', 'posts waiting for your approval', '#social'],
  links_new: ['new chance to earn a link', 'new chances to earn a link', '#links'],
  posts_to_check: ['post that failed or needs checking in Buffer', 'posts that failed or need checking in Buffer', '#social'],
};

// Looks for anything new since last time: a Needs you number that went up, or unread mail with a newer UID. The first
// run only notes where things stand.
export async function check() {
  if (!(db.prepare('SELECT COUNT(*) AS n FROM push_subs').get() as { n: number }).n) return { sent: 0 };
  const p = prefs(), alerts: [string, string, string][] = [];
  if (p.needs) {
    const now = { ...dashboard.sales().needs, ...dashboard.marketing().needs } as Record<string, number>, was = get<Record<string, number> | null>('notify-needs', null);
    if (was) for (const [k, [one, many, href]] of Object.entries(NEEDS)) if ((now[k] ?? 0) > (was[k] ?? 0)) alerts.push(['Needs you', `${now[k]} ${now[k] === 1 ? one : many}`, `/${href}`]);
    put('notify-needs', now);
  }
  if (p.mail) {
    const was = get<Record<string, number>>('notify-mail', {}), boxes = await newMail(was);
    for (const b of boxes) {
      const m = b.messages;
      if (m.length === 1) alerts.push([`New email from ${m[0].from}`, m[0].subject || '(no subject)', '/#mail']);
      else if (m.length > 1) alerts.push([`${m.length} new emails`, m.slice(0, 3).map(x => x.from).join(', '), '/#mail']);
      was[b.box] = b.uidNext;
    }
    put('notify-mail', was);
  }
  let sent = 0;
  for (const [title, body, url] of alerts) sent += (await push(title, body, url)).sent;
  return { sent };
}

export function startAlerts() {
  const run = () => void check().catch(() => {});
  setTimeout(run, 30_000).unref();
  setInterval(run, 5 * 60_000).unref();
}
