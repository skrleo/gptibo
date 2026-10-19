import test from 'node:test'
import assert from 'node:assert/strict'
import worker from '../worker/index.ts'
import { customerFixture } from './customer-fixture.ts'
import { sendDueSecurityAlerts, pruneSecurityAudit } from '../worker/security-audit.ts'
import { hash, type Env } from '../worker/platform.ts'

const WINDOW_MS = 15 * 60_000
const insertEvent = (s: Awaited<ReturnType<typeof customerFixture>>, values: Record<string, unknown>) => {
  const row = { id: crypto.randomUUID(), time: Date.now(), kind: 'auth', ip: '0123456789abcdef', request_id: 'req', route: '/api/admin/login', method: 'POST', status: 401, role: 'admin', account: 'tester', session: '', target: '', ...values }
  s.db.prepare('INSERT INTO security_events(id,time,kind,ip,request_id,route,method,status,role,account,session,target) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(row.id, row.time, row.kind, row.ip, row.request_id, row.route, row.method, row.status, row.role, row.account, row.session, row.target)
  return row
}

test('unauthenticated admin access is audited exactly once and the read endpoint requires the session', async t => {
  const s = await customerFixture(); t.after(() => s.db.close())
  assert.equal((await s.request('/api/admin/security')).status, 401)
  const rows = s.db.prepare('SELECT kind,status,role,account,route,method FROM security_events').all()
  assert.equal(rows.length, 1)
  assert.deepEqual([{ ...rows[0] }], [{ kind: 'auth', status: 401, role: 'admin', account: '', route: '/api/admin/security', method: 'GET' }])
  const summary = await (await s.request('/api/admin/security', undefined, s.admin)).json()
  assert.equal(summary.enabled, true)
  assert.equal(summary.events.length, 1)
  assert.equal(summary.events[0].route, '/api/admin/security')
})

test('order identifiers enter the audit only as fingerprints', async t => {
  const s = await customerFixture(); t.after(() => s.db.close())
  assert.equal((await s.request('/api/orders/YMX-TEST123')).status, 401)
  const rows = s.db.prepare('SELECT route,target FROM security_events').all()
  assert.equal(rows.length, 1)
  assert.deepEqual([{ ...rows[0] }], [{ route: '/api/orders/YMX-TEST123', target: (await hash('security-audit-target:YMX-TEST123')).slice(0, 16) }])
})

test('failed logins are audited with the attempted username until the 15 minute budget trips a block', async t => {
  const s = await customerFixture(); t.after(() => s.db.close())
  for (let attempt = 0; attempt < 9; attempt++) {
    const response = await s.request('/api/admin/login', { username: 'tester', challenge: crypto.randomUUID(), emailCode: '000000', code: '000000' })
    assert.ok([401, 429].includes(response.status))
  }
  const rows = s.db.prepare('SELECT kind,account,status FROM security_events ORDER BY time,id').all()
  assert.equal(rows.filter(row => row.kind === 'auth').length, 8)
  const blocks = rows.filter(row => row.kind === 'block')
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].status, 429)
  assert.equal(blocks[0].account, 'tester')
})

test('the security digest sends one email per completed window and skips empty or repeated windows', async t => {
  const s = await customerFixture(); t.after(() => s.db.close())
  const fixed = Date.now()
  const previous = Math.floor(fixed / WINDOW_MS) - 1
  insertEvent(s, { time: previous * WINDOW_MS + 60_000 })
  const calls: { url: string; key: string; body: { to: string[]; subject: string; text: string } }[] = []
  t.mock.method(globalThis, 'fetch', async (url: unknown, options: RequestInit) => {
    calls.push({ url: String(url), key: (options.headers as Record<string, string>)['Idempotency-Key'], body: JSON.parse(String(options.body)) })
    return new Response(JSON.stringify({ id: 'mail-1' }), { status: 200 })
  })
  t.mock.method(Date, 'now', () => fixed)
  const env = { ...s.env, RESEND_API_KEY: 'mock-key', RESEND_FROM: 'Alerts <alerts@example.test>' } as Env
  assert.deepEqual(await sendDueSecurityAlerts(env), { enabled: true, sent: 1 })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://api.resend.com/emails')
  assert.equal(calls[0].key, 'security-alert/' + previous)
  assert.deepEqual(calls[0].body.to, ['admin@example.invalid'])
  assert.match(calls[0].body.subject, /安全审计窗口告警/)
  assert.match(calls[0].body.text, /认证拒绝 1 次/)
  assert.match(calls[0].body.text, /POST \/api\/admin\/login（1 次）/)
  // The window marker makes the retry a no-op, and an empty window stays silent.
  assert.deepEqual(await sendDueSecurityAlerts(env), { enabled: true, sent: 0 })
  assert.equal(calls.length, 1)
  t.mock.method(Date, 'now', () => fixed + WINDOW_MS)
  assert.deepEqual(await sendDueSecurityAlerts(env), { enabled: true, sent: 0 })
  assert.equal(calls.length, 1)
  // Without mail credentials or a receivable admin address nothing is sent at all.
  assert.deepEqual(await sendDueSecurityAlerts({ ...env, RESEND_API_KEY: undefined }), { enabled: false, sent: 0 })
})

test('pruning keeps only the 7 day event tail and two days of window markers', async t => {
  const s = await customerFixture(); t.after(() => s.db.close())
  const now = Date.now()
  insertEvent(s, { id: 'old', time: now - 8 * 86400000 })
  insertEvent(s, { id: 'fresh', time: now - 3600_000 })
  s.db.prepare('INSERT INTO security_alerts(window_id,sent_at,totals,routes) VALUES (?,?,?,?)').run(Math.floor(now / WINDOW_MS) - 100, now, '', '')
  s.db.prepare('INSERT INTO security_alerts(window_id,sent_at,totals,routes) VALUES (?,?,?,?)').run(Math.floor(now / WINDOW_MS) - 1, now, '', '')
  await pruneSecurityAudit(s.env)
  assert.deepEqual(s.db.prepare('SELECT id FROM security_events').all().map(row => ({ ...row })), [{ id: 'fresh' }])
  assert.deepEqual(s.db.prepare('SELECT window_id FROM security_alerts ORDER BY window_id').all().map(row => ({ ...row })), [{ window_id: Math.floor(now / WINDOW_MS) - 1 }])
})

test('audit storage failures never change the guarded response', async () => {
  const env = {
    API_LIMITER: { limit: async () => ({ success: false }) },
    EXPENSIVE_LIMITER: { limit: async () => ({ success: true }) },
    INTEREST_DB: { prepare: () => { throw new Error('audit storage down') } },
  } as unknown as Env
  const response = await worker.fetch(new Request('https://shop.example.invalid/api/catalog', { headers: { 'CF-Connecting-IP': '203.0.113.10' } }), env)
  assert.equal(response.status, 429)
  assert.equal(response.headers.get('Retry-After'), '60')
})
