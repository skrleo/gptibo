import test from 'node:test'
import assert from 'node:assert/strict'
import { customerFixture } from './customer-fixture.ts'
import { adminTicketRoutes, partnerTicketRoutes } from '../worker/tickets.ts'
import { adminRefunds } from '../worker/refunds.ts'
import { ApiError } from '../worker/platform.ts'
import type { Partner } from '../worker/partner-auth.ts'

const origin = 'https://api.example.test'
const post = (path: string, payload: unknown) => new Request('https://api.example.test' + path, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify(payload) })
const get = (path: string) => new Request('https://api.example.test' + path, { method: 'GET', headers: { origin } })
const key = () => crypto.randomUUID()

test('ticket lifecycle: idempotent create, partner replies, admin replies, alerts polling', async t => {
  const s = await customerFixture(); t.after(() => s.db.close())
  const env = s.env
  const now = Date.now()
  const insertPartner = (id: string, email: string) => s.db.prepare('INSERT INTO partners(id,slug,name,email,created_at,updated_at) VALUES (?,?,?,?,?,?)').run(id, 'slug-' + id, 'Partner ' + id, email, now, now)
  insertPartner('p1', 'one@example.test')
  insertPartner('p2', 'two@example.test')
  const p1 = { id: 'p1', email: 'one@example.test' } as Partner
  const p2 = { id: 'p2', email: 'two@example.test' } as Partner
  s.db.prepare("INSERT INTO orders(id,owner_hash,idempotency_key,plan,plan_name,price_cents,mode,payment_status,status,partner_id,created_at,updated_at,last_event_id) VALUES ('YMX-A','h1','k1','plus','Plus',13900,'live','paid','success','p1',?,?,'e1')").run(now, now)
  s.db.prepare("INSERT INTO orders(id,owner_hash,idempotency_key,plan,plan_name,price_cents,mode,payment_status,status,partner_id,created_at,updated_at,last_event_id) VALUES ('YMX-B','h2','k2','plus','Plus',13900,'live','paid','success','p2',?,?,'e2')").run(now, now)

  // Unknown or foreign order numbers are rejected.
  await assert.rejects(() => partnerTicketRoutes(post('/api/partner/tickets', { orderId: 'NOPE', subject: 's', body: 'b', key: key() }), env, new URL('https://api.example.test/api/partner/tickets'), p1), (e: unknown) => e instanceof ApiError && e.status === 404)
  await assert.rejects(() => partnerTicketRoutes(post('/api/partner/tickets', { orderId: 'YMX-B', subject: 's', body: 'b', key: key() }), env, new URL('https://api.example.test/api/partner/tickets'), p1), (e: unknown) => e instanceof ApiError && e.status === 404)

  const createKey = key()
  const created = await (await partnerTicketRoutes(post('/api/partner/tickets', { orderId: 'YMX-A', subject: '付款后未充值', body: '已经付款 30 分钟', key: createKey }), env, new URL('https://api.example.test/api/partner/tickets'), p1)).json() as { id: string }
  // Replay returns the first submission's id without a duplicate event.
  const replay = await (await partnerTicketRoutes(post('/api/partner/tickets', { orderId: 'YMX-A', subject: '付款后未充值', body: '已经付款 30 分钟', key: createKey }), env, new URL('https://api.example.test/api/partner/tickets'), p1)).json() as { id: string }
  assert.equal(replay.id, created.id)
  assert.equal((s.db.prepare('SELECT COUNT(*) n FROM ticket_events').get() as { n: number }).n, 1)

  let detail = await (await partnerTicketRoutes(get('/api/partner/tickets/' + created.id), env, new URL('https://api.example.test/api/partner/tickets/' + created.id), p1)).json() as { status: string; version: number; events: unknown[] }
  assert.equal(detail.status, 'open')
  assert.equal(detail.version, 1)
  assert.equal(detail.events.length, 1)

  // Cross-partner access is a plain 404.
  await assert.rejects(() => partnerTicketRoutes(get('/api/partner/tickets/' + created.id), env, new URL('https://api.example.test/api/partner/tickets/' + created.id), p2), (e: unknown) => e instanceof ApiError && e.status === 404)

  const replyKey = key()
  await partnerTicketRoutes(post(`/api/partner/tickets/${created.id}/replies`, { body: '补充：邮箱是 buyer@example.test', key: replyKey, version: 1 }), env, new URL(`https://api.example.test/api/partner/tickets/${created.id}/replies`), p1)
  // Replay of the same reply key does not duplicate or bump the version.
  await partnerTicketRoutes(post(`/api/partner/tickets/${created.id}/replies`, { body: '补充：邮箱是 buyer@example.test', key: replyKey, version: 1 }), env, new URL(`https://api.example.test/api/partner/tickets/${created.id}/replies`), p1)
  // Stale versions conflict; the frontend refreshes on 409.
  await assert.rejects(() => partnerTicketRoutes(post(`/api/partner/tickets/${created.id}/replies`, { body: 'again', key: key(), version: 1 }), env, new URL(`https://api.example.test/api/partner/tickets/${created.id}/replies`), p1), (e: unknown) => e instanceof ApiError && e.status === 409)
  detail = await (await partnerTicketRoutes(get('/api/partner/tickets/' + created.id), env, new URL('https://api.example.test/api/partner/tickets/' + created.id), p1)).json() as typeof detail
  assert.equal(detail.version, 2)
  assert.equal(detail.events.length, 2)

  // Admin alerts: one open ticket, version tracks the event count.
  let alerts = await (await adminTicketRoutes(get('/api/admin/tickets/notifications'), env, new URL('https://api.example.test/api/admin/tickets/notifications'))).json() as { version: number; pending: number }
  assert.deepEqual(alerts, { version: 2, pending: 1 })

  // Admin search matches partner email; the row carries partner identity.
  const list = await (await adminTicketRoutes(get('/api/admin/tickets?q=two@example.test'), env, new URL('https://api.example.test/api/admin/tickets?q=two@example.test'))).json() as { rows: { partner_name: string; partner_email: string }[]; total: number }
  assert.equal(list.total, 0)
  const found = await (await adminTicketRoutes(get('/api/admin/tickets?q=one@example.test'), env, new URL('https://api.example.test/api/admin/tickets?q=one@example.test'))).json() as { rows: { id: string; partner_name: string; partner_email: string; subject: string; status: string }[]; total: number }
  assert.equal(found.total, 1)
  assert.equal(found.rows[0].id, created.id)
  assert.equal(found.rows[0].partner_email, 'one@example.test')

  await adminTicketRoutes(post(`/api/admin/tickets/${created.id}/replies`, { body: '已联系供应商核实，正在处理', status: 'waiting', key: key(), version: 2 }), env, new URL(`https://api.example.test/api/admin/tickets/${created.id}/replies`))
  detail = await (await adminTicketRoutes(get('/api/admin/tickets/' + created.id), env, new URL('https://api.example.test/api/admin/tickets/' + created.id))).json() as typeof detail
  assert.equal(detail.status, 'waiting')
  assert.equal(detail.version, 3)
  alerts = await (await adminTicketRoutes(get('/api/admin/tickets/notifications'), env, new URL('https://api.example.test/api/admin/tickets/notifications'))).json() as typeof alerts
  assert.deepEqual(alerts, { version: 3, pending: 0 })

  // Status filter + pagination counts behave for the partner list.
  const mine = await (await partnerTicketRoutes(get('/api/partner/tickets?status=waiting'), env, new URL('https://api.example.test/api/partner/tickets?status=waiting'), p1)).json() as { rows: unknown[]; total: number }
  assert.equal(mine.total, 1)
  const resolved = await (await partnerTicketRoutes(get('/api/partner/tickets?status=resolved'), env, new URL('https://api.example.test/api/partner/tickets?status=resolved'), p1)).json() as { rows: unknown[]; total: number }
  assert.equal(resolved.total, 0)
})

test('refunds notifications summarize pending cases and event version', async t => {
  const s = await customerFixture(); t.after(() => s.db.close())
  const response = await adminRefundsNotifications(s.env)
  assert.deepEqual(response, { version: 0, pending: 0 })
  const now = Date.now()
  s.db.prepare("INSERT INTO orders(id,owner_hash,idempotency_key,plan,plan_name,price_cents,mode,payment_status,status,created_at,updated_at,last_event_id) VALUES ('O1','ho','ko','plus','Plus',13900,'demo','simulated','success',?,?,'eo')").run(now, now)
  s.db.prepare("INSERT INTO refund_cases(id,order_id,request_key,reason,status,requested_cents,created_at,updated_at,last_event_id) VALUES ('rc1','O1','rk1','不想要了','pending',1000,?,?,'ev1')").run(now, now)
  s.db.prepare("INSERT INTO refund_events(id,case_id,status,note,actor,created_at) VALUES ('ev1','rc1','pending','客户申请退款','customer',?)").run(now)
  const next = await adminRefundsNotifications(s.env)
  assert.equal(next.pending, 1)
  assert.equal(next.version, 1)
})

async function adminRefundsNotifications(env: Awaited<ReturnType<typeof customerFixture>>['env']) {
  const response = await adminRefunds(new Request('https://api.example.test/api/admin/refunds/notifications', { method: 'GET' }), env, new URL('https://api.example.test/api/admin/refunds/notifications'))
  return await response.json() as Promise<{ version: number; pending: number }>
}
