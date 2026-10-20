import test from 'node:test'
import assert from 'node:assert/strict'
import { customerFixture } from './customer-fixture.ts'
import { notificationSettingsRoute, sendDuePartnerOrderEmails } from '../worker/partner-notifications.ts'
import { partnerOrderCompletedMessage } from '../worker/email.ts'
import { ApiError, type Env } from '../worker/platform.ts'
import type { Partner } from '../worker/partner-auth.ts'

const request = (payload: unknown) => new Request('https://api.example.test/api/partner/notification-settings', {
  method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://api.example.test' }, body: JSON.stringify(payload),
})

test('notification settings toggle saves with optimistic concurrency and reports the login email', async t => {
  const s = await customerFixture(); t.after(() => s.db.close())
  const env = { ...s.env, RESEND_FROM: 'Gift2Card <noreply@shop.example.invalid>', RESEND_API_KEY: 'test' } as Env
  const partner = { id: 'p1', slug: 'alpha', name: 'Alpha', email: 'owner@example.test', active: 1, version: 1, auth_version: 1, created_at: 0 } as Partner
  const now = Date.now()
  await s.db.prepare('INSERT INTO partners(id,slug,name,email,created_at,updated_at) VALUES (?,?,?,?,?,?)').run('p1', 'alpha', 'Alpha', 'owner@example.test', now, now)

  let view = await (await notificationSettingsRoute(new Request('https://api.example.test/api/partner/notification-settings'), env, partner)).json() as { orderCompletedEmail: boolean; recipient: string; version: number }
  assert.deepEqual(view, { orderCompletedEmail: false, recipient: 'owner@example.test', version: 0 })

  view = await (await notificationSettingsRoute(request({ orderCompletedEmail: true, version: 0 }), env, partner)).json() as typeof view
  assert.equal(view.orderCompletedEmail, true)
  assert.equal(view.version, 1)

  // A stale write must not silently echo someone else's toggle as saved.
  await assert.rejects(() => notificationSettingsRoute(request({ orderCompletedEmail: false, version: 0 }), env, partner), (e: unknown) => e instanceof ApiError && e.status === 409)
})

function seedOrder(s: Awaited<ReturnType<typeof customerFixture>>, id: string, partnerId: string, updatedAt: number) {
  s.db.prepare("INSERT INTO orders(id,owner_hash,idempotency_key,plan,plan_name,price_cents,mode,payment_status,status,partner_id,customer_email,created_at,updated_at,last_event_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(id, 'h' + id, 'k' + id, 'plus', 'ChatGPT Plus', 13900, 'live', 'paid', 'success', partnerId, 'buyer@example.test', updatedAt - 1000, updatedAt, 'e' + id)
}

test('order-completed email fires only for orders finished after the toggle, with retries', async t => {
  const s = await customerFixture(); t.after(() => s.db.close())
  const env = { ...s.env, RESEND_FROM: 'Gift2Card <noreply@shop.example.invalid>', RESEND_API_KEY: 'test' } as Env
  const now = Date.now()
  await s.db.prepare('INSERT INTO partners(id,slug,name,email,created_at,updated_at) VALUES (?,?,?,?,?,?)').run('p1', 'alpha', 'Alpha', 'owner@example.test', now, now)
  const partner = { id: 'p1' } as Partner
  await notificationSettingsRoute(request({ orderCompletedEmail: true, version: 0 }), env, partner)

  // Completed before the toggle was switched on: never enqueued.
  seedOrder(s, 'OLD-1', 'p1', Date.now() - 1000)
  let result = await sendDuePartnerOrderEmails(env)
  assert.equal(result.sent, 0)
  assert.equal((s.db.prepare('SELECT COUNT(*) n FROM partner_order_emails WHERE order_id=?').get() as { n: number }).n, 0)

  seedOrder(s, 'NEW-1', 'p1', Date.now() + 1000)
  seedOrder(s, 'NEW-2', 'p1', Date.now() + 1000)

  // First send fails for both; rows stay queued with a backoff.
  t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 500 }))
  result = await sendDuePartnerOrderEmails(env)
  assert.equal(result.failed, 2)
  assert.equal((s.db.prepare("SELECT COUNT(*) n FROM partner_order_emails WHERE delivered_at IS NULL").get() as { n: number }).n, 2)
  result = await sendDuePartnerOrderEmails(env) // backoff holds
  assert.equal(result.sent + result.failed, 0)

  // Toggle off mid-queue: pending notifications are dropped without sending.
  await s.db.prepare('UPDATE partner_order_emails SET next_attempt_at=0').run()
  await notificationSettingsRoute(request({ orderCompletedEmail: false, version: 1 }), env, partner)
  result = await sendDuePartnerOrderEmails(env)
  assert.equal(result.sent, 0)
  assert.equal((s.db.prepare('SELECT COUNT(*) n FROM partner_order_emails WHERE delivered_at IS NOT NULL').get() as { n: number }).n, 2)

  const seen: { to: string[]; key: string | null; mail: { subject: string; text: string } }[] = []
  t.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
    assert.equal(url, 'https://api.resend.com/emails')
    const mail = JSON.parse(String(options.body))
    seen.push({ to: mail.to, key: new Headers(options.headers).get('Idempotency-Key'), mail })
    return Response.json({ id: 'mail-' + seen.length })
  })
  await notificationSettingsRoute(request({ orderCompletedEmail: true, version: 2 }), env, partner)
  seedOrder(s, 'NEW-3', 'p1', Date.now() + 1000)
  result = await sendDuePartnerOrderEmails(env)
  assert.equal(result.sent, 1)
  assert.equal(seen.length, 1)

  assert.deepEqual(seen[0].to, ['owner@example.test'])
  assert.equal(seen[0].key, 'partner-order/NEW-3')
  assert.ok(seen[0].mail.text.includes('¥139.00') && seen[0].mail.text.includes('ChatGPT Plus') && seen[0].mail.subject.includes('/'))
  result = await sendDuePartnerOrderEmails(env)
  assert.equal(result.sent, 0)
})

test('message builder escapes customer text and keeps both languages', () => {
  const mail = partnerOrderCompletedMessage({ shop: 'Alpha<Shop', amount: '¥139.00', product: 'ChatGPT Plus', customer: 'a&b@example.test', completed: '2026/10/20 12:00:00', orderId: 'YMX-1' })
  assert.match(mail.text, /Alpha<Shop/)
  assert.match(mail.text, /a&b@example.test/)
  assert.match(mail.html, /Alpha&lt;Shop/)
  assert.match(mail.html, /a&amp;b@example\.test/)
  assert.doesNotMatch(mail.html, /__RECHARGE_/)
})
