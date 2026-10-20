import test from 'node:test'
import assert from 'node:assert/strict'
import { customerFixture } from './customer-fixture.ts'
import { DEFAULT_PRODUCT_ORDER } from '../shared/product-order.ts'
import { normalizePlanOrder } from '../shared/catalog-order.ts'

const endpoint = '/api/admin/catalog-order'

test('admin product and plan order is validated, audited and returned to storefronts', async t => {
  const s = await customerFixture(); t.after(() => s.db.close())
  const planIds = s.db.prepare('SELECT id FROM catalog_plans ORDER BY rowid').all().map(row => String(row.id))
  const productIds = [...DEFAULT_PRODUCT_ORDER].reverse()
  const reorderedPlans = [...planIds].reverse()
  const initial = await (await s.request(endpoint, undefined, s.admin)).json()
  assert.deepEqual(initial, { productIds: DEFAULT_PRODUCT_ORDER, planIds, version: 0 })
  assert.equal((await s.request(endpoint, { productIds, planIds: reorderedPlans, version: 0 })).status, 401)
  assert.equal((await s.request(endpoint, { productIds, planIds: reorderedPlans, version: 0 }, s.admin, 'https://evil.test')).status, 403)
  for (const payload of [
    { productIds: productIds.slice(1), planIds: reorderedPlans, version: 0 },
    { productIds, planIds: reorderedPlans.slice(1), version: 0 },
    { productIds, planIds: [...reorderedPlans, reorderedPlans[0]], version: 0 },
    { productIds, planIds: reorderedPlans, version: -1 },
  ]) assert.equal((await s.request(endpoint, payload, s.admin)).status, 400)

  const saved = await s.request(endpoint, { productIds, planIds: reorderedPlans, version: 0 }, s.admin)
  assert.equal(saved.status, 200, await saved.clone().text())
  assert.deepEqual(await saved.json(), { productIds, planIds: reorderedPlans, version: 1 })
  const publicCatalog = await (await s.request('/api/catalog')).json()
  assert.deepEqual(publicCatalog.productOrder, productIds)
  assert.deepEqual(publicCatalog.plans.map((plan: { id: string }) => plan.id), reorderedPlans)
  const adminCatalog = await (await s.request('/api/admin/plans', undefined, s.admin)).json()
  assert.deepEqual(adminCatalog.order, { productIds, planIds: reorderedPlans, version: 1 })
  assert.deepEqual(adminCatalog.plans.map((plan: { id: string }) => plan.id), reorderedPlans)
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM admin_audit WHERE action='catalog-order'").get()!.n, 1)

  const partner = await s.agent('sorted-shop')
  s.db.prepare('INSERT INTO partner_prices(partner_id,plan,cost_cents,price_cents) SELECT ?,id,price_cents,price_cents FROM catalog_plans').run(partner.id)
  const slug = String(s.db.prepare('SELECT slug FROM partners WHERE id=?').get(partner.id)!.slug)
  const partnerCatalog = await (await s.request('/api/catalog?partner=' + slug)).json()
  assert.deepEqual(partnerCatalog.productOrder, DEFAULT_PRODUCT_ORDER)
  assert.deepEqual(partnerCatalog.plans.map((plan: { id: string }) => plan.id), reorderedPlans)
})

test('concurrent catalog order saves keep one complete version', async t => {
  const s = await customerFixture(); t.after(() => s.db.close())
  const planIds = s.db.prepare('SELECT id FROM catalog_plans ORDER BY rowid').all().map(row => String(row.id))
  const results = await Promise.all([
    s.request(endpoint, { productIds: DEFAULT_PRODUCT_ORDER, planIds, version: 0 }, s.admin),
    s.request(endpoint, { productIds: [...DEFAULT_PRODUCT_ORDER].reverse(), planIds: [...planIds].reverse(), version: 0 }, s.admin),
  ])
  assert.deepEqual(results.map(response => response.status).sort(), [200, 409])
  const current = await (await s.request(endpoint, undefined, s.admin)).json()
  assert.equal(current.version, 1)
  assert.equal((await s.request(endpoint, { productIds: DEFAULT_PRODUCT_ORDER, planIds, version: 0 }, s.admin)).status, 409)
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM admin_audit WHERE action='catalog-order'").get()!.n, 1)
})

test('plan order normalization keeps saved positions and appends new plans', () => {
  assert.deepEqual(normalizePlanOrder(['pro-5x', 'retired', 'plus', 'pro-5x'], ['plus', 'pro-5x', 'new-plan']), ['pro-5x', 'plus', 'new-plan'])
})
