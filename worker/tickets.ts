import { ApiError, body, json, type Env } from './platform.ts'
import { partnerLimit } from './partner-auth.ts'
import type { Partner } from './partner-auth.ts'

// Order tickets, shared by the partner workspace and the admin console. The
// frontend contract (ticket-workspace.tsx): create with an idempotency key,
// list {rows,total} at 20/page, detail with events, replies with key+version.

const statuses = ['open', 'processing', 'waiting', 'resolved']
const keyPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

function text(value: unknown, limit: number, label: string) {
  if (typeof value !== 'string' || !value.trim() || value.length > limit || Array.from(value).some(character => {
    const code = character.charCodeAt(0)
    return (code < 32 && ![9, 10, 13].includes(code)) || code === 127
  })) throw new ApiError(`${label}无效，请填写 1-${limit} 字的有效文本。`)
  return value.trim()
}

function pageOf(url: URL) {
  const page = Number(url.searchParams.get('page') ?? 1)
  if (!Number.isInteger(page) || page < 1 || page > 10000) throw new ApiError('页码无效。')
  return page
}

function statusOf(url: URL) {
  const status = url.searchParams.get('status') ?? ''
  if (status && !statuses.includes(status)) throw new ApiError('工单状态无效。')
  return status
}

// % and _ in the search box must not act as wildcards.
const like = (value: string) => `%${value.replaceAll('%', '\\%').replaceAll('_', '\\_')}%`
const likeSql = (url: URL, clauses: string[]) => {
  const q = url.searchParams.get('q') ?? ''
  if (!q.trim()) return { sql: '', binds: [] as (string | number)[] }
  return { sql: ' AND (' + clauses.map(clause => `${clause} LIKE ? ESCAPE '\\'`).join(' OR ') + ')', binds: clauses.map(() => like(q.trim().slice(0, 320))) }
}

type Row = { id: string; partner_id: string; order_id: string; subject: string; status: string; version: number; created_at: number; updated_at: number; partner_name: string; partner_email: string }

async function list(env: Env, url: URL, where: { sql: string; binds: (string | number)[]; search: string[] }) {
  const page = pageOf(url); const status = statusOf(url)
  const search = likeSql(url, where.search)
  const filter = `WHERE (?='' OR t.status=?)${search.sql}`
  const args = [status, status, ...search.binds, ...where.binds]
  const rows = (await env.INTEREST_DB.prepare(`SELECT t.*,p.name partner_name,p.email partner_email FROM tickets t JOIN partners p ON p.id=t.partner_id ${filter} AND ${where.sql} ORDER BY t.updated_at DESC,t.id DESC LIMIT 20 OFFSET ?`)
    .bind(...args, (page - 1) * 20).all<Row>()).results
  const count = await env.INTEREST_DB.prepare(`SELECT COUNT(*) total FROM tickets t JOIN partners p ON p.id=t.partner_id ${filter} AND ${where.sql}`).bind(...args).first<{ total: number }>()
  return json({ rows, total: count?.total ?? 0 })
}

async function detail(env: Env, id: string, ownership?: { partner_id: string }) {
  const row = await env.INTEREST_DB.prepare('SELECT t.*,p.name partner_name,p.email partner_email FROM tickets t JOIN partners p ON p.id=t.partner_id WHERE t.id=?').bind(id).first<Row>()
  if (!row || (ownership && row.partner_id !== ownership.partner_id)) throw new ApiError('工单不存在。', 404)
  const events = (await env.INTEREST_DB.prepare('SELECT id,actor_role,body,status,created_at FROM ticket_events WHERE ticket_id=? ORDER BY created_at,id').bind(id).all<{ id: string; actor_role: string; body: string; status: string; created_at: number }>()).results
  return { ...row, events }
}

async function reply(env: Env, ticketId: string, actor: 'admin' | 'partner', data: Record<string, unknown>, ownership?: { partner_id: string }) {
  if (typeof data.key !== 'string' || !keyPattern.test(data.key)) throw new ApiError('回复请求无效，请刷新重试。')
  const content = text(data.body, 5000, '回复内容')
  const status = actor === 'partner' ? 'open' : (() => {
    if (typeof data.status !== 'string' || !statuses.includes(data.status)) throw new ApiError('请选择有效的工单状态。')
    return data.status
  })()
  const version = Number(data.version)
  if (!Number.isSafeInteger(version) || version < 1) throw new ApiError('工单版本无效，请刷新重试。')
  // A replayed key is already saved; report success without duplicating.
  if (await env.INTEREST_DB.prepare('SELECT 1 FROM ticket_events WHERE ticket_id=? AND request_key=?').bind(ticketId, data.key).first()) return json({ ok: true })
  const now = Date.now()
  const updated = await env.INTEREST_DB.prepare(`UPDATE tickets SET status=?,version=version+1,updated_at=? WHERE id=? AND version=? AND (? IS NULL OR partner_id=?) RETURNING id`)
    .bind(status, now, ticketId, version, ownership?.partner_id ?? null, ownership?.partner_id ?? null).first<{ id: string }>()
  if (!updated) throw new ApiError('工单已更新，请刷新后重试。', 409)
  await env.INTEREST_DB.prepare('INSERT INTO ticket_events(id,ticket_id,actor_role,body,status,request_key,created_at) VALUES (?,?,?,?,?,?,?)')
    .bind(crypto.randomUUID(), ticketId, actor, content, status, data.key, now).run()
  return json({ ok: true })
}

export async function partnerTicketRoutes(request: Request, env: Env, url: URL, partner: Partner) {
  const path = url.pathname
  if (path === '/api/partner/tickets' && request.method === 'POST') {
    await partnerLimit(env, 'ticket-create:' + partner.id, 20, 86400000)
    const data = await body(request, 16384)
    if (typeof data.key !== 'string' || !keyPattern.test(data.key)) throw new ApiError('提交请求无效，请刷新重试。')
    const orderId = text(data.orderId, 128, '订单号')
    const subject = text(data.subject, 120, '问题标题')
    const content = text(data.body, 5000, '问题描述')
    if (!await env.INTEREST_DB.prepare('SELECT id FROM orders WHERE id=? AND partner_id=?').bind(orderId, partner.id).first()) throw new ApiError('未找到该订单，请确认使用本站订单号。', 404)
    const id = crypto.randomUUID(); const now = Date.now()
    await env.INTEREST_DB.prepare(`INSERT INTO tickets(id,partner_id,order_id,subject,status,version,idempotency_key,created_at,updated_at) VALUES (?,?,?,?,'open',1,?,?,?) ON CONFLICT(partner_id,idempotency_key) DO NOTHING`)
      .bind(id, partner.id, orderId, subject, data.key, now, now).run()
    const existing = await env.INTEREST_DB.prepare('SELECT id FROM tickets WHERE partner_id=? AND idempotency_key=?').bind(partner.id, data.key).first<{ id: string }>()
    if (existing?.id !== id) return json({ id: existing!.id }) // A replay: the first submission wins.
    await env.INTEREST_DB.prepare("INSERT INTO ticket_events(id,ticket_id,actor_role,body,status,request_key,created_at) VALUES (?,?,'partner',?,'open',?,?)")
      .bind(crypto.randomUUID(), id, content, data.key, now).run()
    return json({ id })
  }
  if (path === '/api/partner/tickets' && request.method === 'GET') return list(env, url, { sql: 't.partner_id=?', binds: [partner.id], search: ['t.order_id', 't.subject'] })
  const match = path.match(/^\/api\/partner\/tickets\/([a-f0-9-]{36})(\/replies)?$/)
  if (match && request.method === 'GET' && !match[2]) return json(await detail(env, match[1], { partner_id: partner.id }))
  if (match?.[2] && request.method === 'POST') {
    await partnerLimit(env, 'ticket-reply:' + partner.id, 30, 3600000)
    return reply(env, match[1], 'partner', await body(request, 16384), { partner_id: partner.id })
  }
  throw new ApiError('未找到工单接口。', 404)
}

export async function adminTicketRoutes(request: Request, env: Env, url: URL) {
  const path = url.pathname
  // TicketAlerts polls this every 15s: the event count is a monotonic version,
  // pending counts tickets still waiting for a first admin reply.
  if (path === '/api/admin/tickets/notifications' && request.method === 'GET') {
    const [version, pending] = await Promise.all([
      env.INTEREST_DB.prepare('SELECT COUNT(*) n FROM ticket_events').first<{ n: number }>(),
      env.INTEREST_DB.prepare("SELECT COUNT(*) n FROM tickets WHERE status='open'").first<{ n: number }>(),
    ])
    return json({ version: version?.n ?? 0, pending: pending?.n ?? 0 })
  }
  if (path === '/api/admin/tickets' && request.method === 'GET') return list(env, url, { sql: '1=1', binds: [], search: ['t.order_id', 't.subject', 'p.email', 'p.name'] })
  const match = path.match(/^\/api\/admin\/tickets\/([a-f0-9-]{36})(\/replies)?$/)
  if (match && request.method === 'GET' && !match[2]) return json(await detail(env, match[1]))
  if (match?.[2] && request.method === 'POST') {
    const data = await body(request, 16384)
    const result = await reply(env, match[1], 'admin', data)
    await env.INTEREST_DB.prepare('INSERT INTO admin_audit(id,action,target_id,note,created_at) VALUES (?,?,?,?,?)')
      .bind(crypto.randomUUID(), 'ticket-reply', match[1], `${env.ADMIN_USERNAME}: 回复并更新状态`, Date.now()).run().catch(() => {})
    return result
  }
  throw new ApiError('未找到工单接口。', 404)
}
