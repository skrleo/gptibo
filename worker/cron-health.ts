import type { Env } from './platform.ts'
import { feishu, payoutNotificationsConfigured } from './payout-notifications.ts'

// Cron jobs fail into console.error today, so a stalled reconciliation is
// invisible until a customer complains. Wrap each job to count consecutive
// failures in D1 and page the shared Feishu bot once a stall is real:
// alert after ALERT_AFTER consecutive failures, re-alert every RERALERT_MS
// while it stays broken, and announce recovery when it comes back.

const ALERT_AFTER = 3
const RERALERT_MS = 6 * 60 * 60 * 1000

export async function withCronHealth(env: Env, task: string, job: () => Promise<unknown>) {
  try {
    await job()
    await reportOk(env, task)
  } catch (error) {
    console.error('cron job failed:', task, error)
    await reportFailure(env, task)
  }
}

async function reportFailure(env: Env, task: string) {
  const now = Date.now()
  await env.INTEREST_DB.prepare(`INSERT INTO cron_health(task,fail_streak,updated_at) VALUES (?,1,?)
    ON CONFLICT(task) DO UPDATE SET fail_streak=cron_health.fail_streak+1,updated_at=excluded.updated_at`).bind(task, now).run()
  const row = await env.INTEREST_DB.prepare('SELECT fail_streak,last_alert_at FROM cron_health WHERE task=?').bind(task).first<{ fail_streak: number; last_alert_at: number }>()
  if (!row || row.fail_streak < ALERT_AFTER || now - row.last_alert_at < RERALERT_MS) return
  // Claim the alert window before sending so overlapping cron runs cannot double-page.
  const claimed = await env.INTEREST_DB.prepare('UPDATE cron_health SET last_alert_at=? WHERE task=? AND last_alert_at=? RETURNING task').bind(now, task, row.last_alert_at).first()
  if (!claimed) return
  await alert(env, task, `定时任务 ${task} 已连续失败 ${row.fail_streak} 次，请检查 Workers 日志与依赖服务。`)
}

async function reportOk(env: Env, task: string) {
  const row = await env.INTEREST_DB.prepare('SELECT fail_streak FROM cron_health WHERE task=?').bind(task).first<{ fail_streak: number }>()
  if (!row || row.fail_streak === 0) return
  await env.INTEREST_DB.prepare('UPDATE cron_health SET fail_streak=0,updated_at=? WHERE task=?').bind(Date.now(), task).run()
  if (row.fail_streak >= ALERT_AFTER) await alert(env, task, `定时任务 ${task} 已恢复正常（此前连续失败 ${row.fail_streak} 次）。`)
}

async function alert(env: Env, task: string, text: string) {
  if (!payoutNotificationsConfigured(env)) return
  try {
    const auth = await feishu('/auth/v3/tenant_access_token/internal', { app_id: env.FEISHU_APP_ID, app_secret: env.FEISHU_APP_SECRET })
    if (typeof auth?.tenant_access_token !== 'string' || !auth.tenant_access_token) throw new Error('Feishu token unavailable')
    const recipient = env.FEISHU_PAYOUT_RECIPIENT ?? env.FEISHU_STOCK_RECIPIENT ?? ''
    await feishu('/im/v1/messages?receive_id_type=' + (recipient.startsWith('oc_') ? 'chat_id' : 'open_id'), {
      receive_id: recipient, msg_type: 'text', content: JSON.stringify({ text }),
      // Stable per task + alert window keeps Feishu-side retries idempotent.
      uuid: 'ymx-cron-' + task + '-' + Math.floor(Date.now() / RERALERT_MS),
    }, auth.tenant_access_token)
  } catch (error) {
    console.error('cron health alert failed:', task, error)
  }
}
