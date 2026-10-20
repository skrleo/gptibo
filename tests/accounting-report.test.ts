import test from 'node:test'
import assert from 'node:assert/strict'
import { customerFixture } from './customer-fixture.ts'

function insertOrders(s: Awaited<ReturnType<typeof customerFixture>>, count: number) {
  const now = Date.now()
  const insert = s.db.prepare('INSERT INTO orders(id,owner_hash,idempotency_key,plan,plan_name,price_cents,mode,payment_status,status,created_at,updated_at,last_event_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
  for (let index = 0; index < count; index++) {
    insert.run('YMX-TEST-' + String(index).padStart(2, '0'), 'hash-' + index, 'key-' + index, 'plus', 'Plus', 13900, 'live', 'paid', 'success', now - index * 1000, now - index * 1000, 'event-' + index)
  }
  return { start: now - 600000, end: now + 600000 }
}

test('accounting report export fetches the full filtered list beyond one page', async t => {
  const s = await customerFixture(); t.after(() => s.db.close())
  const { start, end } = insertOrders(s, 25)
  const params = `status=success&start=${start}&end=${end}`
  const paged = await (await s.request(`/api/admin/accounting/report?${params}&page=1`, undefined, s.admin)).json()
  assert.equal(paged.orders.length, 20)
  assert.equal(paged.totals.order_count, 25)
  assert.equal(paged.page, 1)
  const all = await (await s.request(`/api/admin/accounting/report?${params}&orders=all`, undefined, s.admin)).json()
  assert.equal(all.orders.length, 25)
  assert.equal(all.orders[0].id, 'YMX-TEST-00')
  assert.equal(all.totals.order_count, 25)
  assert.equal(all.totals.paid_cents, 25 * 13900)
})
