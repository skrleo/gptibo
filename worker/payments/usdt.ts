// TronGrid polling adapter for USDT (TRC20). The buyer transfers an exact
// two-decimal amount to the merchant's own TRON address; a payment counts as
// confirmed only as a finalized on-chain transfer of exactly that amount, so
// no signature, webhook or third-party processor is involved. Same-price
// orders therefore share one expected amount; sync() excludes transfers
// already claimed by another payment via excludeTradeNos.
import { boundedResponseText } from '../bounded-response.ts'
import { ApiError, type Env } from '../platform.ts'
import type { PaymentOrder, PaymentProvider, PaymentResult } from './types.ts'

export const USDT_MAINNET_CONTRACT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
// Buyer polling hits query() directly; keep upstream TronGrid calls at most
// one per 10s per payment regardless of poll cadence.
export const USDT_QUERY_COOLDOWN_MS = 10000
// A transfer may confirm slightly before its payment row is created.
const USDT_MATCH_LOOKBACK_MS = 5 * 60000
const TRON_BASE58 = /^T[1-9A-HJ-NP-Za-km-z]{33}$/

export function usdtRate(env: Env) {
  const value = Number(env.USDT_CNY_PER_USDT)
  if (!Number.isFinite(value) || value <= 0 || value > 100) throw new ApiError('USDT 记账汇率未配置。', 503)
  return value
}
export function usdtConfig(env: Env) {
  const address = env.USDT_TRC20_ADDRESS?.trim() ?? ''
  if (!TRON_BASE58.test(address)) throw new ApiError('USDT 收款地址未配置。', 503)
  return { address, rate: usdtRate(env), contract: env.USDT_TRC20_CONTRACT?.trim() || USDT_MAINNET_CONTRACT, base: env.USDT_TRONGRID_BASE?.trim().replace(/\/$/, '') || 'https://api.trongrid.io', apiKey: env.USDT_TRONGRID_API_KEY?.trim() || '' }
}
// A CNY cent converts to 10_000/rate micro-USDT (cents/100/rate × 10⁶);
// ceil to the 0.01 USDT (10_000 micro) display grain so the shown amount is
// exactly the expected amount and the CNY price stays a floor.
export function expectedMicros(amountCents: number, rate: number) {
  if (!Number.isSafeInteger(amountCents) || amountCents < 1 || !Number.isFinite(rate) || rate <= 0) throw new Error('Invalid USDT expectation input')
  return Math.ceil(amountCents * 10_000 / rate / 10_000) * 10_000
}
export function formatUsdt(raw: number) {
  if (!Number.isSafeInteger(raw) || raw <= 0) throw new Error('Invalid USDT amount')
  return (raw / 1_000_000).toFixed(2)
}
type TronTransfer = { transaction_id?: string; to?: string; value?: string; type?: string; token_info?: { address?: string } }
type TronPage = { data?: TronTransfer[]; meta?: { links?: { next?: string } } }
export function usdt(config: ReturnType<typeof usdtConfig>): PaymentProvider {
  const transfers = async (order: PaymentOrder, expectedRaw: number) => {
    const exclude = new Set(order.excludeTradeNos ?? [])
    const since = (order.createdAt ?? Date.now()) - USDT_MATCH_LOOKBACK_MS
    let url = `${config.base}/v1/accounts/${config.address}/transactions/trc20?only_to=true&only_confirmed=true&limit=200&contract_address=${encodeURIComponent(config.contract)}&min_timestamp=${since}`
    for (let page = 0; page < 3; page++) {
      const response = await fetch(url, { headers: config.apiKey ? { 'TRON-PRO-API-KEY': config.apiKey } : undefined, signal: AbortSignal.timeout(8000) })
      if (!response.ok) throw new Error('TronGrid unavailable')
      const body = JSON.parse(await boundedResponseText(response, 65536)) as TronPage
      for (const row of body.data ?? []) {
        if (row.to !== config.address || row.token_info?.address !== config.contract || row.type !== 'Transfer') continue
        // String compare keeps the 6-decimal match exact; a 64-hex id is the
        // only trade number we are willing to stand behind. Amounts repeat
        // across same-price orders, so never re-claim a used transfer.
        if (row.value !== String(expectedRaw) || !/^[a-f0-9]{64}$/.test(row.transaction_id ?? '') || exclude.has(row.transaction_id!)) continue
        return row.transaction_id!
      }
      const next = body.meta?.links?.next
      if (!next || !next.startsWith(config.base + '/')) break
      url = next
    }
    return null
  }
  return {
    id: 'usdt', account: config.address,
    async create(order) {
      if (order.expiresAt <= Date.now()) throw new Error('Payment expired')
      if (!order.expectedRaw || order.expectedRaw <= 0) throw new Error('USDT expectation missing')
      // The QR is the bare receiving address; the exact amount is display-only state.
      return { qr: config.address }
    },
    async query(order): Promise<PaymentResult> {
      if (!order.expectedRaw || order.expectedRaw <= 0) throw new Error('USDT expectation missing')
      const txid = await transfers(order, order.expectedRaw)
      // applyPaymentResult matches the payment's own CNY cents, so a paid
      // result always reports the order amount, never the raw USDT value.
      return txid ? { orderId: order.id, amountCents: order.amountCents, status: 'paid', tradeNo: txid } : { orderId: order.id, amountCents: order.amountCents, status: 'not_found' }
    },
    // An explicit pre-expiry close retires immediately; past expiry a transfer
    // may still be in flight, so leave retirement to the +120s grace rule.
    async close(order) { return order.expiresAt > Date.now() },
    async refund() { throw new Error('USDT refunds are handled manually') },
    async queryRefund() { throw new Error('USDT refunds are handled manually') },
    async notification() { throw new Error('USDT has no gateway notification') },
    acknowledge(accepted) { return new Response(accepted ? 'success' : 'failure', { status: accepted ? 200 : 400, headers: { 'Cache-Control': 'no-store' } }) },
  }
}
