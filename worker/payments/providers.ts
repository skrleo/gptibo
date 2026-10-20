import { ApiError, body, json, type Env } from '../platform.ts'
import { alipay } from './alipay.ts'
import { usdt, usdtConfig } from './usdt.ts'
import type { PaymentProvider } from './types.ts'

export function alipayConfigured(env: Env) { return Boolean(env.ALIPAY_APP_ID && env.ALIPAY_SELLER_ID && env.ALIPAY_APP_PRIVATE_KEY && env.ALIPAY_PUBLIC_KEY) }
export function usdtConfigured(env: Env) { try { usdtConfig(env); return true } catch { return false } }
// Buyer-facing channel list: only configured providers are offered.
export function availablePaymentMethods(env: Env) {
  const methods: { method: string; name: string }[] = []
  if (alipayConfigured(env)) methods.push({ method: 'alipay', name: '支付宝' })
  if (usdtConfigured(env)) methods.push({ method: 'usdt', name: 'USDT (TRC20)' })
  return methods
}
// Admin checkout settings: which configured channels buyers may choose.
// ponytail: fee rates are rejected here on purpose — charging one changes the
// payment amount end to end (reconcile, refunds, payouts); accept feeBps only
// once that money path exists.
type Channel = { id: string; name: string; configured: boolean }
const channels = (env: Env): Channel[] => [
  { id: 'alipay', name: '支付宝', configured: alipayConfigured(env) },
  { id: 'usdt', name: 'USDT (TRC20)', configured: usdtConfigured(env) },
]
const parseProviders = (value: string): string[] => {
  try { const list: unknown = JSON.parse(value); return Array.isArray(list) ? list.filter((id): id is string => typeof id === 'string') : [] } catch { return [] }
}
// A missing or corrupted row means every configured channel is offered.
export async function enabledPaymentMethods(env: Env) {
  const row = await env.INTEREST_DB.prepare('SELECT providers FROM payment_settings WHERE id=1').first<{ providers: string }>()
  const enabled = row ? parseProviders(row.providers) : null
  const methods = availablePaymentMethods(env)
  return enabled ? methods.filter(m => enabled.includes(m.method)) : methods
}
export async function paymentSettingsRoute(request: Request, env: Env) {
  const all = channels(env)
  if (request.method === 'GET') {
    const row = await env.INTEREST_DB.prepare('SELECT providers,version FROM payment_settings WHERE id=1').first<{ providers: string; version: number }>()
    const enabled = row ? parseProviders(row.providers).filter(id => all.some(c => c.id === id)) : all.filter(c => c.configured).map(c => c.id)
    return json({ provider: env.PAYMENT_PROVIDER ?? '', enabledProviders: enabled, version: row?.version ?? 0, checkout: env.PAYMENT_CHECKOUT_ENABLED === 'true', channels: all })
  }
  if (request.method !== 'POST') throw new ApiError('仅支持读取或保存收款设置。', 405)
  const data = await body(request)
  const version = Number(data.version)
  const providers = Array.isArray(data.providers) ? [...new Set(data.providers)] : []
  if (!Number.isSafeInteger(version) || version < 0 || providers.length === 0 || !providers.every(id => all.some(c => c.id === id && c.configured))) throw new ApiError('收款渠道设置无效，请至少启用一个已配置的渠道。', 400)
  if (data.feeRatesBps !== undefined && !(typeof data.feeRatesBps === 'object' && data.feeRatesBps !== null && Object.values(data.feeRatesBps).every(v => Number(v) === 0))) throw new ApiError('手续费率暂未开放配置，请保持 0%。', 400)
  const saved = await env.INTEREST_DB.prepare(`INSERT INTO payment_settings(id,providers,version,updated_at) VALUES (1,?,1,?)
    ON CONFLICT(id) DO UPDATE SET providers=excluded.providers,version=payment_settings.version+1,updated_at=excluded.updated_at WHERE payment_settings.version=? RETURNING version`)
    .bind(JSON.stringify(providers), Date.now(), version).first<{ version: number }>()
  if (!saved) throw new ApiError('收款设置已被他人修改，请刷新后重试。', 409)
  return json({ ok: true, version: saved.version })
}
// Resolve using the payment's persisted provider, not today's checkout default.
export function paymentProvider(env: Env, id: string): PaymentProvider {
  if (id === 'alipay' && alipayConfigured(env)) return alipay({ ALIPAY_APP_ID: env.ALIPAY_APP_ID!, ALIPAY_SELLER_ID: env.ALIPAY_SELLER_ID!, ALIPAY_APP_PRIVATE_KEY: env.ALIPAY_APP_PRIVATE_KEY!, ALIPAY_PUBLIC_KEY: env.ALIPAY_PUBLIC_KEY!, ALIPAY_GATEWAY: env.ALIPAY_GATEWAY })
  if (id === 'usdt' && usdtConfigured(env)) return usdt(usdtConfig(env))
  throw new ApiError('该订单的支付渠道尚未配置，请联系支持。', 503)
}
