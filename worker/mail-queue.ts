import { MAIL_QUEUE_PLAN_SQL, isMailQueuePlan } from '../shared/mail-queue-products.ts'
import { ApiError, body, json, type Env } from './platform.ts'
import { getOrder, type Order } from './order-state.ts'
import { boundedResponseText } from './bounded-response.ts'
import { adminLoginEmail } from './admin-auth.ts'

export type MailSender = { id: number; label: string; from_email: string; from_name: string; api_key: string; enabled: number; sort_order: number; sent_count: number; created_at: number; updated_at: number; version: number }
export type MailQueueSettingsRow = { id: number; subject: string; body: string; duration_minutes: number; version: number; updated_at: number }
export type MailQueueTask = { id: string; order_id: string; status: 'queued' | 'sending' | 'done' | 'failed' | 'cancelled'; total_steps: number; done_steps: number; failed_steps: number; start_at: number; next_run_at: number; step_spacing_ms: number; lease_token: string | null; lease_until: number; attempts: number; last_error: string | null; created_at: number; updated_at: number; version: number }
export type MailQueueStep = { task_id: string; step_index: number; sender_id: number; recipient: string; subject: string; body: string; status: 'pending' | 'sending' | 'sent' | 'failed'; attempts: number; request_key: string; provider_id: string | null; sent_at: number | null; updated_at: number }

export type MailQueueSummary = { status: MailQueueTask['status']; total: number; done: number; failed: number; nextRunAt: number | null; durationMinutes: number; startedAt: number | null; finishedAt: number | null }

const findTask = (env: Env, id: string) => env.INTEREST_DB.prepare('SELECT * FROM mail_queue_tasks WHERE id=?').bind(id).first<MailQueueTask>()
const mailQueueSettings = (env: Env) => env.INTEREST_DB.prepare('SELECT * FROM mail_queue_settings WHERE id=1').first<MailQueueSettingsRow>()
const taskEligibility = "mode='live' AND is_test=0 AND payment_status='paid' AND refund_hold=0 AND refunded_cents=0 AND redemption_blocked=0 AND status IN ('session','processing')"

/** Checkout gate: flag + mail service + at least one enabled sender keep paid orders deliverable. */
export async function mailQueueCheckoutEnabled(env: Env) {
  if (env.MAIL_QUEUE_ENABLED !== 'true' || !env.RESEND_API_KEY || !env.RESEND_FROM) return false
  return Boolean(await env.INTEREST_DB.prepare('SELECT id FROM mail_senders WHERE enabled=1 LIMIT 1').first())
}

function renderTemplate(template: string, order: Order, senderLabel: string, index: number, total: number) {
  return template.replaceAll('{order}', order.id).replaceAll('{email}', order.customer_email ?? '').replaceAll('{sender}', senderLabel).replaceAll('{index}', String(index)).replaceAll('{total}', String(total))
}

/** Create the queue task for a paid order; safe to call repeatedly (payment hook and cron both do). */
export async function enqueueMailQueueTask(env: Env, orderId: string) {
  const order = await getOrder(env, orderId)
  if (!isMailQueuePlan(order.plan) || !order.customer_email) return
  if (await env.INTEREST_DB.prepare('SELECT id FROM mail_queue_tasks WHERE order_id=?').bind(orderId).first()) return
  const settings = await mailQueueSettings(env)
  const senders = (await env.INTEREST_DB.prepare('SELECT * FROM mail_senders WHERE enabled=1 ORDER BY sort_order,id').all<MailSender>()).results
  if (!settings || senders.length === 0) return
  const now = Date.now(), taskId = crypto.randomUUID(), event = crypto.randomUUID()
  const total = senders.length
  const spacing = Math.max(1000, Math.floor(Math.max(1, settings.duration_minutes) * 60_000 / total))
  // last_event_id chains task, steps and audit onto one atomic order transition;
  // the version bump keeps the audit event on its own (order_id, order_version) slot.
  await env.INTEREST_DB.batch([
    env.INTEREST_DB.prepare(`UPDATE orders SET last_event_id=?,updated_at=?,version=version+1 WHERE id=? AND version=? AND ${taskEligibility} AND NOT EXISTS(SELECT 1 FROM mail_queue_tasks WHERE order_id=orders.id)`).bind(event, now, orderId, order.version),
    env.INTEREST_DB.prepare("INSERT INTO mail_queue_tasks(id,order_id,status,total_steps,done_steps,failed_steps,start_at,next_run_at,step_spacing_ms,created_at,updated_at) SELECT ?,id,'queued',?,0,0,?,?,?,?,? FROM orders WHERE id=? AND last_event_id=?").bind(taskId, total, now, now + spacing, spacing, now, now, orderId, event),
    ...senders.map((sender, index) => env.INTEREST_DB.prepare("INSERT INTO mail_queue_steps(task_id,step_index,sender_id,recipient,subject,body,status,request_key,updated_at) SELECT ?,?,?,?,?,?,'pending',?,? FROM orders WHERE id=? AND last_event_id=?")
      .bind(taskId, index, sender.id, order.customer_email, renderTemplate(settings.subject, order, sender.label, index + 1, total), renderTemplate(settings.body, order, sender.label, index + 1, total), crypto.randomUUID(), now, orderId, event)),
    env.INTEREST_DB.prepare("INSERT INTO order_events(id,order_id,actor,action,from_status,to_status,note,order_version,created_at) SELECT ?,id,'system','mail-queue-created',status,status,?,version,? FROM orders WHERE id=? AND last_event_id=?")
      .bind(event, `邮件队列任务已创建：${total} 个发件邮箱，预计 ${settings.duration_minutes} 分钟内陆续发送`, now, orderId, event),
  ])
  if (!await env.INTEREST_DB.prepare('SELECT id FROM order_events WHERE id=?').bind(event).first()) throw new ApiError('订单状态已变化，队列任务未创建，请刷新。', 409)
}

async function sendQueueMail(env: Env, sender: Pick<MailSender, 'from_email' | 'from_name' | 'api_key'>, recipient: string, subject: string, text: string, requestKey: string) {
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST', redirect: 'manual',
    headers: { Authorization: 'Bearer ' + (sender.api_key || env.RESEND_API_KEY), 'Content-Type': 'application/json', 'Idempotency-Key': 'mail-queue/' + requestKey },
    body: JSON.stringify({ from: sender.from_name ? `${sender.from_name} <${sender.from_email}>` : sender.from_email, to: [recipient], subject, text }),
    signal: AbortSignal.timeout(10000),
  })
  if (!response.ok) throw new Error('Mail queue delivery failed')
  const result = JSON.parse(await boundedResponseText(response, 16384)) as { id?: unknown }
  if (typeof result.id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(result.id)) throw new Error('Mail queue response invalid')
  return result.id
}

async function cancelTask(env: Env, task: MailQueueTask, order: Order, note: string) {
  const now = Date.now(), event = crypto.randomUUID()
  await env.INTEREST_DB.batch([
    env.INTEREST_DB.prepare("UPDATE mail_queue_tasks SET status='cancelled',lease_until=0,lease_token=NULL,updated_at=?,version=version+1 WHERE id=? AND status IN ('queued','sending')").bind(now, task.id),
    env.INTEREST_DB.prepare("UPDATE orders SET updated_at=?,version=version+1,last_event_id=? WHERE id=?").bind(now, event, order.id),
    env.INTEREST_DB.prepare("INSERT INTO order_events(id,order_id,actor,action,from_status,to_status,note,order_version,created_at) SELECT ?,id,'system','mail-queue-cancelled',status,status,?,version,? FROM orders WHERE id=? AND last_event_id=?").bind(event, note, now, order.id, event),
  ])
}

/** Cron entry: recover missed enqueues, retire refunded orders, then send due steps of active tasks. */
export async function runMailQueue(env: Env) {
  if (!env.RESEND_API_KEY || !env.RESEND_FROM) return
  const now = Date.now()
  // Payment confirmations enqueue inline; this sweep recovers anything the hook missed.
  const missing = (await env.INTEREST_DB.prepare(`SELECT o.id FROM orders o WHERE o.plan IN (${MAIL_QUEUE_PLAN_SQL}) AND NOT EXISTS(SELECT 1 FROM mail_queue_tasks t WHERE t.order_id=o.id) AND o.mode='live' AND o.is_test=0 AND o.payment_status='paid' AND o.refund_hold=0 AND o.refunded_cents=0 AND o.redemption_blocked=0 AND o.status IN ('session','processing') LIMIT 10`).all<{ id: string }>()).results
  for (const row of missing) await enqueueMailQueueTask(env, row.id)
  // Refunded or blocked orders never send again; the task keeps its progress for the audit trail.
  const retired = (await env.INTEREST_DB.prepare(`SELECT t.id FROM mail_queue_tasks t JOIN orders o ON o.id=t.order_id WHERE t.status IN ('queued','sending') AND (o.payment_status<>'paid' OR o.refund_hold=1 OR o.refunded_cents>0 OR o.redemption_blocked=1)`).all<{ id: string }>()).results
  for (const row of retired) {
    const task = await findTask(env, row.id)
    if (task) await cancelTask(env, task, await getOrder(env, task.order_id), '订单已退款或暂停兑换，邮件队列已取消')
  }
  const due = (await env.INTEREST_DB.prepare("SELECT id FROM mail_queue_tasks WHERE status IN ('queued','sending') AND next_run_at<=? AND lease_until<=? ORDER BY next_run_at LIMIT 5").bind(now, now).all<{ id: string }>()).results
  for (const row of due) await processTask(env, row.id)
}

const STEP_CAP = 15
const STEP_MAX_ATTEMPTS = 3

async function processTask(env: Env, taskId: string) {
  const now = Date.now(), lease = crypto.randomUUID()
  await env.INTEREST_DB.prepare("UPDATE mail_queue_tasks SET lease_token=?,lease_until=?,updated_at=? WHERE id=? AND status IN ('queued','sending') AND lease_until<=?").bind(lease, now + 90_000, now, taskId, now).run()
  const task = await findTask(env, taskId)
  if (!task || task.lease_token !== lease) return
  const order = await getOrder(env, task.order_id)
  if (order.mode !== 'live' || order.is_test || order.payment_status !== 'paid' || order.refund_hold || order.refunded_cents || order.redemption_blocked || !['session', 'processing'].includes(order.status)) {
    await cancelTask(env, task, order, '订单已退款或暂停兑换，邮件队列已取消')
    return
  }
  const steps = (await env.INTEREST_DB.prepare('SELECT * FROM mail_queue_steps WHERE task_id=? ORDER BY step_index').bind(taskId).all<MailQueueStep>()).results
  const senders = new Map((await env.INTEREST_DB.prepare('SELECT * FROM mail_senders').all<MailSender>()).results.map(s => [s.id, s]))
  // Step i fires at start_at + (i+1)*spacing so the last email lands at the configured duration.
  const dueIndex = Math.floor((now - task.start_at) / task.step_spacing_ms) - 1
  const statuses = new Map(steps.map(step => [step.step_index, step.status]))
  const stepWrites: ReturnType<Env['INTEREST_DB']['prepare']>[] = []
  let done = task.done_steps, failed = task.failed_steps, anyFailure = false, sentThisRun = 0
  for (const step of steps) {
    if (statuses.get(step.step_index) !== 'pending' || step.step_index > dueIndex || sentThisRun >= STEP_CAP) continue
    const sender = senders.get(step.sender_id)
    try {
      if (!sender) throw new Error('Mail sender removed')
      const providerId = await sendQueueMail(env, sender, step.recipient, step.subject, step.body, step.request_key)
      stepWrites.push(env.INTEREST_DB.prepare("UPDATE mail_queue_steps SET status='sent',provider_id=?,sent_at=?,updated_at=? WHERE task_id=? AND step_index=?").bind(providerId, now, now, taskId, step.step_index))
      stepWrites.push(env.INTEREST_DB.prepare('UPDATE mail_senders SET sent_count=sent_count+1 WHERE id=?').bind(sender.id))
      statuses.set(step.step_index, 'sent')
      done++; sentThisRun++
    } catch {
      anyFailure = true
      const attempts = step.attempts + 1
      const dead = attempts >= STEP_MAX_ATTEMPTS
      stepWrites.push(env.INTEREST_DB.prepare(`UPDATE mail_queue_steps SET status=?,attempts=?,updated_at=? WHERE task_id=? AND step_index=?`).bind(dead ? 'failed' : 'pending', attempts, now, taskId, step.step_index))
      statuses.set(step.step_index, dead ? 'failed' : 'pending')
      if (dead) failed++
    }
  }
  const nextPending = steps.filter(step => statuses.get(step.step_index) === 'pending').map(step => step.step_index).sort((a, b) => a - b)[0]
  const finished = nextPending === undefined
  // An untouched task (nothing due yet) only rewrites the schedule; the batch below always releases the lease.
  const taskStatus: MailQueueTask['status'] = finished ? done > 0 ? 'done' : 'failed' : task.status === 'queued' && sentThisRun > 0 ? 'sending' : task.status
  const nextRunAt = finished ? now : Math.min(task.start_at + (nextPending + 1) * task.step_spacing_ms, now)
  const started = task.status === 'queued' && sentThisRun > 0
  const statements = [
    ...stepWrites,
    env.INTEREST_DB.prepare('UPDATE mail_queue_tasks SET status=?,done_steps=?,failed_steps=?,next_run_at=?,attempts=attempts+?,lease_until=0,lease_token=NULL,last_error=?,updated_at=?,version=version+1 WHERE id=? AND lease_token=?')
      .bind(taskStatus, done, failed, nextRunAt, anyFailure ? 1 : 0, finished ? failed > 0 ? `${failed} 个发件邮箱发送失败` : null : task.last_error, now, taskId, lease),
  ]
  if (started) {
    const event = crypto.randomUUID()
    statements.push(
      env.INTEREST_DB.prepare(`UPDATE orders SET status='processing',started_at=COALESCE(started_at,?),updated_at=?,version=version+1,last_event_id=? WHERE id=? AND status='session' AND ${taskEligibility}`).bind(now, now, event, order.id),
      env.INTEREST_DB.prepare("INSERT INTO order_events(id,order_id,actor,action,from_status,to_status,note,order_version,created_at) SELECT ?,id,'system','mail-queue-sending',status,'processing','邮件队列开始发送',version,? FROM orders WHERE id=? AND last_event_id=?").bind(event, now, order.id, event),
    )
  }
  if (finished && done > 0) {
    const event = crypto.randomUUID()
    statements.push(
      env.INTEREST_DB.prepare(`UPDATE orders SET status='success',updated_at=?,version=version+1,last_event_id=? WHERE id=? AND status IN ('session','processing') AND ${taskEligibility}`).bind(now, event, order.id),
      env.INTEREST_DB.prepare("INSERT INTO order_events(id,order_id,actor,action,from_status,to_status,note,order_version,created_at) SELECT ?,id,'system','mail-queue-done',status,'success',?,version,? FROM orders WHERE id=? AND last_event_id=?")
        .bind(event, `邮件队列完成：${done}/${task.total_steps} 封邮件已送达`, now, order.id, event),
    )
  } else if (finished) {
    const event = crypto.randomUUID()
    statements.push(
      env.INTEREST_DB.prepare(`UPDATE orders SET updated_at=?,version=version+1,last_event_id=? WHERE id=? AND status IN ('session','processing') AND ${taskEligibility}`).bind(now, event, order.id),
      env.INTEREST_DB.prepare("INSERT INTO order_events(id,order_id,actor,action,from_status,to_status,note,order_version,created_at) SELECT ?,id,'system','mail-queue-failed',status,status,?,version,? FROM orders WHERE id=? AND last_event_id=?")
        .bind(event, '邮件队列发送失败：全部发件邮箱不可用', now, order.id, event),
    )
  }
  await env.INTEREST_DB.batch(statements)
}

export async function mailQueueSummary(env: Env, order: Order): Promise<MailQueueSummary | undefined> {
  if (!isMailQueuePlan(order.plan)) return undefined
  const task = await env.INTEREST_DB.prepare('SELECT * FROM mail_queue_tasks WHERE order_id=?').bind(order.id).first<MailQueueTask>()
  if (!task) return undefined
  return {
    status: task.status, total: task.total_steps, done: task.done_steps, failed: task.failed_steps,
    nextRunAt: ['queued', 'sending'].includes(task.status) ? task.next_run_at : null,
    durationMinutes: Math.max(1, Math.round(task.total_steps * task.step_spacing_ms / 60000)),
    startedAt: task.start_at, finishedAt: ['done', 'failed', 'cancelled'].includes(task.status) ? task.updated_at : null,
  }
}

const emailValid = (value: unknown) => typeof value === 'string' && value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
const cleanText = (value: unknown, max: number) => typeof value === 'string' && value.trim().length > 0 && value.trim().length <= max ? value.trim() : null
const audit = (env: Env, action: string, note: string) => env.INTEREST_DB.prepare('INSERT INTO admin_audit(id,action,target_id,note,created_at) VALUES (?,?,?,?,?)').bind(crypto.randomUUID(), action, 'mail-queue', `${env.ADMIN_USERNAME}: ${note}`, Date.now())

export async function mailQueueAdmin(request: Request, env: Env, url: URL) {
  const path = url.pathname, method = request.method
  if (path === '/api/admin/mail-queue' && method === 'GET') {
    const [senders, settings, tasks] = await env.INTEREST_DB.batch([
      env.INTEREST_DB.prepare('SELECT id,label,from_email,from_name,enabled,sort_order,sent_count,length(api_key) key_length,created_at,updated_at,version FROM mail_senders ORDER BY sort_order,id'),
      env.INTEREST_DB.prepare('SELECT subject,body,duration_minutes,version FROM mail_queue_settings WHERE id=1'),
      env.INTEREST_DB.prepare('SELECT t.id,t.order_id,t.status,t.total_steps,t.done_steps,t.failed_steps,t.next_run_at,t.created_at,t.updated_at,t.last_error,o.customer_email,o.plan,o.status order_status,o.payment_status,o.refund_hold,o.refunded_cents FROM mail_queue_tasks t JOIN orders o ON o.id=t.order_id ORDER BY t.updated_at DESC LIMIT 100'),
    ]) as { results: unknown[] }[]
    return json({ senders: senders.results, settings: settings.results[0] ?? null, tasks: tasks.results })
  }
  if (path === '/api/admin/mail-queue/senders' && method === 'POST') {
    const data = await body(request)
    if (data.action === 'create') {
      const label = cleanText(data.label, 60), fromName = typeof data.fromName === 'string' ? data.fromName.trim().slice(0, 60) : ''
      const apiKey = typeof data.apiKey === 'string' ? data.apiKey.trim() : ''
      if (!label || !emailValid(data.fromEmail)) throw new ApiError('请填写有效的名称和发件邮箱。')
      if (apiKey && (apiKey.length > 200 || /\s/.test(apiKey))) throw new ApiError('发件密钥格式无效。')
      if (!Number.isSafeInteger(data.sortOrder) || Number(data.sortOrder) < 0 || Number(data.sortOrder) > 100000) throw new ApiError('排序值无效。')
      const now = Date.now()
      await env.INTEREST_DB.batch([
        env.INTEREST_DB.prepare('INSERT INTO mail_senders(label,from_email,from_name,api_key,sort_order,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').bind(label, String(data.fromEmail).trim().toLowerCase(), fromName, apiKey, Number(data.sortOrder), now, now),
        audit(env, 'mail-sender-create', `新增发件邮箱 ${label} <${String(data.fromEmail).trim().toLowerCase()}>`),
      ])
      return json({ ok: true })
    }
    if (['update', 'toggle', 'delete', 'test'].includes(String(data.action)) && Number.isInteger(data.id)) {
      const sender = await env.INTEREST_DB.prepare('SELECT * FROM mail_senders WHERE id=?').bind(Number(data.id)).first<MailSender>()
      if (!sender) throw new ApiError('发件邮箱不存在。', 404)
      if (data.action === 'test') {
        if (!env.RESEND_API_KEY && !sender.api_key) throw new ApiError('尚未配置邮件服务密钥。', 503)
        await sendQueueMail(env, sender, adminLoginEmail(env), `邮件队列测试：${sender.label}`, `这是发件邮箱 ${sender.label} 的连通性测试邮件。`, crypto.randomUUID())
        await env.INTEREST_DB.batch([audit(env, 'mail-sender-test', `测试发件邮箱 ${sender.label} 发送至 ${adminLoginEmail(env)}`)])
        return json({ ok: true })
      }
      if (data.version !== sender.version) throw new ApiError('发件邮箱已更新，请刷新后重试。', 409)
      const now = Date.now()
      if (data.action === 'delete') {
        const used = await env.INTEREST_DB.prepare('SELECT 1 FROM mail_queue_steps WHERE sender_id=? LIMIT 1').bind(sender.id).first()
        if (used) throw new ApiError('该邮箱已用于历史队列任务，请改为停用。', 409)
        await env.INTEREST_DB.batch([
          env.INTEREST_DB.prepare('DELETE FROM mail_senders WHERE id=? AND version=?').bind(sender.id, sender.version),
          audit(env, 'mail-sender-delete', `删除发件邮箱 ${sender.label} <${sender.from_email}>`),
        ])
        return json({ ok: true })
      }
      if (data.action === 'toggle') {
        if (typeof data.enabled !== 'boolean') throw new ApiError('请选择有效的启用状态。')
        await env.INTEREST_DB.batch([
          env.INTEREST_DB.prepare('UPDATE mail_senders SET enabled=?,updated_at=?,version=version+1 WHERE id=? AND version=?').bind(Number(data.enabled), now, sender.id, sender.version),
          audit(env, 'mail-sender-toggle', `${data.enabled ? '启用' : '停用'}发件邮箱 ${sender.label}`),
        ])
        return json({ ok: true })
      }
      const label = cleanText(data.label, 60), fromName = typeof data.fromName === 'string' ? data.fromName.trim().slice(0, 60) : ''
      if (!label || !emailValid(data.fromEmail)) throw new ApiError('请填写有效的名称和发件邮箱。')
      if (data.apiKey !== undefined && (typeof data.apiKey !== 'string' || data.apiKey.length > 200 || /\s/.test(data.apiKey))) throw new ApiError('发件密钥格式无效。')
      await env.INTEREST_DB.batch([
        env.INTEREST_DB.prepare('UPDATE mail_senders SET label=?,from_email=?,from_name=?,api_key=COALESCE(?,api_key),sort_order=?,updated_at=?,version=version+1 WHERE id=? AND version=?')
          .bind(label, String(data.fromEmail).trim().toLowerCase(), fromName, data.apiKey === undefined ? null : data.apiKey.trim(), Number.isSafeInteger(data.sortOrder) && Number(data.sortOrder) >= 0 && Number(data.sortOrder) <= 100000 ? Number(data.sortOrder) : sender.sort_order, now, sender.id, sender.version),
        audit(env, 'mail-sender-update', `更新发件邮箱 ${label} <${String(data.fromEmail).trim().toLowerCase()}>`),
      ])
      return json({ ok: true })
    }
    throw new ApiError('发件邮箱操作无效。')
  }
  if (path === '/api/admin/mail-queue/settings' && method === 'POST') {
    const data = await body(request)
    const settings = await mailQueueSettings(env)
    if (!settings) throw new ApiError('队列配置缺失。', 503)
    if (data.version !== settings.version) throw new ApiError('配置已更新，请刷新后重试。', 409)
    const subject = cleanText(data.subject, 200), bodyText = cleanText(data.body, 2000)
    const duration = Number(data.durationMinutes)
    if (!subject || !bodyText) throw new ApiError('请填写邮件主题和正文（各占位符 {order} {email} {sender} {index} {total} 可用）。')
    if (!Number.isInteger(duration) || duration < 1 || duration > 60) throw new ApiError('服务时长需为 1–60 分钟。')
    await env.INTEREST_DB.batch([
      env.INTEREST_DB.prepare('UPDATE mail_queue_settings SET subject=?,body=?,duration_minutes=?,version=version+1,updated_at=? WHERE id=1 AND version=?').bind(subject, bodyText, duration, Date.now(), settings.version),
      audit(env, 'mail-queue-settings', `更新模板与服务时长 ${duration} 分钟`),
    ])
    return json({ ok: true })
  }
  const taskMatch = path.match(/^\/api\/admin\/mail-queue\/tasks\/([a-f0-9-]+)$/)
  if (taskMatch) {
    const task = await findTask(env, taskMatch[1])
    if (!task) throw new ApiError('队列任务不存在。', 404)
    if (method === 'GET') {
      const steps = (await env.INTEREST_DB.prepare('SELECT s.step_index,s.sender_id,s.recipient,s.status,s.attempts,s.provider_id,s.sent_at,s.updated_at,m.label,m.from_email FROM mail_queue_steps s LEFT JOIN mail_senders m ON m.id=s.sender_id WHERE s.task_id=? ORDER BY s.step_index').bind(task.id).all()).results
      return json({ task, steps, order: await getOrder(env, task.order_id) })
    }
    if (method === 'POST') {
      const data = await body(request)
      const order = await getOrder(env, task.order_id)
      if (data.action === 'cancel') {
        if (!['queued', 'sending'].includes(task.status)) throw new ApiError('该任务已结束，不能取消。', 409)
        const now = Date.now()
        await env.INTEREST_DB.batch([
          env.INTEREST_DB.prepare("UPDATE mail_queue_tasks SET status='cancelled',lease_until=0,lease_token=NULL,updated_at=?,version=version+1 WHERE id=? AND status IN ('queued','sending')").bind(now, task.id),
          audit(env, 'mail-queue-cancel', `取消队列任务 ${task.id.slice(0, 8)}（订单 ${task.order_id}）`),
        ])
        return json({ ok: true })
      }
      if (data.action === 'retry') {
        if (!['failed', 'cancelled', 'done'].includes(task.status)) throw new ApiError('进行中的任务不能重试。', 409)
        if (order.mode !== 'live' || order.payment_status !== 'paid' || order.refund_hold || order.refunded_cents || order.redemption_blocked) throw new ApiError('订单已退款或暂停兑换，不能重试。', 409)
        const now = Date.now(), spacing = Math.max(1000, Math.floor(60_000 / Math.max(1, task.total_steps)))
        // Failed steps restart immediately on a one-minute schedule; finished ones keep their receipts.
        await env.INTEREST_DB.batch([
          env.INTEREST_DB.prepare("UPDATE mail_queue_steps SET status='pending',attempts=0 WHERE task_id=? AND status='failed'").bind(task.id),
          env.INTEREST_DB.prepare("UPDATE mail_queue_tasks SET status=CASE WHEN EXISTS(SELECT 1 FROM mail_queue_steps WHERE task_id=? AND status='pending') THEN 'sending' ELSE status END,failed_steps=0,start_at=?,step_spacing_ms=?,next_run_at=?,last_error=NULL,updated_at=?,version=version+1 WHERE id=?").bind(task.id, now, spacing, now, now, task.id),
          audit(env, 'mail-queue-retry', `重试队列任务 ${task.id.slice(0, 8)}（订单 ${task.order_id}）`),
        ])
        return json({ ok: true })
      }
      throw new ApiError('队列任务操作无效。')
    }
  }
  throw new ApiError('未找到管理接口。', 404)
}
