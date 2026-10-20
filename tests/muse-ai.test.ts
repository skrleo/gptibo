import test from 'node:test'
import assert from 'node:assert/strict'
import { customerFixture } from './customer-fixture.ts'
import { PLANS } from '../src/lib/demo-orders.ts'
import { PRODUCTS } from '../src/lib/products.ts'
import { productNameForId, productNameForPlan } from '../shared/email-products.ts'
import { DEFAULT_PRODUCT_ORDER, normalizeProductOrder } from '../shared/product-order.ts'
import { applyPaymentResult, findPayment } from '../worker/payments/service.ts'

const usdtAddress = 'TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE'

test('Muse AI is registered as one ¥12 manually delivered item', async t => {
  const s = await customerFixture(); t.after(() => s.db.close())
  const row = s.db.prepare('SELECT * FROM catalog_plans WHERE id=?').get('muse-ai-once')!
  assert.equal(row.product_id, 'muse-ai')
  assert.equal(row.price_cents, 1200)
  assert.equal(row.enabled, 1)
  assert.deepEqual(PLANS.find(plan => plan.id === 'muse-ai-once'), {
    id: 'muse-ai-once', productId: 'muse-ai', name: '单个', price: 12, renewalOnly: false,
    subtitle: '一个 Muse AI，按需购买。', description: '单个商品 · 人工交付', features: ['按个购买', '人工处理', '订单进度可查'],
  })
  assert.equal(PRODUCTS.find(product => product.id === 'muse-ai')?.unit, '个')
  assert.equal(productNameForPlan('muse-ai-once'), 'Muse AI')
  assert.equal(productNameForId('muse-ai'), 'Muse AI')
  assert.ok(DEFAULT_PRODUCT_ORDER.includes('muse-ai'))
  assert.ok(normalizeProductOrder(['chatgpt']).indexOf('muse-ai') > 0)
})

test('Muse AI uses enabled USDT checkout, enforces server price and completes manually', async t => {
  const s = await customerFixture(); t.after(() => s.db.close())
  Object.assign(s.env, {
    ORDER_TESTING_ENABLED: 'false',
    PAYMENT_CHECKOUT_ENABLED: 'true',
    PAYMENT_NOTIFY_ORIGIN: 'https://shop.example.invalid',
    USDT_TRC20_ADDRESS: usdtAddress,
    USDT_CNY_PER_USDT: '7.20',
  })
  const catalog = await (await s.request('/api/catalog')).json()
  const offer = catalog.plans.find((plan: { id: string }) => plan.id === 'muse-ai-once')
  assert.deepEqual(catalog.paymentMethods, [{ method: 'usdt', name: 'USDT (TRC20)' }])
  assert.equal(offer.price_cents, 1200)
  assert.equal(offer.enabled, 1)

  const buyer = (await s.request('/api/orders/client', {})).headers.get('Set-Cookie')!.split(';')[0]
  const invalid = await s.request('/api/orders', { plan: 'muse-ai-once', expectedPrice: 1199, key: crypto.randomUUID(), email: 'muse@example.test' }, buyer)
  assert.equal(invalid.status, 409)
  const created = await s.request('/api/orders', { plan: 'muse-ai-once', expectedPrice: 1200, key: crypto.randomUUID(), email: 'muse@example.test' }, buyer)
  assert.equal(created.status, 201, await created.clone().text())
  const order = (await created.json()).order
  assert.equal(order.price, 12)
  assert.equal(order.mode, 'live')
  assert.equal(order.manualFulfillment, true)
  assert.equal(order.fulfillment, undefined)
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM recharge_orders WHERE order_id=?').get(order.id)!.n, 0)

  const paymentResponse = await s.request(`/api/orders/${order.id}/payment`, { action: 'create', method: 'usdt', expectedFeeBps: 0 }, buyer)
  assert.equal(paymentResponse.status, 200, await paymentResponse.clone().text())
  const payment = await findPayment(s.env, order.id)
  assert.ok(payment)
  await applyPaymentResult(s.env, payment!, { orderId: order.id, amountCents: 1200, status: 'paid', tradeNo: 'a'.repeat(64) })
  const paid = (await (await s.request(`/api/orders/${order.id}`, undefined, buyer)).json()).order
  assert.equal(paid.paymentStatus, 'paid')
  assert.equal(paid.status, 'session')
  assert.equal(paid.manualFulfillment, true)

  const started = await s.request(`/api/admin/orders/${order.id}/actions`, { action: 'manual-start', version: paid.version, note: '开始交付 Muse AI' }, s.admin)
  assert.equal(started.status, 200, await started.clone().text())
  const processing = (await started.json()).order
  assert.equal(processing.status, 'processing')
  const completed = await s.request(`/api/admin/orders/${order.id}/actions`, { action: 'manual-complete', version: processing.version, note: 'Muse AI 已交付' }, s.admin)
  assert.equal(completed.status, 200, await completed.clone().text())
  assert.equal((await completed.json()).order.status, 'success')
})
