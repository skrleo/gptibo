import { DEFAULT_PRODUCT_ORDER } from '../shared/product-order.ts'
import { defaultCatalogOrder, normalizedCatalogOrder, validCatalogOrder, type CatalogOrderSettings } from '../shared/catalog-order.ts'
import { ApiError, body, json, type Env } from './platform.ts'

type CatalogOrderRow = { product_ids: string; plan_ids: string; version: number }

function parsedIds(value: string | undefined): string[] {
  try {
    const parsed: unknown = JSON.parse(value ?? '[]')
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []
  } catch { return [] }
}

async function currentPlanIds(env: Env) {
  return (await env.INTEREST_DB.prepare('SELECT id FROM catalog_plans ORDER BY rowid').all<{ id: string }>()).results.map(row => row.id)
}

export async function catalogOrderSettings(env: Env, knownPlanIds?: readonly string[]): Promise<CatalogOrderSettings> {
  const known = knownPlanIds ? [...knownPlanIds] : await currentPlanIds(env)
  const row = await env.INTEREST_DB.prepare('SELECT product_ids,plan_ids,version FROM catalog_order WHERE id=1').first<CatalogOrderRow>()
  if (!row) return defaultCatalogOrder(known)
  return normalizedCatalogOrder(parsedIds(row.product_ids), parsedIds(row.plan_ids), known, row.version)
}

export function sortCatalogRows<T extends { id: string }>(rows: readonly T[], planIds: readonly string[]): T[] {
  const positions = new Map(planIds.map((id, index) => [id, index]))
  return [...rows].sort((a, b) => (positions.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (positions.get(b.id) ?? Number.MAX_SAFE_INTEGER))
}

export async function catalogOrderRoute(request: Request, env: Env) {
  const planIds = await currentPlanIds(env)
  if (request.method === 'GET') return json(await catalogOrderSettings(env, planIds))
  if (request.method !== 'POST') throw new ApiError('请通过商品与套餐排序表单保存。', 405)
  const data = await body(request)
  if (!validCatalogOrder(data.productIds, DEFAULT_PRODUCT_ORDER)) throw new ApiError('商品列表无效，请刷新后重新排序。')
  if (!validCatalogOrder(data.planIds, planIds)) throw new ApiError('套餐列表无效，请刷新后重新排序。')
  if (!Number.isSafeInteger(data.version) || Number(data.version) < 0) throw new ApiError('排序版本无效，请刷新重试。')
  const changeId = crypto.randomUUID(); const now = Date.now(); const db = env.INTEREST_DB
  await db.batch([
    db.prepare(`INSERT INTO catalog_order(id,product_ids,plan_ids,version,change_id,updated_at)
      SELECT 1,?,?,1,?,? WHERE COALESCE((SELECT version FROM catalog_order WHERE id=1),0)=?
      ON CONFLICT(id) DO UPDATE SET product_ids=excluded.product_ids,plan_ids=excluded.plan_ids,version=catalog_order.version+1,change_id=excluded.change_id,updated_at=excluded.updated_at
      WHERE catalog_order.version=?`)
      .bind(JSON.stringify(data.productIds), JSON.stringify(data.planIds), changeId, now, Number(data.version), Number(data.version)),
    db.prepare("INSERT INTO admin_audit(id,target_id,action,note,created_at) SELECT ?,'catalog','catalog-order',?,? FROM catalog_order WHERE id=1 AND change_id=?")
      .bind(changeId, `${env.ADMIN_USERNAME}: 调整商品与套餐展示顺序`, now, changeId),
  ])
  if (!await db.prepare('SELECT id FROM admin_audit WHERE id=?').bind(changeId).first()) throw new ApiError('商品或套餐排序已更新，请刷新后重试。', 409)
  return json(await catalogOrderSettings(env, planIds))
}
