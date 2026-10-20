import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { plansImport, checkStockAlerts } from '../worker/plans.ts'
import { ApiError, type Env, type Statement, type Value } from '../worker/platform.ts'

function setup(extraEnv: Partial<Env> = {}) {
  const db = new DatabaseSync(':memory:')
  for (const file of ['0001_launch_interest.sql', '0002_commerce.sql', '0003_admin_totp.sql', '0004_partners.sql', '0013_partner_default_prices.sql', '0030_email_membership_catalog.sql', '0034_xgift_checkout.sql', '0045_stock_alert_state.sql'])
    db.exec(readFileSync(new URL('../migrations/' + file, import.meta.url), 'utf8'))
  db.prepare("INSERT OR IGNORE INTO catalog_plans(id,product_id,name,price_cents,enabled,renewal_only,updated_at) VALUES ('gmail-account','gmail','Gmail 邮箱账号',3900,1,0,1)").run()
  const database = {
    prepare(sql: string): Statement {
      let values: Value[] = []
      const statement: Statement = {
        bind(...next) { values = next; return statement },
        async first<T>() { return (db.prepare(sql).get(...values) ?? null) as T | null },
        async all<T>() { return { results: db.prepare(sql).all(...values) as T[] } },
        async run() { return db.prepare(sql).run(...values) },
      }
      return statement
    },
    async batch(statements: Statement[]) { for (const statement of statements) await statement.run(); return [] },
  }
  const env = { INTEREST_DB: database, ADMIN_USERNAME: 'ops', FEISHU_APP_ID: 'cli_test', FEISHU_APP_SECRET: 'secret', FEISHU_STOCK_RECIPIENT: 'ou_stock1', ...extraEnv } as Env
  return { db, env }
}

function importRequest(plans: unknown) {
  return new Request('https://shop.example.invalid/api/admin/plans/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://shop.example.invalid' },
    body: JSON.stringify({ plans }),
  })
}

test('import updates existing plans, keeps blank fields and writes audit rows', async t => {
  const { db, env } = setup(); t.after(() => db.close())
  const response = await plansImport(importRequest([
    { id: 'plus', priceCents: 15000, enabled: false },
    { id: 'gmail-10', productId: 'gmail', name: 'Gmail 10 个', priceCents: 9900, enabled: true, purchaseNote: '账号要求说明' },
  ]), env)
  assert.deepEqual(await response.json(), { updated: 1, created: 1 })
  const plus = db.prepare("SELECT name,price_cents,enabled,purchase_note,partner_enabled,version FROM catalog_plans WHERE id='plus'").get() as any
  assert.equal(plus.price_cents, 15000); assert.equal(plus.enabled, 0); assert.equal(plus.version, 1)
  assert.equal(plus.name, 'Plus'); assert.equal(plus.purchase_note, '')
  const created = db.prepare("SELECT product_id,name,price_cents,renewal_only,purchase_note FROM catalog_plans WHERE id='gmail-10'").get() as any
  assert.equal(created.product_id, 'gmail'); assert.equal(created.price_cents, 9900); assert.equal(created.purchase_note, '账号要求说明')
  const audit = db.prepare("SELECT COUNT(*) n FROM admin_audit WHERE action='plan-update'").get() as { n: number }
  assert.equal(audit.n, 2)
  assert.match(String(db.prepare("SELECT note FROM admin_audit WHERE target_id='plus'").get()!.note), /价格 13900→15000/)
})

test('import rejects unknown products, bad prices and duplicate ids without writing', async t => {
  const { db, env } = setup(); t.after(() => db.close())
  const before = db.prepare('SELECT COUNT(*) n FROM catalog_plans').get() as { n: number }
  for (const plans of [
    [{ id: 'new-1', productId: 'claude-pro', priceCents: 1000 }],
    [{ id: 'plus', priceCents: 0 }],
    [{ id: 'plus', priceCents: 13900 }, { id: 'plus', priceCents: 14000 }],
    [{ id: 'Bad_ID' }],
  ]) {
    await assert.rejects(() => plansImport(importRequest(plans), env), (error: unknown) => error instanceof ApiError && error.status === 400, JSON.stringify(plans))
  }
  assert.equal((db.prepare('SELECT COUNT(*) n FROM catalog_plans').get() as { n: number }).n, before.n)
})

// Stub every supplier host and Feishu; returns the captured Feishu message payloads.
function stubSuppliers(feishuSent: unknown[], upstream: { plusAvailable: boolean; gmailStock: number; deliveryStock: number }) {
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('open.feishu.cn')) {
      const body = JSON.parse(String(init?.body ?? '{}'))
      if (url.includes('/auth/')) return Response.json({ code: 0, tenant_access_token: 't-1' })
      feishuSent.push(body)
      return Response.json({ code: 0, data: { message_id: 'om_1' } })
    }
    if (url.includes('recharge.example.invalid')) return Response.json({ data: [{ product_code: 'plus-code', available: upstream.plusAvailable, currency: 'CNY', max_quantity: 1, delivery_modes: ['auto_recharge'], supply_price: '1.00', max_sale_price: '1000.00' }] })
    if (url.includes('delivery.example.invalid')) return Response.json({ services: [{ service_id: 'DEMO_PRODUCT_A', name: 'Gemini', price: 1, stock: upstream.deliveryStock }] })
    if (url.includes('gmail-supplier.example.invalid')) return Response.json({ code: 1000, data: { goodsId: 77, name: 'Gmail 谷歌邮箱账号', salesPrice: 10, goodsType: 1, status: 1, skuType: 0, stockCount: upstream.gmailStock } })
    throw new Error('unexpected fetch ' + url)
  }) as typeof fetch
  return () => { globalThis.fetch = original }
}

const supplierEnv = {
  RECHARGE_API_BASE: 'https://recharge.example.invalid/v1', RECHARGE_PARTNER_ID: 'p1', RECHARGE_KEY_ID: 'k1', RECHARGE_CLIENT_SECRET: 's', RECHARGE_PRODUCT_MAP: '{"plus":"plus-code"}',
  DELIVERY_SUPPLIER_API_KEY: 'key',
  ACCOUNT_SUPPLIER_API_BASE: 'https://gmail-supplier.example.invalid/', ACCOUNT_SUPPLIER_APP_ID: '123', ACCOUNT_SUPPLIER_APP_SECRET: 'sec', ACCOUNT_SUPPLIER_GOODS_ID: '77',
}

test('stock alerts fire once for a new low set, then throttle', async t => {
  const { db, env } = setup(supplierEnv); t.after(() => db.close())
  const sent: unknown[] = []
  const restore = stubSuppliers(sent, { plusAvailable: false, gmailStock: 2, deliveryStock: 0 }); t.after(restore)
  await checkStockAlerts(env)
  assert.equal(sent.length, 1)
  const text = JSON.parse((sent[0] as { content: string }).content).text as string
  assert.match(text, /【库存预警】/)
  assert.match(text, /Plus（plus）：供应商已关闭销售/)
  assert.match(text, /Gmail 邮箱账号（gmail-account）：剩余 2/)
  assert.match(text, /（gemini-pro-18m）：剩余 0/)
  const state = db.prepare("SELECT low_plans FROM stock_alert_state WHERE id='state'").get() as { low_plans: string }
  assert.equal(state.low_plans, 'gemini-pro-18m,gmail-account,plus')
  // Inside the check interval the cron does not poll suppliers or re-alert.
  await checkStockAlerts(env)
  assert.equal(sent.length, 1)
  // Recovery clears the low set without sending an all-clear message.
  db.prepare('UPDATE stock_alert_state SET checked_at=0').run()
  stubSuppliers(sent, { plusAvailable: true, gmailStock: 50, deliveryStock: 99 })
  await checkStockAlerts(env)
  assert.equal(sent.length, 1)
  assert.equal((db.prepare("SELECT low_plans FROM stock_alert_state WHERE id='state'").get() as { low_plans: string }).low_plans, '')
})

test('a changed low set alerts again and unconfigured suppliers are skipped', async t => {
  const { db, env } = setup({ ...supplierEnv, DELIVERY_SUPPLIER_API_KEY: undefined }); t.after(() => db.close())
  const sent: unknown[] = []
  const restore = stubSuppliers(sent, { plusAvailable: true, gmailStock: 1, deliveryStock: 0 }); t.after(restore)
  await checkStockAlerts(env)
  assert.equal(sent.length, 1)
  const text = JSON.parse((sent[0] as { content: string }).content).text as string
  assert.doesNotMatch(text, /gemini-pro-18m/)
  assert.match(text, /gmail-account/)
  // Same low set within the re-alert window stays quiet.
  db.prepare('UPDATE stock_alert_state SET checked_at=0, alerted_at=?').run(Date.now())
  await checkStockAlerts(env)
  assert.equal(sent.length, 1)
})
