import { ApiError, type Env } from '../platform.ts'
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
// Resolve using the payment's persisted provider, not today's checkout default.
export function paymentProvider(env: Env, id: string): PaymentProvider {
  if (id === 'alipay' && alipayConfigured(env)) return alipay({ ALIPAY_APP_ID: env.ALIPAY_APP_ID!, ALIPAY_SELLER_ID: env.ALIPAY_SELLER_ID!, ALIPAY_APP_PRIVATE_KEY: env.ALIPAY_APP_PRIVATE_KEY!, ALIPAY_PUBLIC_KEY: env.ALIPAY_PUBLIC_KEY!, ALIPAY_GATEWAY: env.ALIPAY_GATEWAY })
  if (id === 'usdt' && usdtConfigured(env)) return usdt(usdtConfig(env))
  throw new ApiError('该订单的支付渠道尚未配置，请联系支持。', 503)
}
