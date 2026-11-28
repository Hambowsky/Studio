// Mail: David's own inboxes (Stackmail or any IMAP and SMTP mailbox), read and answered on the Mail page, so he
// does not log in to each one. Only each mailbox's login is kept here (the password encrypted); messages are read
// live from the mail server, so the server stays the one copy. Nothing is sent unless David presses Send.
import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import { db } from './db.ts';
import { fail } from './config.ts';
import { seal, unseal } from './secret.ts';

type Box = { id: number; name: string; email: string; username: string; password: string; imap_host: string; imap_port: number; smtp_host: string; smtp_port: number; created_at: string };
export type BoxInput = { name?: string; email: string; username?: string; password?: string; imap_host?: string; imap_port?: number; smtp_host?: string; smtp_port?: number };
type Person = { name?: string; address?: string };

// Stackmail's servers unless told otherwise.
const DEFAULTS = { imap_host: 'imap.stackmail.com', imap_port: 993, smtp_host: 'smtp.stackmail.com', smtp_port: 465 };
const PAGE = 50;

const shown = ({ password: _, ...b }: Box) => b;
const box = (id: number) => (db.prepare('SELECT * FROM mailboxes WHERE id = ?').get(id) as Box | undefined) ?? fail(404, `There is no mailbox ${id}`);
export const mailboxes = () => (db.prepare('SELECT * FROM mailboxes ORDER BY name COLLATE NOCASE').all() as Box[]).map(shown);

async function open(b: Box) {
  const client = new ImapFlow({ host: b.imap_host, port: b.imap_port, secure: b.imap_port === 993, auth: { user: b.username, pass: unseal(b.password) },
    logger: false, connectionTimeout: 20_000, greetingTimeout: 20_000, socketTimeout: 60_000 });
  client.on('error', () => {}); // a dropped connection also rejects the call in progress
  await client.connect();
  return client;
}
// One connection per call: log in, do the work, log out.
async function withBox<T>(b: Box, work: (c: ImapFlow) => Promise<T>) {
  const c = await open(b);
  try { return await work(c); } finally { await c.logout().catch(() => c.close()); }
}

// Saving a mailbox logs in first, so a wrong password or server is caught here and not later.
export async function saveMailbox(input: BoxInput, id?: number) {
  const was = id ? box(id) : undefined;
  const email = input.email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) fail(400, 'Give the email address');
  const b: Box = { ...DEFAULTS, ...was, ...Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined && v !== '')),
    id: id ?? 0, email, name: input.name?.trim() || was?.name || email, username: input.username?.trim() || email,
    password: input.password ? seal(input.password) : was?.password ?? '', created_at: was?.created_at ?? '' } as Box;
  if (!b.password) fail(400, 'Give the mailbox password');
  try { await withBox(b, c => c.mailboxOpen('INBOX', { readOnly: true })); }
  catch (err) { fail(400, `Could not log in to ${email}: ${(err as Error & { responseText?: string }).responseText || (err as Error).message}`); }
  const cols = ['name', 'email', 'username', 'password', 'imap_host', 'imap_port', 'smtp_host', 'smtp_port'] as const, vals = cols.map(k => b[k]);
  try {
    if (id) db.prepare(`UPDATE mailboxes SET ${cols.map(k => `${k} = ?`).join(', ')} WHERE id = ?`).run(...vals, id);
    else id = Number(db.prepare(`INSERT INTO mailboxes (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...vals).lastInsertRowid);
  } catch (err) { if (/UNIQUE/.test((err as Error).message)) fail(409, `${email} is already added`); throw err; }
  return shown(box(id));
}
export function removeMailbox(id: number) { box(id); db.prepare('DELETE FROM mailboxes WHERE id = ?').run(id); return { ok: true }; }

const who = (p?: Person[]) => (p ?? []).map(x => ({ name: x.name ?? '', address: (x.address ?? '').toLowerCase() }));

// The newest messages in each inbox (or one), newest first, with each inbox's unread count. An inbox that cannot be
// reached shows its error and the others still load.
export async function inbox(boxId?: number, before?: number) {
  const boxes = boxId ? [box(boxId)] : db.prepare('SELECT * FROM mailboxes').all() as Box[];
  const status: { id: number; unseen: number; total: number; error?: string }[] = [];
  const messages = (await Promise.all(boxes.map(async b => {
    try {
      return await withBox(b, async c => {
        const lock = await c.getMailboxLock('INBOX', { readOnly: true });
        try {
          const total = (c.mailbox as { exists: number }).exists, end = before ? Math.min(before - 1, total) : total;
          const st = await c.status('INBOX', { unseen: true }), unseen = (st && st.unseen) || 0;
          status.push({ id: b.id, unseen, total });
          if (end < 1) return [];
          const out = [];
          for await (const m of c.fetch(`${Math.max(1, end - PAGE + 1)}:${end}`, { uid: true, envelope: true, flags: true, bodyStructure: true })) {
            out.push({ box_id: b.id, uid: m.uid, seq: m.seq, from: who(m.envelope?.from)[0] ?? { name: '', address: '' }, subject: m.envelope?.subject ?? '',
              date: new Date(m.envelope?.date ?? Date.now()).toISOString(), seen: !!m.flags?.has('\\Seen'), flagged: !!m.flags?.has('\\Flagged'),
              attachments: parts(m.bodyStructure).attachments.length > 0 });
          }
          return out;
        } finally { lock.release(); }
      });
    } catch (err) { status.push({ id: b.id, unseen: 0, total: 0, error: (err as Error & { responseText?: string }).responseText || (err as Error).message }); return []; }
  }))).flat().sort((a, b) => b.date.localeCompare(a.date));
  return { messages, boxes: status };
}

// The text, HTML and attachments in a message's structure.
type Node = { part?: string; type?: string; size?: number; disposition?: string; dispositionParameters?: Record<string, string>; parameters?: Record<string, string>; childNodes?: Node[] };
function parts(node?: Node, found = { text: '', html: '', attachments: [] as { part: string; name: string; type: string; size: number }[] }) {
  if (!node) return found;
  if (node.childNodes?.length) { for (const n of node.childNodes) parts(n, found); return found; }
  const part = node.part ?? '1', name = node.dispositionParameters?.filename ?? node.parameters?.name ?? '';
  if (node.disposition === 'attachment' || (name && !node.type?.startsWith('text/'))) found.attachments.push({ part, name: name || 'attachment', type: node.type ?? '', size: node.size ?? 0 });
  else if (node.type === 'text/plain' && !found.text) found.text = part;
  else if (node.type === 'text/html' && !found.html) found.html = part;
  return found;
}
const read = async (c: ImapFlow, uid: number, part: string) => {
  const { content } = await c.download(String(uid), part, { uid: true, maxBytes: 5_000_000 });
  const chunks: Buffer[] = [];
  if (content) for await (const ch of content) chunks.push(ch as Buffer);
  return Buffer.concat(chunks);
};

// One message, opened: it is marked read, as in any mail program.
export async function message(boxId: number, uid: number) {
  return withBox(box(boxId), async c => {
    const lock = await c.getMailboxLock('INBOX');
    try {
      const m = (await c.fetchOne(String(uid), { uid: true, envelope: true, bodyStructure: true, flags: true, headers: ['references'] }, { uid: true })) || fail(404, 'That message is no longer in the inbox');
      const p = parts(m.bodyStructure);
      const [text, html] = await Promise.all([p.text ? read(c, uid, p.text) : null, p.html ? read(c, uid, p.html) : null]);
      if (!m.flags?.has('\\Seen')) await c.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
      const e = m.envelope!;
      return { box_id: boxId, uid, subject: e.subject ?? '', date: new Date(e.date ?? Date.now()).toISOString(), from: who(e.from), to: who(e.to), cc: who(e.cc), reply_to: who(e.replyTo),
        message_id: e.messageId ?? '', references: (m.headers?.toString('utf8') ?? '').replace(/^references:\s*/i, '').replace(/\s+/g, ' ').trim(),
        text: text?.toString('utf8') ?? '', html: html?.toString('utf8') ?? '', attachments: p.attachments };
    } finally { lock.release(); }
  });
}

export async function attachment(boxId: number, uid: number, part: string) {
  return withBox(box(boxId), async c => {
    const lock = await c.getMailboxLock('INBOX', { readOnly: true });
    try {
      const m = await c.fetchOne(String(uid), { uid: true, bodyStructure: true }, { uid: true });
      const a = (m ? parts(m.bodyStructure).attachments.find(x => x.part === part) : undefined) ?? fail(404, 'That attachment is not in the message');
      return { ...a, content: await read(c, uid, part) };
    } finally { lock.release(); }
  });
}

export async function markSeen(boxId: number, uid: number, seen: boolean) {
  await withBox(box(boxId), async c => {
    const lock = await c.getMailboxLock('INBOX');
    try { await (seen ? c.messageFlagsAdd : c.messageFlagsRemove).call(c, String(uid), ['\\Seen'], { uid: true }); } finally { lock.release(); }
  });
  return { ok: true };
}

const folder = async (c: ImapFlow, use: string, names: RegExp) => { const all = await c.list(); return (all.find(f => f.specialUse === use) ?? all.find(f => names.test(f.name)))?.path; };

// Delete moves it to the mailbox's Trash, so it can still be got back from Stackmail's webmail.
export async function trash(boxId: number, uid: number) {
  await withBox(box(boxId), async c => {
    const to = await folder(c, '\\Trash', /^(trash|deleted( items| messages)?|bin)$/i);
    const lock = await c.getMailboxLock('INBOX');
    try { if (to) await c.messageMove(String(uid), to, { uid: true }); else await c.messageDelete(String(uid), { uid: true }); } finally { lock.release(); }
  });
  return { ok: true };
}

// Sends from one of the mailboxes, then files a copy in its Sent folder so webmail shows it too.
export type Outgoing = { to: string; cc?: string; subject: string; text: string; in_reply_to?: string; references?: string };
export async function send(boxId: number, m: Outgoing) {
  const b = box(boxId);
  if (!m.to.trim()) fail(400, 'Say who it is to');
  const mail = { from: { name: b.name === b.email ? '' : b.name, address: b.email }, to: m.to, cc: m.cc || undefined, subject: m.subject, text: m.text,
    inReplyTo: m.in_reply_to || undefined, references: [m.references, m.in_reply_to].filter(Boolean).join(' ') || undefined };
  const { message: raw } = await nodemailer.createTransport({ streamTransport: true, buffer: true }).sendMail(mail) as unknown as { message: Buffer };
  const smtp = nodemailer.createTransport({ host: b.smtp_host, port: b.smtp_port, secure: b.smtp_port === 465, auth: { user: b.username, pass: unseal(b.password) },
    connectionTimeout: 20_000, socketTimeout: 60_000 });
  try { await smtp.sendMail({ envelope: { from: b.email, to: [m.to, m.cc].filter(Boolean).join(', ') }, raw }); }
  catch (err) { fail(502, `It did not send: ${(err as Error).message}`); }
  let filed = true;
  try { await withBox(b, async c => { const sent = await folder(c, '\\Sent', /^sent( items| messages)?$/i); if (sent) await c.append(sent, raw, ['\\Seen']); else filed = false; }); }
  catch { filed = false; }
  return { ok: true, filed };
}
