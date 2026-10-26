import { ApiError, body, json, type Env, type Statement } from './platform.ts'
import { DEFAULT_PRODUCT_ORDER } from '../shared/product-order.ts'
import { configured as rechargeConfigured, productMap } from './recharge/client.ts'
import { supplierProducts } from './recharge/service.ts'
import { mappings as deliveryMappings, products as deliveryProducts } from './delivery_supplier/client.ts'
import { configured as gmailSupplierConfigured, goodsDetail } from './account_supplier/client.ts'
import { feishu } from './payout-notifications.ts'

type Plan = { id: string; product_id: string; name: string; price_cents: number; enabled: number; renewal_only: number; partner_enabled: number | null; purchase_note: string; delivery_instructions: string; version: number; delivery_mode: 'auto' | 'manual' }
type ImportPlan = { id: string; productId: string; name?: string; priceCents?: number; enabled?: boolean; renewalOnly?: boolean; partnerEnabled?: boolean; purchaseNote?: string; deliveryInstructions?: string }

const PLAN_ID = /^[a-z0-9][a-z0-9-]{0,63}$/
const MAX_IMPORT_ROWS = 200

// Bulk import is an explicit admin action backed by per-row audit rows, so it
// intentionally skips the single-edit version check. Empty optional fields keep
// the stored value; clearing a note goes through the per-plan editor.
function optionalText(row: Record<string, unknown>, key: string, max: number) {
  const value = row[key]
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string') throw new ApiError('商品说明格式无效。')
  const text = value.trim()
  if (text.length > max) throw new ApiError(`商品说明最多 ${max} 字。`)
  return text
}

export async function plansImport(request: Request, env: Env) {
  const data = await body(request, 262144)
  const rows = data.plans
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > MAX_IMPORT_ROWS) throw new ApiError(`请提交 1–${MAX_IMPORT_ROWS} 行商品数据。`)
  const parsed: ImportPlan[] = rows.map(raw => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ApiError('商品数据格式无效。')
    const row = raw as Record<string, unknown>
    const id = row.id, productId = row.productId
    if (typeof id !== 'string' || !PLAN_ID.test(id)) throw new ApiError('商品编号无效，只能包含小写字母、数字和连字符。')
    if (productId !== undefined && (typeof productId !== 'string' || !(DEFAULT_PRODUCT_ORDER as readonly string[]).includes(productId))) throw new ApiError(`商品 ${id} 的产品类型无效。`)
    const plan: ImportPlan = { id, productId: productId as string }
    if (row.name !== undefined && row.name !== null && row.name !== '') {
      if (typeof row.name !== 'string' || !row.name.trim() || row.name.trim().length > 120) throw new ApiError(`商品 ${id} 的套餐名称无效。`)
      plan.name = row.name.trim()
    }
    if (row.priceCents !== undefined && row.priceCents !== null && row.priceCents !== '') {
      if (!Number.isSafeInteger(row.priceCents) || Number(row.priceCents) < 1 || Number(row.priceCents) > 10000000) throw new ApiError(`商品 ${id} 的售价无效。`)
      plan.priceCents = Number(row.priceCents)
    }
    for (const key of ['enabled', 'renewalOnly', 'partnerEnabled'] as const) {
      if (row[key] === undefined || row[key] === null) continue
      if (typeof row[key] !== 'boolean') throw new ApiError(`商品 ${id} 的销售设置无效。`)
      plan[key] = row[key]
    }
    plan.purchaseNote = optionalText(row, 'purchaseNote', 2000)
    plan.deliveryInstructions = optionalText(row, 'deliveryInstructions', 2000)
    return plan
  })
  const seen = new Set<string>()
  for (const plan of parsed) {
    if (seen.has(plan.id)) throw new ApiError(`商品编号 ${plan.id} 在表格中重复。`)
    seen.add(plan.id)
  }
  const existing = new Map((await env.INTEREST_DB.prepare('SELECT * FROM catalog_plans').all<Plan>()).results.map(plan => [plan.id, plan]))
  for (const plan of parsed) if (!existing.has(plan.id) && plan.productId === undefined) throw new ApiError(`新商品 ${plan.id} 缺少产品类型。`)
  const db = env.INTEREST_DB, now = Date.now()
  const statements: Statement[] = []
  let updated = 0, created = 0
  for (const plan of parsed) {
    const current = existing.get(plan.id)
    if (!current) {
      statements.push(
        db.prepare('INSERT INTO admin_audit(id,action,target_id,note,created_at) VALUES (?,?,?,?,?)').bind(crypto.randomUUID(), 'plan-update', plan.id, `${env.ADMIN_USERNAME}: 导入新增 ${plan.name ?? plan.id}，售价 ¥${((plan.priceCents ?? 0) / 100).toFixed(2)}`, now),
        db.prepare('INSERT INTO catalog_plans(id,product_id,name,price_cents,enabled,renewal_only,partner_enabled,purchase_note,delivery_instructions,version,updated_at) VALUES (?,?,?,?,?,?,?,?,?,0,?)')
          .bind(plan.id, plan.productId, plan.name ?? plan.id, plan.priceCents!, plan.enabled === false ? 0 : 1, plan.renewalOnly === true ? 1 : 0, plan.partnerEnabled === true ? 1 : 0, plan.purchaseNote ?? '', plan.deliveryInstructions ?? '', now),
      )
      created += 1
      continue
    }
    const name = plan.name ?? current.name
    const price = plan.priceCents ?? current.price_cents
    const enabled = plan.enabled !== undefined ? Number(plan.enabled) : current.enabled
    const renewalOnly = plan.renewalOnly !== undefined ? Number(plan.renewalOnly) : current.renewal_only
    const partnerEnabled = plan.partnerEnabled !== undefined ? Number(plan.partnerEnabled) : current.partner_enabled
    const purchaseNote = plan.purchaseNote ?? current.purchase_note
    const deliveryInstructions = plan.deliveryInstructions ?? current.delivery_instructions
    if (name === current.name && price === current.price_cents && enabled === current.enabled && renewalOnly === current.renewal_only && partnerEnabled === current.partner_enabled && purchaseNote === current.purchase_note && deliveryInstructions === current.delivery_instructions) continue
    const changes = [
      name !== current.name && `名称 ${current.name}→${name}`,
      price !== current.price_cents && `价格 ${current.price_cents}→${price}`,
      enabled !== current.enabled && `状态 ${current.enabled}→${enabled}`,
      renewalOnly !== current.renewal_only && `仅续费 ${current.renewal_only}→${renewalOnly}`,
      partnerEnabled !== current.partner_enabled && `代理销售 ${current.partner_enabled}→${partnerEnabled}`,
      purchaseNote !== current.purchase_note && '更新购买说明',
      deliveryInstructions !== current.delivery_instructions && '更新领取说明',
    ].filter(Boolean).join('；')
    statements.push(
      db.prepare('INSERT INTO admin_audit(id,action,target_id,note,created_at) VALUES (?,?,?,?,?)').bind(crypto.randomUUID(), 'plan-update', plan.id, `${env.ADMIN_USERNAME}: ${changes}`, now),
      db.prepare('UPDATE catalog_plans SET name=?,price_cents=?,enabled=?,renewal_only=?,partner_enabled=?,purchase_note=?,delivery_instructions=?,version=version+1,updated_at=? WHERE id=?')
        .bind(name, price, enabled, renewalOnly, partnerEnabled, purchaseNote, deliveryInstructions, now, plan.id),
    )
    updated += 1
  }
  if (statements.length) await db.batch(statements)
  return json({ updated, created })
}

export type StockRow = { plan: string; stock: number | null; available: boolean | null }
export type StockGroup = { source: 'recharge' | 'delivery_supplier' | 'account_supplier'; rows: StockRow[]; configured: boolean; error?: string }

const groupError = (error: unknown) => error instanceof ApiError ? error.message : '供应商暂时无法查询。'

// Live supplier counts only; digital goods keep no local inventory.
export async function stockSnapshot(env: Env): Promise<StockGroup[]> {
  const recharge = rechargeConfigured(env)
    ? await supplierProducts(env)
      .then(list => ({ source: 'recharge' as const, configured: true, rows: Object.entries(productMap(env)).map(([plan, code]) => ({ plan, stock: null, available: list.find(product => product.product_code === code)?.available ?? null })) }))
      .catch((error: unknown) => ({ source: 'recharge' as const, configured: true, rows: [], error: groupError(error) }))
    : { source: 'recharge' as const, configured: false, rows: [] as StockRow[] }
  const delivery = env.DELIVERY_SUPPLIER_API_KEY
    ? await deliveryProducts(env)
      .then(list => ({ source: 'delivery_supplier' as const, configured: true, rows: Object.entries(deliveryMappings).map(([plan, code]) => { const product = list.find(item => item.service_id === code.id); return { plan, stock: product && Number.isInteger(product.stock) ? product.stock : null, available: product?.availability_state ? product.availability_state === 'available' : null } }) }))
      .catch((error: unknown) => ({ source: 'delivery_supplier' as const, configured: true, rows: [], error: groupError(error) }))
    : { source: 'delivery_supplier' as const, configured: false, rows: [] as StockRow[] }
  const goodsId = Number(env.ACCOUNT_SUPPLIER_GOODS_ID)
  const gmail = gmailSupplierConfigured(env) && Number.isSafeInteger(goodsId) && goodsId > 0
    ? await goodsDetail(env, goodsId)
      .then(goods => ({ source: 'account_supplier' as const, configured: true, rows: [{ plan: 'gmail-account', stock: typeof goods.stockCount === 'number' ? goods.stockCount : null, available: goods.status === 1 ? null : false }] }))
      .catch((error: unknown) => ({ source: 'account_supplier' as const, configured: true, rows: [], error: groupError(error) }))
    : { source: 'account_supplier' as const, configured: false, rows: [] as StockRow[] }
  return [recharge, delivery, gmail]
}

export function alertThreshold(env: Env) {
  const value = Number(env.STOCK_ALERT_THRESHOLD ?? 5)
  return Number.isSafeInteger(value) && value >= 0 && value <= 100000 ? value : 5
}

function stockRecipient(env: Env) {
  const value = env.FEISHU_STOCK_RECIPIENT ?? env.FEISHU_PAYOUT_RECIPIENT ?? ''
  return /^(?:ou|oc)_[a-z0-9]+$/.test(value) ? value : ''
}

function stockAlertsConfigured(env: Env) {
  return Boolean(env.FEISHU_APP_ID && env.FEISHU_APP_SECRET && stockRecipient(env))
}

export function isLowStock(row: StockRow, threshold: number) {
  if (row.available === false) return true
  return row.stock !== null && row.stock <= threshold
}

async function sendStockAlert(env: Env, lines: string[]) {
  const auth = await feishu('/auth/v3/tenant_access_token/internal', { app_id: env.FEISHU_APP_ID, app_secret: env.FEISHU_APP_SECRET })
  if (typeof auth?.tenant_access_token !== 'string' || !auth.tenant_access_token) throw new Error('Feishu token unavailable')
  const recipient = stockRecipient(env)
  await feishu('/im/v1/messages?receive_id_type=' + (recipient.startsWith('oc_') ? 'chat_id' : 'open_id'), {
    receive_id: recipient,
    msg_type: 'text',
    content: JSON.stringify({ text: lines.join('\n') }),
    uuid: 'ymx-stock-' + crypto.randomUUID(),
  }, auth.tenant_access_token)
}

const CHECK_INTERVAL_MS = 30 * 60_000
const REALERT_MS = 6 * 3600_000

// Runs on the shared per-minute cron; the state row keeps both the supplier
// polling and repeat alerts throttled. Failures leave the state untouched so
// the next minute retries.
export async function checkStockAlerts(env: Env, now = Date.now()) {
  if (!stockAlertsConfigured(env)) return
  const db = env.INTEREST_DB
  const state = await db.prepare('SELECT low_plans,checked_at,alerted_at FROM stock_alert_state WHERE id=?').bind('state').first<{ low_plans: string; checked_at: number; alerted_at: number }>()
  if (state && now - state.checked_at < CHECK_INTERVAL_MS) return
  const groups = await stockSnapshot(env)
  const threshold = alertThreshold(env)
  const low = groups.filter(group => group.configured).flatMap(group => group.rows.filter(row => isLowStock(row, threshold)).map(row => row.plan)).sort()
  const key = low.join(',')
  if (key && (key !== (state?.low_plans ?? '') || now - (state?.alerted_at ?? 0) >= REALERT_MS)) {
    const names = new Map((await db.prepare('SELECT id,name FROM catalog_plans').all<{ id: string; name: string }>()).results.map(plan => [plan.id, plan.name]))
    const lines = ['【库存预警】', `以下商品供应库存已低于 ${threshold}：`]
    for (const group of groups) for (const row of group.rows) if (isLowStock(row, threshold)) lines.push(`- ${names.get(row.plan) ?? row.plan}（${row.plan}）：${row.available === false ? '供应商已关闭销售' : `剩余 ${row.stock}`}`)
    await sendStockAlert(env, lines)
    await db.prepare('INSERT INTO stock_alert_state(id,low_plans,checked_at,alerted_at) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET low_plans=excluded.low_plans,checked_at=excluded.checked_at,alerted_at=excluded.alerted_at').bind('state', key, now, now).run()
    return
  }
  await db.prepare('INSERT INTO stock_alert_state(id,low_plans,checked_at,alerted_at) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET low_plans=excluded.low_plans,checked_at=excluded.checked_at,alerted_at=excluded.alerted_at')
    .bind('state', key, now, state?.alerted_at ?? 0).run()
}
