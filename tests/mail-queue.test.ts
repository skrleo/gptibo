import { seedAdminEmailCode } from './admin-email-fixture.ts'
import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync, readdirSync } from 'node:fs'
import worker from '../worker/index.ts'
import { runMailQueue } from '../worker/mail-queue.ts'
import { totpCode } from '../worker/totp.ts'
import type { Env, Statement, Value } from '../worker/platform.ts'

const credential = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'

async function setup() {
  const db = new DatabaseSync(':memory:')
  for (const file of readdirSync(new URL('../migrations/', import.meta.url)).filter(f => f.endsWith('.sql')).sort()) db.exec(readFileSync(new URL('../migrations/' + file, import.meta.url), 'utf8'))
  const bound = new WeakMap<Statement, { sql: string; values: Value[] }>()
  const env: Env = {
    ORDER_TESTING_ENABLED: 'true', MAIL_QUEUE_ENABLED: 'true', RESEND_API_KEY: 're_platform', RESEND_FROM: 'noreply@platform.invalid',
    ASSETS: { fetch: async () => new Response('asset') }, ADMIN_EMAIL: 'admin@example.invalid', ADMIN_USERNAME: 'tester', ADMIN_TOTP_SECRET: credential,
    INTEREST_LIMITER: { limit: async () => ({ success: true }) },
    API_LIMITER: { limit: async () => ({ success: true }) },
    EXPENSIVE_LIMITER: { limit: async () => ({ success: true }) },
    INTEREST_DB: {
      prepare(sql: string): Statement {
        const state = { sql, values: [] as Value[] }
        const statement: Statement = { bind(...values) { state.values = values; return this }, async first<T>() { return (db.prepare(sql).get(...state.values) ?? null) as T | null }, async all<T>() { return { results: db.prepare(sql).all(...state.values) as T[] } }, async run() { return db.prepare(sql).run(...state.values) } }
        bound.set(statement, state); return statement
      },
      async batch(statements) {
        db.exec('BEGIN')
        try { const results = statements.map(s => { const state = bound.get(s)!; const prepared = db.prepare(state.sql); return /^\s*SELECT\b/i.test(state.sql) ? { results: prepared.all(...state.values) } : prepared.run(...state.values) }); db.exec('COMMIT'); return results }
        catch (e) { db.exec('ROLLBACK'); throw e }
      },
    },
  }
  const request = (path: string, data?: unknown, cookie = '', origin = 'https://shop.example.invalid') => worker.fetch(new Request('https://shop.example.invalid' + path, { method: data === undefined ? 'GET' : 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', Cookie: cookie }, body: data === undefined ? undefined : JSON.stringify(data) }), env)
  const buyer = async () => (await request('/api/orders/client', {})).headers.get('Set-Cookie')!.split(';')[0]
  const login = async () => {
    const seeded = await seedAdminEmailCode(db, env)
    const response = await request('/api/admin/login', { username: 'tester', code: await totpCode(credential), ...seeded })
    assert.equal(response.status, 200)
    return response.headers.get('Set-Cookie')!.split(';')[0]
  }
  // Mail queue orders need a live order with confirmed payment to enqueue.
  const paidOrder = async (cookie: string) => {
    const price = db.prepare('SELECT price_cents FROM catalog_plans WHERE id=?').get('mail-queue-once')!.price_cents as number
    const response = await request('/api/orders', { email: 'buyer@example.test', plan: 'mail-queue-once', expectedPrice: price, key: crypto.randomUUID() }, cookie)
    assert.equal(response.status, 201, await response.clone().text())
    const order = (await response.json()).order as { id: string }
    assert.equal(order.mode, 'live')
    db.prepare("UPDATE orders SET payment_status='paid',status='session' WHERE id=?").run(order.id)
    return order.id as string
  }
  return { db, env, request, buyer, login, paidOrder }
}

type Mail = { headers: Record<string, string>; body: { from: string; to: string[]; subject: string; text: string } }

function resendMock(t: test.TestContext, handler: (mail: Mail) => { ok: boolean }) {
  const mails: Mail[] = []
  t.mock.method(globalThis, 'fetch', async (url: string | URL, init?: RequestInit) => {
    if (String(url) !== 'https://api.resend.com/emails') return new Response('asset')
    const mail = { headers: init!.headers as Record<string, string>, body: JSON.parse(String(init!.body)) } as Mail
    mails.push(mail)
    const outcome = handler(mail)
    return outcome.ok ? Response.json({ id: 're_' + mails.length }) : new Response('rejected', { status: 422 })
  })
  return mails
}

// Force every step of a task due so the next cron run sends the remaining mails.
function forceDue(db: DatabaseSync, orderId: string) {
  const task = db.prepare('SELECT id,total_steps,step_spacing_ms FROM mail_queue_tasks WHERE order_id=?').get(orderId) as { id: string; total_steps: number; step_spacing_ms: number }
  db.prepare('UPDATE mail_queue_tasks SET start_at=?,next_run_at=0 WHERE id=?').run(Date.now() - (task.total_steps + 2) * task.step_spacing_ms, task.id)
}

test('paid mail queue orders enqueue through the cron sweep and deliver every sender over the configured duration', async t => {
  const s = await setup(); t.after(() => s.db.close())
  const admin = await s.login(), buyer = await s.buyer()
  for (const [label, email, key, name] of [['邮箱 A', 'noreply@a.invalid', '', ''], ['邮箱 B', 'noreply@b.invalid', 're_b', 'noreply B'], ['邮箱 C', 'noreply@c.invalid', '', '']] as const)
    assert.equal((await s.request('/api/admin/mail-queue/senders', { action: 'create', label, fromEmail: email, apiKey: key, fromName: name, sortOrder: 0 }, admin)).status, 200)
  const mails = resendMock(t, () => ({ ok: true }))
  const orderId = await s.paidOrder(buyer)

  // First run only creates the task; steps fire after their spacing slot arrives.
  await runMailQueue(s.env)
  const task = s.db.prepare('SELECT * FROM mail_queue_tasks WHERE order_id=?').get(orderId) as { status: string; total_steps: number; step_spacing_ms: number }
  assert.equal(task.status, 'queued')
  assert.equal(task.total_steps, 3)
  assert.equal(task.step_spacing_ms, 100000)
  assert.equal(mails.length, 0)

  forceDue(s.db, orderId)
  await runMailQueue(s.env)
  assert.equal(mails.length, 3)
  assert.deepEqual(mails.map(m => m.body.from), ['noreply@a.invalid', 'noreply B <noreply@b.invalid>', 'noreply@c.invalid'])
  assert.deepEqual(mails.map(m => m.body.to), [['buyer@example.test'], ['buyer@example.test'], ['buyer@example.test']])
  // A dedicated key keeps retries idempotent; per-sender keys override the platform one.
  assert.ok(mails.every(m => m.headers['Idempotency-Key'].startsWith('mail-queue/')))
  assert.equal(mails[1].headers.Authorization, 'Bearer re_b')
  assert.equal(mails[0].headers.Authorization, 'Bearer re_platform')
  assert.match(mails[0].body.subject, /订单 YMX-/)
  assert.match(mails[0].body.text, /第 1 封邮件（共 3 封）/)

  const finished = s.db.prepare('SELECT * FROM mail_queue_tasks WHERE order_id=?').get(orderId) as { status: string; done_steps: number }
  assert.equal(finished.status, 'done')
  assert.equal(finished.done_steps, 3)
  assert.equal((s.db.prepare("SELECT status FROM orders WHERE id=?").get(orderId) as { status: string }).status, 'success')
  const actions = (s.db.prepare('SELECT action FROM order_events WHERE order_id=? ORDER BY created_at').all(orderId) as { action: string }[]).map(r => r.action)
  assert.ok(actions.includes('mail-queue-created') && actions.includes('mail-queue-sending') && actions.includes('mail-queue-done'))
  assert.equal((s.db.prepare('SELECT sent_count FROM mail_senders WHERE id=2').get() as { sent_count: number }).sent_count, 1)

  // The customer view reports progress through the mailQueue summary.
  const detail = await (await s.request('/api/orders/' + orderId, undefined, buyer)).json()
  assert.equal(detail.order.mailQueue.status, 'done')
  assert.equal(detail.order.mailQueue.total, 3)
})

test('a sender that keeps failing is skipped after three attempts while the rest of the queue completes', async t => {
  const s = await setup(); t.after(() => s.db.close())
  const admin = await s.login(), buyer = await s.buyer()
  for (const [label, email] of [['好邮箱', 'noreply@good.invalid'], ['坏邮箱', 'noreply@bad.invalid']] as const)
    await s.request('/api/admin/mail-queue/senders', { action: 'create', label, fromEmail: email, sortOrder: 0 }, admin)
  const mails = resendMock(t, mail => ({ ok: !mail.body.from.includes('bad') }))
  const orderId = await s.paidOrder(buyer)
  await runMailQueue(s.env)
  forceDue(s.db, orderId)
  for (let run = 0; run < 3; run++) await runMailQueue(s.env)

  assert.equal(mails.filter(m => m.body.from === 'noreply@good.invalid').length, 1)
  const task = s.db.prepare('SELECT * FROM mail_queue_tasks WHERE order_id=?').get(orderId) as { status: string; done_steps: number; failed_steps: number }
  assert.equal(task.status, 'done')
  assert.equal(task.done_steps, 1)
  assert.equal(task.failed_steps, 1)
  assert.equal((s.db.prepare("SELECT status FROM orders WHERE id=?").get(orderId) as { status: string }).status, 'success')
  const step = s.db.prepare("SELECT * FROM mail_queue_steps WHERE recipient='buyer@example.test' AND sender_id=(SELECT id FROM mail_senders WHERE from_email='noreply@bad.invalid')").get() as { status: string; attempts: number }
  assert.equal(step.status, 'failed')
  assert.equal(step.attempts, 3)
})

test('a cancelled task can be resumed by retry and finishes its remaining sends', async t => {
  const s = await setup(); t.after(() => s.db.close())
  const admin = await s.login(), buyer = await s.buyer()
  s.db.prepare("INSERT INTO mail_senders(label,from_email,created_at,updated_at) VALUES ('邮箱 A','noreply@a.invalid',?,?)").run(Date.now(), Date.now())
  const mails = resendMock(t, () => ({ ok: true }))
  const orderId = await s.paidOrder(buyer)
  await runMailQueue(s.env)
  const taskId = (s.db.prepare('SELECT id FROM mail_queue_tasks WHERE order_id=?').get(orderId) as { id: string }).id
  assert.equal((await s.request(`/api/admin/mail-queue/tasks/${taskId}`, { action: 'cancel' }, admin)).status, 200)
  assert.equal((s.db.prepare('SELECT status FROM mail_queue_tasks WHERE id=?').get(taskId) as { status: string }).status, 'cancelled')
  assert.equal((await s.request(`/api/admin/mail-queue/tasks/${taskId}`, { action: 'retry' }, admin)).status, 200)
  assert.equal((s.db.prepare('SELECT status FROM mail_queue_tasks WHERE id=?').get(taskId) as { status: string }).status, 'sending')
  forceDue(s.db, orderId)
  await runMailQueue(s.env)
  assert.equal(mails.length, 1)
  const task = s.db.prepare('SELECT status, done_steps FROM mail_queue_tasks WHERE id=?').get(taskId) as { status: string; done_steps: number }
  assert.equal(task.status, 'done')
  assert.equal(task.done_steps, 1)
  assert.equal((s.db.prepare("SELECT status FROM orders WHERE id=?").get(orderId) as { status: string }).status, 'success')
})

test('refunded orders retire their queue task instead of continuing to send', async t => {
  const s = await setup(); t.after(() => s.db.close())
  const buyer = await s.buyer()
  s.db.prepare("INSERT INTO mail_senders(label,from_email,created_at,updated_at) VALUES ('邮箱 A','noreply@a.invalid',?,?)").run(Date.now(), Date.now())
  const mails = resendMock(t, () => ({ ok: true }))
  const orderId = await s.paidOrder(buyer)
  await runMailQueue(s.env)
  s.db.prepare('UPDATE orders SET refund_hold=1 WHERE id=?').run(orderId)
  forceDue(s.db, orderId)
  await runMailQueue(s.env)

  assert.equal(mails.length, 0)
  const task = s.db.prepare('SELECT * FROM mail_queue_tasks WHERE order_id=?').get(orderId) as { status: string }
  assert.equal(task.status, 'cancelled')
  assert.ok((s.db.prepare("SELECT action FROM order_events WHERE order_id=? AND action='mail-queue-cancelled'").all(orderId) as unknown[]).length > 0)
})

test('admin settings updates change the template for future tasks only', async t => {
  const s = await setup(); t.after(() => s.db.close())
  const admin = await s.login()
  s.db.prepare("INSERT INTO mail_senders(label,from_email,created_at,updated_at) VALUES ('邮箱 A','noreply@a.invalid',?,?)").run(Date.now(), Date.now())
  assert.equal((await s.request('/api/admin/mail-queue/settings', { version: 1, subject: '新版主题 {order}', body: '新版正文第 {index} 封', durationMinutes: 2 }, admin)).status, 200)

  const mails = resendMock(t, () => ({ ok: true }))
  const buyer = await s.buyer()
  const orderId = await s.paidOrder(buyer)
  await runMailQueue(s.env)
  forceDue(s.db, orderId)
  await runMailQueue(s.env)
  assert.equal(mails.length, 1)
  assert.equal(mails[0].body.subject, '新版主题 ' + orderId)
  assert.equal(mails[0].body.text, '新版正文第 1 封')
  // duration 2 minutes with one sender spaces the single step two minutes out.
  assert.equal((s.db.prepare('SELECT step_spacing_ms FROM mail_queue_tasks WHERE order_id=?').get(orderId) as { step_spacing_ms: number }).step_spacing_ms, 120000)
  // Sender keys never leave the server: reads expose only their length.
  const overview = await (await s.request('/api/admin/mail-queue', undefined, admin)).json()
  assert.ok(!JSON.stringify(overview).includes('re_platform'))
  assert.ok(overview.senders[0].key_length === 0)
})
