import { hash, readCookie, type Env } from './platform.ts'
import { adminLoginEmail } from './admin-auth.ts'
import { securityAlertMessage, sendSecurityAlertEmail } from './email.ts'

// Windows mirror the page copy: 7 days of records, alerts summarized per 15 minutes.
const WINDOW_MS = 15 * 60_000
const RETENTION_MS = 7 * 86400000
const EVENTS_LIMIT = 200
const SAMPLE_WINDOW_ALERTS = 24 * 4

/** Requests that already carry a dedicated audit record; the response sweep skips them. */
const audited = new WeakSet<Request>()

export type SecurityKind = 'block' | 'auth' | 'limit' | 'read'
type SecurityEvent = { kind: SecurityKind; status: number; account?: string }

const roleOf = (path: string) => path.startsWith('/api/admin/') ? 'admin' : path.startsWith('/api/partner/') ? 'partner' : 'public'
const requestIdOf = (request: Request) => request.headers.get('cf-ray')?.slice(0, 64) || crypto.randomUUID()
// Like the Go backend, only a fingerprint of the order identifier is stored.
const orderTarget = async (path: string) => {
  const id = path.match(/\/orders\/([A-Za-z0-9-]{1,64})(?:\/|$)/)?.[1]
  return id ? (await hash('security-audit-target:' + id)).slice(0, 16) : ''
}

/** Best-effort audit write: a logging failure must never break the guarded request. */
export async function recordSecurityEvent(env: Env, request: Request, event: SecurityEvent) {
  audited.add(request)
  try {
    const path = new URL(request.url).pathname
    const session = readCookie(request, 'admin') ?? readCookie(request, 'partner') ?? readCookie(request, 'buyer')
    await env.INTEREST_DB.prepare('INSERT INTO security_events(id,time,kind,ip,request_id,route,method,status,role,account,session,target) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').bind(
      crypto.randomUUID(), Date.now(), event.kind,
      (await hash(request.headers.get('CF-Connecting-IP') ?? 'local')).slice(0, 16),
      requestIdOf(request), path, request.method, event.status, roleOf(path),
      (event.account ?? '').slice(0, 80), session ? (await hash(session)).slice(0, 12) : '', await orderTarget(path),
    ).run()
  } catch { /* audit gaps are preferable to failed responses */ }
}

/** Single choke point over every API response: denials, throttles and sampled staff reads. */
export async function recordApiResponse(env: Env, request: Request, response: Response) {
  try {
    const path = new URL(request.url).pathname
    if (!path.startsWith('/api/') || audited.has(request)) return
    const status = response.status
    if (status === 401 || status === 403) return void await recordSecurityEvent(env, request, { kind: 'auth', status })
    if (status === 429) return void await recordSecurityEvent(env, request, { kind: 'limit', status })
    // Successful staff reads enter the log at a low, window-stable sampling rate.
    if (response.ok && request.method === 'GET' && (path.startsWith('/api/admin/') || path.startsWith('/api/partner/'))) {
      const sample = await hash('sample:' + (request.headers.get('CF-Connecting-IP') ?? 'local') + ':' + path + ':' + Math.floor(Date.now() / WINDOW_MS))
      if (parseInt(sample.slice(0, 2), 16) < 16) await recordSecurityEvent(env, request, { kind: 'read', status })
    }
  } catch { /* never break the response path */ }
}

export async function securitySummary(env: Env) {
  const events = (await env.INTEREST_DB.prepare('SELECT id,time,kind,ip,request_id AS requestId,route,method,status,role,account,session,target FROM security_events WHERE time>=? ORDER BY time DESC,id DESC LIMIT ?').bind(Date.now() - RETENTION_MS, EVENTS_LIMIT).all()).results
  return { enabled: true, events }
}

export async function pruneSecurityAudit(env: Env) {
  const now = Date.now()
  await env.INTEREST_DB.prepare('DELETE FROM security_events WHERE time<?').bind(now - RETENTION_MS).run()
  await env.INTEREST_DB.prepare('DELETE FROM security_alerts WHERE window_id<?').bind(Math.floor(now / WINDOW_MS) - SAMPLE_WINDOW_ALERTS).run()
}

const kindLabel: Record<string, string> = { block: '连续异常限制', auth: '认证拒绝', limit: '频率限制' }
const rangeOf = (from: number, to: number) => [from, to].map(at => new Date(at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })).join(' – ')

/** One digest per completed 15 minute window, only when it actually holds anomalies. */
export async function sendDueSecurityAlerts(env: Env) {
  if (!env.RESEND_API_KEY || !env.RESEND_FROM) return { enabled: false, sent: 0 }
  const window = Math.floor(Date.now() / WINDOW_MS) - 1
  if (window < 0) return { enabled: true, sent: 0 }
  if (await env.INTEREST_DB.prepare('SELECT window_id FROM security_alerts WHERE window_id=?').bind(window).first()) return { enabled: true, sent: 0 }
  const since = window * WINDOW_MS
  const totals = (await env.INTEREST_DB.prepare("SELECT kind,COUNT(*) n FROM security_events WHERE time>=? AND time<? AND kind<>'read' GROUP BY kind ORDER BY kind").bind(since, since + WINDOW_MS).all<{ kind: string; n: number }>()).results
  if (!totals.length) return { enabled: true, sent: 0 }
  const routes = (await env.INTEREST_DB.prepare("SELECT method||' '||route AS route,COUNT(*) n FROM security_events WHERE time>=? AND time<? AND kind<>'read' GROUP BY method,route ORDER BY n DESC,route LIMIT 5").bind(since, since + WINDOW_MS).all<{ route: string; n: number }>()).results
  let to: string
  try { to = adminLoginEmail(env) } catch { return { enabled: false, sent: 0 } }
  const totalsText = totals.map(row => `${kindLabel[row.kind] ?? row.kind} ${row.n} 次`).join('，')
  const routesText = routes.map(row => `${row.route}（${row.n} 次）`).join('\n')
  await sendSecurityAlertEmail(env, to, securityAlertMessage({ window: rangeOf(since, since + WINDOW_MS), totals: totalsText, routes: routesText }), String(window))
  await env.INTEREST_DB.prepare('INSERT INTO security_alerts(window_id,sent_at,totals,routes) VALUES (?,?,?,?) ON CONFLICT(window_id) DO NOTHING').bind(window, Date.now(), totalsText, routesText).run()
  return { enabled: true, sent: 1 }
}
