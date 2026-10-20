import { ApiError, body, json, type Env } from './platform.ts'
import { partnerOrderCompletedMessage, sendPartnerOrderCompletedEmail } from './email.ts'
import type { Partner } from './partner-auth.ts'

// Per-partner settings: the order-completed email toggle and the default
// Alipay payout payee. One version column guards both writes.

// One toggle per partner: when on, every completed live order emails the
// partner. Delivery is a scan-based queue so payment paths stay untouched —
// the cron enqueues newly completed orders and drains the queue with retries.

export type NotificationSettings = { orderCompletedEmail: boolean; recipient: string; version: number }
export type PayoutAccount = { phone: string; name: string; version: number }

type SettingsRow = { order_completed_email: number; payout_phone: string; payout_name: string; version: number }

async function settingsRow(env: Env, partnerId: string) {
  return await env.INTEREST_DB.prepare('SELECT order_completed_email,payout_phone,payout_name,version FROM partner_settings WHERE partner_id=?').bind(partnerId).first<SettingsRow>()
}

export async function notificationSettings(env: Env, partnerId: string, email: string): Promise<NotificationSettings> {
  const row = await settingsRow(env, partnerId)
  return { orderCompletedEmail: row?.order_completed_email === 1, recipient: email, version: row?.version ?? 0 }
}

export async function payoutAccount(env: Env, partnerId: string): Promise<PayoutAccount> {
  const row = await settingsRow(env, partnerId)
  return { phone: row?.payout_phone ?? '', name: row?.payout_name ?? '', version: row?.version ?? 0 }
}

export async function payoutAccountRoute(request: Request, env: Env, partner: Partner) {
  if (request.method !== 'POST') throw new ApiError('请通过收款信息表单保存。', 405)
  const data = await body(request)
  const version = Number(data.version)
  const phone = typeof data.phone === 'string' ? data.phone.trim() : ''
  const name = typeof data.name === 'string' ? data.name.trim() : ''
  if (!/^1[3-9][0-9]{9}$/.test(phone) || !name || name.length > 50) throw new ApiError('请填写正确的支付宝手机号和收款人姓名。')
  if (!Number.isSafeInteger(version) || version < 0) throw new ApiError('收款信息无效，请刷新重试。')
  const now = Date.now()
  await env.INTEREST_DB.prepare(`INSERT INTO partner_settings(partner_id,payout_phone,payout_name,version,updated_at) VALUES (?,?,?,1,?)
    ON CONFLICT(partner_id) DO UPDATE SET payout_phone=excluded.payout_phone,payout_name=excluded.payout_name,version=partner_settings.version+1,updated_at=excluded.updated_at
    WHERE partner_settings.version=?`)
    .bind(partner.id, phone, name, now, version).run()
  const saved = await payoutAccount(env, partner.id)
  if (saved.version !== version + 1 || saved.phone !== phone) throw new ApiError('收款信息已更新，请刷新后再保存。', 409)
  return json(saved)
}

export async function notificationSettingsRoute(request: Request, env: Env, partner: Partner) {
  if (request.method === 'GET') return json(await notificationSettings(env, partner.id, partner.email))
  if (request.method !== 'POST') throw new ApiError('请通过通知设置表单保存。', 405)
  const data = await body(request)
  const version = Number(data.version)
  if (typeof data.orderCompletedEmail !== 'boolean' || !Number.isSafeInteger(version) || version < 0) throw new ApiError('通知设置无效，请刷新重试。')
  const now = Date.now()
  await env.INTEREST_DB.prepare(`INSERT INTO partner_settings(partner_id,order_completed_email,version,updated_at) VALUES (?,?,1,?)
    ON CONFLICT(partner_id) DO UPDATE SET order_completed_email=excluded.order_completed_email,version=partner_settings.version+1,updated_at=excluded.updated_at
    WHERE partner_settings.version=?`)
    .bind(partner.id, Number(data.orderCompletedEmail), now, version).run()
  const saved = await notificationSettings(env, partner.id, partner.email)
  // The write applied only if both the version advanced by one and our value stuck;
  // a lost race otherwise silently echoes someone else's toggle as saved.
  if (saved.version !== version + 1 || saved.orderCompletedEmail !== data.orderCompletedEmail) throw new ApiError('通知设置已更新，请刷新后再保存。', 409)
  return json(saved)
}

const eligible = `o.status='success' AND o.mode='live' AND o.is_test=0 AND o.payment_status='paid' AND o.refunded_cents=0 AND o.partner_id IS NOT NULL`

async function enqueueCompleted(env: Env) {
  // Only orders completed after the toggle was switched on are notified.
  await env.INTEREST_DB.prepare(`INSERT INTO partner_order_emails(order_id,next_attempt_at)
    SELECT o.id,0 FROM orders o JOIN partner_settings s ON s.partner_id=o.partner_id
    WHERE ${eligible} AND s.order_completed_email=1 AND o.updated_at>=s.updated_at
      AND NOT EXISTS(SELECT 1 FROM partner_order_emails e WHERE e.order_id=o.id) LIMIT 50`).run()
}

// Bounded per run: claim rows atomically, re-check eligibility, send with
// exponential backoff; give up after 12 attempts instead of retrying forever.
export async function sendDuePartnerOrderEmails(env: Env, limit = 20) {
  if (!env.RESEND_API_KEY || !env.RESEND_FROM) return { configured: false, sent: 0, failed: 0 }
  await enqueueCompleted(env)
  const now = Date.now()
  const token = crypto.randomUUID()
  const claimed = (await env.INTEREST_DB.prepare(`UPDATE partner_order_emails SET lock_token=?,locked_until=?,attempt_count=attempt_count+1,first_attempt_at=COALESCE(first_attempt_at,?)
    WHERE order_id IN (SELECT order_id FROM partner_order_emails WHERE delivered_at IS NULL AND attempt_count<12 AND next_attempt_at<=? AND locked_until<=? ORDER BY next_attempt_at LIMIT ?)
    RETURNING order_id,attempt_count`).bind(token, now + 60000, now, now, now, limit).all<{ order_id: string; attempt_count: number }>()).results
  let sent = 0; let failed = 0
  for (const { order_id, attempt_count } of claimed) {
    try {
      // The JOIN on partners implies partner_id IS NOT NULL; the settings JOIN
      // re-checks the toggle so a notification turned off mid-queue is dropped.
      const row = await env.INTEREST_DB.prepare(`SELECT o.id,o.plan_name,o.price_cents,o.customer_email,o.updated_at,p.name shop_name,p.email recipient
        FROM orders o JOIN partners p ON p.id=o.partner_id JOIN partner_settings st ON st.partner_id=o.partner_id AND st.order_completed_email=1
        WHERE o.id=? AND o.status='success' AND o.mode='live' AND o.is_test=0 AND o.payment_status='paid' AND o.refunded_cents=0`).bind(order_id).first<{ id: string; plan_name: string; price_cents: number; customer_email: string | null; updated_at: number; shop_name: string; recipient: string }>()
      if (!row) { // Toggled off or refunded since enqueue; drop silently.
        await env.INTEREST_DB.prepare('UPDATE partner_order_emails SET delivered_at=?,locked_until=0 WHERE order_id=? AND lock_token=?').bind(now, order_id, token).run()
        continue
      }
      const message = partnerOrderCompletedMessage({
        shop: row.shop_name,
        amount: '¥' + (row.price_cents / 100).toFixed(2),
        product: row.plan_name,
        customer: row.customer_email ?? '',
        completed: new Date(row.updated_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }),
        orderId: row.id,
      })
      await sendPartnerOrderCompletedEmail(env, row.recipient, message, row.id)
      await env.INTEREST_DB.prepare('UPDATE partner_order_emails SET delivered_at=?,locked_until=0 WHERE order_id=? AND lock_token=?').bind(Date.now(), order_id, token).run()
      sent++
    } catch {
      const backoff = Math.min(60000 * 2 ** (attempt_count - 1), 30 * 60000)
      await env.INTEREST_DB.prepare('UPDATE partner_order_emails SET next_attempt_at=?,locked_until=0 WHERE order_id=? AND lock_token=?').bind(now + backoff, order_id, token).run()
      failed++
    }
  }
  return { configured: true, sent, failed }
}
