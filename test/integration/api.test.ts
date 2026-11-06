import { beforeEach, describe, expect, it } from 'vitest';
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../../src/worker/index';
import { useFakeApis } from '../helpers/fake';
import { Client, deliver, email, ORIGIN, setupInstance } from '../helpers/client';

// Calls the Inbox API like a script would: an API key, no cookies, no CSRF token.
async function call(key: string | null, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const h = new Headers(headers);
  if (key) h.set('Authorization', `Bearer ${key}`);
  if (body !== undefined) h.set('Content-Type', 'application/json');
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(ORIGIN + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }), env, ctx);
  await waitOnExecutionContext(ctx);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

describe('Inbox API', () => {
  let admin: Client;
  let fake: ReturnType<typeof useFakeApis>;
  beforeEach(async () => {
    fake = useFakeApis();
    admin = new Client();
    await setupInstance(admin);
    await admin.post('/api/admin/providers', { type: 'resend', config: { apiKey: 're_test_key_123' } });
  });

  const newKey = (scopes: string[], extra: Record<string, unknown> = {}) => admin.post('/api/account/api-keys', { name: 'script', scopes, ...extra });

  it('sends, reads and polls mail with a key', async () => {
    const created = await newKey(['read', 'send']);
    expect(created.key).toMatch(/^oik_/);
    expect((await admin.get('/api/account/api-keys'))[0]).toMatchObject({ name: 'script', prefix: created.key.slice(0, 12) });
    expect((await admin.get('/api/account/api-keys'))[0].key).toBeUndefined();

    const me = await call(created.key, 'GET', '/api/v1/me');
    expect(me.body.user.email).toBe('admin@example.com');
    const boxes = await call(created.key, 'GET', '/api/v1/mailboxes');
    expect(boxes.body.mailboxes[0]).toMatchObject({ address: 'admin@example.com', canSend: true });

    const sent = await call(created.key, 'POST', '/api/v1/messages', { from: 'admin@example.com', to: ['lead@dest.test'], subject: 'Hello', text: 'Plain text body' });
    expect(sent.status).toBe(201);
    expect(sent.body).toMatchObject({ status: 'sent', replayed: false });
    const out = fake.state.resend.emails[0] as { to: string[]; text: string; html?: string };
    expect(out.to).toEqual(['lead@dest.test']);
    expect(out.text).toBe('Plain text body');
    // Tracking is off until an admin turns it on.
    expect(out.html ?? '').not.toContain('/api/t/');

    await deliver(email({ subject: 'Re: Hello', messageId: 'r1@dest.test' }), { from: 'lead@dest.test', to: 'admin@example.com' });
    const inbound = await call(created.key, 'GET', '/api/v1/messages?direction=in');
    expect(inbound.body.messages).toHaveLength(1);
    expect(inbound.body.messages[0]).toMatchObject({ subject: 'Re: Hello', folder: 'inbox', direction: 'in' });
    // Polling from the cursor returns nothing new.
    expect((await call(created.key, 'GET', `/api/v1/messages?direction=in&cursor=${inbound.body.nextCursor}`)).body.messages).toHaveLength(0);

    const detail = await call(created.key, 'GET', `/api/v1/messages/${inbound.body.messages[0].id}`);
    expect(detail.body).toMatchObject({ subject: 'Re: Hello', threadId: inbound.body.messages[0].threadId });
    expect(detail.body.text).toBeTypeOf('string');
    const thread = await call(created.key, 'GET', `/api/v1/threads/${detail.body.threadId}`);
    expect(thread.body.messages).toHaveLength(2);
    expect((await call(created.key, 'GET', '/api/v1/search?q=hello')).body.threads).toHaveLength(1);
    expect((await call(created.key, 'GET', '/api/v1/threads?view=sent')).body.threads).toHaveLength(1);
  });

  it('replays a send with the same Idempotency-Key', async () => {
    const { key } = await newKey(['send']);
    const msg = { from: 'admin@example.com', to: [{ name: 'Lead', address: 'lead@dest.test' }], subject: 'Once', html: '<p>Hi</p>' };
    const first = await call(key, 'POST', '/api/v1/messages', msg, { 'Idempotency-Key': 'order-42' });
    const again = await call(key, 'POST', '/api/v1/messages', msg, { 'Idempotency-Key': 'order-42' });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ id: first.body.id, replayed: true });
    expect(fake.state.resend.emails).toHaveLength(1);
  });

  it('enforces scopes, mailbox limits and bad keys', async () => {
    expect((await call(null, 'GET', '/api/v1/me')).status).toBe(401);
    expect((await call('oik_notarealkeynotarealkey00', 'GET', '/api/v1/me')).status).toBe(401);
    // Cookies don't authenticate the API.
    expect(await admin.status('GET', '/api/v1/me')).toBe(401);

    const reader = await newKey(['read']);
    const send = { from: 'admin@example.com', to: ['x@dest.test'], subject: 'No', text: 'No' };
    expect((await call(reader.key, 'POST', '/api/v1/messages', send)).status).toBe(403);
    expect((await call(reader.key, 'POST', '/api/v1/threads/actions', { threadIds: [1], action: 'read' })).status).toBe(403);

    const boxes = await admin.get('/api/admin/mailboxes');
    const adminId = (await admin.get('/api/auth/session')).user.id;
    const other = await admin.post('/api/admin/mailboxes', { localPart: 'sales', domainId: boxes[0].domainId, members: [{ userId: adminId, canSend: true }] });
    const salesOnly = await newKey(['read', 'send'], { mailboxIds: [other.id] });
    expect((await call(salesOnly.key, 'GET', '/api/v1/mailboxes')).body.mailboxes.map((m: { address: string }) => m.address)).toEqual(['sales@example.com']);
    expect((await call(salesOnly.key, 'POST', '/api/v1/messages', send)).body.error.code).toBe('bad_from');

    await admin.del(`/api/account/api-keys/${reader.id}`);
    expect((await call(reader.key, 'GET', '/api/v1/me')).status).toBe(401);
    const expired = await newKey(['read'], { expiresInDays: 1 });
    await env.DB.prepare('UPDATE api_keys SET expires_at = 1 WHERE id = ?').bind(expired.id).run();
    expect((await call(expired.key, 'GET', '/api/v1/me')).status).toBe(401);
  });

  it('rate limits each key', async () => {
    const { key } = await newKey(['read']);
    for (let i = 0; i < 120; i++) expect((await call(key, 'GET', '/api/v1/me')).status).toBe(200);
    const limited = await call(key, 'GET', '/api/v1/me');
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe('rate_limited');
  });

  it('refuses attachments when attachment storage is off', async () => {
    const { key } = await newKey(['send']);
    const r = await call(key, 'POST', '/api/v1/messages', {
      from: 'admin@example.com',
      to: ['x@dest.test'],
      text: 'See attached',
      attachments: [{ filename: 'a.txt', contentType: 'text/plain', content: btoa('hello') }],
    });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('attachments_disabled');
  });
  it('tracks opens and clicks of sent mail when turned on, apart from machines', async () => {
    await admin.patch('/api/admin/settings', { tracking: 'on' });
    expect((await admin.get('/api/admin/settings')).tracking).toBe('on');
    const { key } = await newKey(['read', 'send']);
    const plain = await call(key, 'POST', '/api/v1/messages', { from: 'admin@example.com', to: ['lead@dest.test'], subject: 'Hi', text: 'Plain text' });
    // A plain-text message gets an HTML part with the pixel.
    expect((fake.state.resend.emails[0] as { html: string }).html).toContain(`${ORIGIN}/api/t/`);
    expect(plain.body.status).toBe('sent');
    const sent = await call(key, 'POST', '/api/v1/messages', {
      from: 'admin@example.com',
      to: ['lead@dest.test'],
      subject: 'Proposal',
      html: '<p>See <a href="https://site.test/p?a=1&amp;b=2">the proposal</a>.</p>',
    });
    const out = fake.state.resend.emails[1] as { html: string };
    const token = /\/api\/t\/([A-Za-z0-9_-]+)\.gif/.exec(out.html)![1];
    expect(out.html).toContain(`${ORIGIN}/api/t/${token}/0`);
    expect(out.html).not.toContain('site.test');

    const get = async (path: string, ua: string, method = 'GET') => {
      const ctx = createExecutionContext();
      const res = await worker.fetch(new Request(ORIGIN + path, { method, headers: { 'User-Agent': ua }, redirect: 'manual' }), env, ctx);
      await waitOnExecutionContext(ctx);
      return res;
    };
    const chrome = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';
    expect((await get(`/api/t/${token}.gif`, 'Mozilla/5.0')).headers.get('content-type')).toBe('image/gif');
    // A link scanner right after sending, then the reader later.
    expect((await get(`/api/t/${token}/0`, chrome, 'HEAD')).status).toBe(302);
    await env.DB.prepare('UPDATE tracked_messages SET sent_at = sent_at - 3600000').run();
    expect((await get(`/api/t/${token}.gif`, chrome)).status).toBe(200);
    const click = await get(`/api/t/${token}/0`, chrome);
    expect(click.status).toBe(302);
    expect(click.headers.get('location')).toBe('https://site.test/p?a=1&b=2');
    expect((await get(`/api/t/${token}/5`, chrome)).status).toBe(404);
    expect((await get('/api/t/unknownunknownunknown.gif', chrome)).status).toBe(200);

    const { summary, events } = (await call(key, 'GET', `/api/v1/messages/${sent.body.id}/events`)).body;
    expect(summary).toMatchObject({ opened: 1, machineOpens: 1, clicked: 1, machineClicks: 1, links: [{ url: 'https://site.test/p?a=1&b=2', clicks: 1 }] });
    expect(events.map((e: { source: string }) => e.source).sort()).toEqual(['apple', 'human', 'human', 'scanner']);
    // The stored copy is what was written, and the thread shows the summary.
    const thread = await admin.get(`/api/threads/${sent.body.threadId}`);
    expect(thread.messages[0].html).toContain('https://site.test/p');
    expect(thread.messages[0].tracking).toMatchObject({ opened: 1, clicked: 1 });
  });
  it("doesn't track system mail such as auto-replies", async () => {
    await admin.patch('/api/admin/settings', { tracking: 'on' });
    const boxes = await admin.get('/api/mailboxes');
    await admin.patch(`/api/mailboxes/${boxes[0].id}/settings`, { autoReply: { enabled: true, subject: 'Away', body: 'Back on Monday, see https://site.test' } });
    await deliver(email({ subject: 'Hello?', messageId: 'ar1@dest.test' }), { from: 'ann@dest.test', to: 'admin@example.com' });
    const out = fake.state.resend.emails as { subject: string; html?: string | null; text: string }[];
    expect(out).toHaveLength(1);
    expect(out[0].text).toContain('Back on Monday');
    expect(out[0].html ?? '').not.toContain('/api/t/');
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM tracked_messages').first<{ n: number }>())!.n).toBe(0);
  });
});
