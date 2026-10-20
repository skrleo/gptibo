import { ApiError, body, json, type Env } from './platform.ts'
import { partnerLimit } from './partner-auth.ts'

// Cloudflare for SaaS custom hostnames. A partner binds one hostname, adds a
// CNAME to the SaaS target plus an ownership TXT, and the check pipeline walks
// pending_dns → pending_certificate → active as DNS and certificates land.
// Billing (Go version's free/paid tiers) is not ported; slots are free and
// capped by CUSTOM_DOMAINS_LIMIT.

export type CustomDomainConfig = { zone: string; target: string; limit: number; siteHosts: string[]; saasZoneId: string; token: string }
type DomainRow = { id: string; partner_id: string; hostname: string; apex: number; state: string; message: string; verification: string; provider_id: string | null; provider_records: string; checked_at: number | null }
export type DomainView = {
  enabled: boolean; eligible: boolean; completedOrders: number; requiredOrders: number; target: string
  domain: null | { hostname: string; apex: boolean; state: string; message: string; checkedAt: number | null; records: { type: string; name: string; value: string }[] }
}
type CfHostname = { id: string; hostname: string; status: string; ownership_verification?: { name?: string; value?: string }; ssl?: { status?: string; validation_records?: { txt_name?: string; txt_value?: string }[] } }

export const REQUIRED_ORDERS = 3
const completedOrdersSql = `SELECT COUNT(*) n FROM orders WHERE partner_id=? AND mode='live' AND is_test=0 AND payment_status='paid' AND status='success' AND refunded_cents=0 AND refund_hold=0`
const eligibilityMessage = '至少完成 3 单有效订单后才可开通自定义域名。'

// Missing or partial configuration simply means the feature is closed; the
// storefront UI shows "暂未开放" instead of failing.
export function customDomainConfig(env: Env): CustomDomainConfig | null {
  if (env.CUSTOM_DOMAINS_ENABLED !== 'true') return null
  const zone = (env.CUSTOM_DOMAINS_ZONE ?? '').trim().toLowerCase()
  const target = (env.CUSTOM_DOMAINS_TARGET ?? '').trim().toLowerCase()
  const saasZoneId = (env.CF_SAAS_ZONE_ID ?? '').trim()
  const token = env.CF_SAAS_API_TOKEN ?? ''
  if (!/^[a-z0-9.-]+$/.test(zone) || !target.endsWith('.' + zone) || !/^[a-f0-9]{32}$/.test(saasZoneId) || !token) return null
  const limit = Number(env.CUSTOM_DOMAINS_LIMIT ?? 100)
  const siteHosts = (env.CUSTOM_DOMAINS_SITE_HOSTS ?? '').split(',').map(host => host.trim().toLowerCase()).filter(Boolean)
  return { zone, target, limit: Number.isInteger(limit) && limit >= 1 && limit <= 100 ? limit : 100, siteHosts, saasZoneId, token }
}

const bad = () => new ApiError('请填写完整域名，例如 example.com 或 shop.example.com，不含 https://、路径或端口。')
const label = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

// URL parsing doubles as punycode conversion, so IDN input lands as ASCII.
export function normalizeHostname(value: unknown, zone: string | undefined) {
  const raw = typeof value === 'string' ? value.trim().toLowerCase().replace(/\.+$/, '') : ''
  if (!raw || /[/\\:@]/.test(raw)) throw bad()
  let host = ''
  try { host = new URL('http://' + raw).hostname } catch { throw bad() }
  if (host !== raw || host.length > 253 || !host.split('.').every(part => label.test(part))) throw bad()
  if (zone && (host === zone || host.endsWith('.' + zone))) throw new ApiError('不能绑定平台自己的域名。')
  // ponytail: apex = two labels; multi-part public suffixes (co.uk) misreport
  // as subdomains, which only changes the hint copy, never correctness.
  return { host, apex: host.split('.').length === 2 }
}

const hexToken = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('')

async function dnsLookup(name: string, type: 'TXT' | 'CNAME' | 'A') {
  const response = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=${type}`, { headers: { accept: 'application/dns-json' }, signal: AbortSignal.timeout(5000) })
  if (!response.ok) throw new Error('dns lookup failed')
  return await response.json() as { Status: number; Answer?: { type: number; data: string }[] }
}
const stripQuotes = (value: string) => value.replace(/^"|"$/g, '')

// A flattened apex has no public CNAME; compare resolved A records against the
// target's instead. Never treat an arbitrary address as correct routing.
async function routesToTarget(host: string, target: string) {
  const cname = await dnsLookup(host, 'CNAME')
  const record = cname.Answer?.find(answer => answer.type === 5)
  if (record) return record.data.replace(/\.+$/, '').toLowerCase() === target
  const [hostA, targetA] = await Promise.all([dnsLookup(host, 'A'), dnsLookup(target, 'A')])
  const targetIps = new Set((targetA.Answer ?? []).filter(answer => answer.type === 1).map(answer => answer.data))
  return (hostA.Answer ?? []).some(answer => answer.type === 1 && targetIps.has(answer.data))
}

async function cfApi(cfg: CustomDomainConfig, path: string, init?: RequestInit) {
  const response = await fetch('https://api.cloudflare.com/client/v4' + path, {
    ...init, headers: { authorization: 'Bearer ' + cfg.token, 'content-type': 'application/json', ...(init?.headers ?? {}) }, signal: AbortSignal.timeout(10000),
  })
  const payload = await response.json().catch(() => null) as { success?: boolean; result?: unknown; errors?: { code: number; message: string }[] } | null
  return { ok: response.ok && payload?.success === true, status: response.status, result: payload?.result, errors: payload?.errors ?? [] }
}
const cfFind = async (cfg: CustomDomainConfig, hostname: string) => {
  const { ok, result } = await cfApi(cfg, `/zones/${cfg.saasZoneId}/custom_hostnames?hostname=${encodeURIComponent(hostname)}`)
  if (!ok) throw new Error('custom hostname lookup failed')
  return ((result as CfHostname[]) ?? []).find(entry => entry.hostname === hostname) ?? null
}
// Create is only attempted after a lookup, so a lost create response recovers
// instead of duplicating the hostname on the next check.
async function cfEnsure(cfg: CustomDomainConfig, hostname: string) {
  const existing = await cfFind(cfg, hostname)
  if (existing) return existing
  const { ok, result } = await cfApi(cfg, `/zones/${cfg.saasZoneId}/custom_hostnames`, { method: 'POST', body: JSON.stringify({ hostname, ssl: { method: 'txt', type: 'dv', wildcard: false } }) })
  if (!ok) throw new Error('custom hostname create failed')
  return result as CfHostname
}

const providerRecords = (host: CfHostname) => {
  const records: { type: string; name: string; value: string }[] = []
  if (host.ownership_verification?.name && host.ownership_verification.value) records.push({ type: 'TXT', name: host.ownership_verification.name.toLowerCase(), value: host.ownership_verification.value })
  for (const entry of host.ssl?.validation_records ?? []) if (entry.txt_name && entry.txt_value) records.push({ type: 'TXT', name: entry.txt_name.toLowerCase(), value: entry.txt_value })
  return JSON.stringify(records)
}

async function completedOrders(env: Env, partnerId: string) {
  return (await env.INTEREST_DB.prepare(completedOrdersSql).bind(partnerId).first<{ n: number }>())?.n ?? 0
}

export async function domainView(env: Env, partnerId: string): Promise<DomainView> {
  const cfg = customDomainConfig(env)
  const completed = await completedOrders(env, partnerId)
  const row = cfg ? await env.INTEREST_DB.prepare('SELECT * FROM partner_domains WHERE partner_id=?').bind(partnerId).first<DomainRow>() : null
  let records: { type: string; name: string; value: string }[] = []
  if (row) {
    const parsed = JSON.parse(row.provider_records) as { type: string; name: string; value: string }[]
    records = [{ type: 'CNAME', name: row.hostname, value: cfg!.target }, { type: 'TXT', name: '_gptibo-verify.' + row.hostname, value: row.verification }, ...parsed]
  }
  return {
    enabled: cfg !== null, eligible: completed >= REQUIRED_ORDERS, completedOrders: completed, requiredOrders: REQUIRED_ORDERS, target: cfg?.target ?? '',
    domain: row ? { hostname: row.hostname, apex: Boolean(row.apex), state: row.state, message: row.message, checkedAt: row.checked_at, records } : null,
  }
}

export async function domainBind(request: Request, env: Env, partner: { id: string }) {
  const cfg = customDomainConfig(env)
  if (!cfg) throw new ApiError('自定义域名暂未开放，请稍后再试。', 503)
  const data = await body(request)
  const { host, apex } = normalizeHostname(data.hostname, cfg.zone)
  await partnerLimit(env, 'domain-bind:' + partner.id, 10, 3600000)
  if (await completedOrders(env, partner.id) < REQUIRED_ORDERS) throw new ApiError(eligibilityMessage, 403)
  const db = env.INTEREST_DB
  const taken = await db.prepare('SELECT partner_id FROM partner_domains WHERE hostname=?').bind(host).first<{ partner_id: string }>()
  if (taken) {
    if (taken.partner_id !== partner.id) throw new ApiError('域名已被其他商店绑定。', 409)
    return json(await domainView(env, partner.id))
  }
  // One binding per partner: replaying an existing binding is idempotent.
  if (await db.prepare('SELECT id FROM partner_domains WHERE partner_id=?').bind(partner.id).first()) return json(await domainView(env, partner.id))
  const count = (await db.prepare('SELECT COUNT(*) n FROM partner_domains').first<{ n: number }>())?.n ?? 0
  if (count >= cfg.limit) throw new ApiError('当前域名名额已用完，请联系平台。', 409)
  try {
    await db.prepare("INSERT INTO partner_domains(id,partner_id,hostname,apex,verification,message,created_at) VALUES (?,?,?,?,?,'请添加下方解析记录，完成域名归属验证。',?)").bind(crypto.randomUUID(), partner.id, host, apex ? 1 : 0, hexToken(), Date.now()).run()
  } catch (error) { // Lost the UNIQUE race on either column; the stored row wins.
    if (!(error instanceof Error && error.message.includes('UNIQUE'))) throw error
    return json(await domainView(env, partner.id))
  }
  return json(await domainView(env, partner.id))
}

export async function domainCheckRoute(request: Request, env: Env, partner: { id: string }) {
  await body(request).catch(() => ({}))
  const cfg = customDomainConfig(env)
  if (!cfg) throw new ApiError('自定义域名暂未开放。', 503)
  await partnerLimit(env, 'domain-check:' + partner.id, 2, 30000)
  const row = await env.INTEREST_DB.prepare('SELECT id FROM partner_domains WHERE partner_id=?').bind(partner.id).first<{ id: string }>()
  if (row) await checkOne(env, cfg, row.id)
  return json(await domainView(env, partner.id))
}

export async function domainRemove(request: Request, env: Env, partner: { id: string }) {
  const data = await body(request)
  const cfg = customDomainConfig(env)
  const { host } = normalizeHostname(data.hostname, cfg?.zone)
  const db = env.INTEREST_DB
  const row = await db.prepare('SELECT id FROM partner_domains WHERE partner_id=? AND hostname=?').bind(partner.id, host).first<{ id: string }>()
  if (!row) throw new ApiError('域名已变更，请刷新后重试。', 409)
  // Mark locally unavailable before contacting the provider; the check pipeline
  // finishes provider cleanup and retries any failure.
  await db.prepare("UPDATE partner_domains SET state='deleting',message='正在解除绑定，请稍候。',checked_at=NULL WHERE id=?").bind(row.id).run()
  if (cfg) await checkOne(env, cfg, row.id).catch(() => {})
  return json(await domainView(env, partner.id))
}

// State machine for one binding: DNS ownership → routing → Cloudflare
// registration → certificate. Each failure short-circuits with a message the
// partner can act on; active bindings are never downgraded by a check error.
export async function checkOne(env: Env, cfg: CustomDomainConfig, id: string) {
  const db = env.INTEREST_DB
  const row = await db.prepare('SELECT * FROM partner_domains WHERE id=?').bind(id).first<DomainRow>()
  if (!row) return
  const save = async (state: string, message: string, providerId: string | null = row.provider_id, providerRecords = row.provider_records) =>
    db.prepare('UPDATE partner_domains SET state=?,message=?,provider_id=?,provider_records=?,checked_at=? WHERE id=?').bind(state, message, providerId, providerRecords, Date.now(), id).run()
  if (row.state === 'deleting') {
    let providerId = row.provider_id
    if (!providerId || providerId === 'creating') {
      const found = await cfFind(cfg, row.hostname).catch(() => null)
      providerId = found?.id ?? null
    }
    if (providerId) {
      const { ok, status } = await cfApi(cfg, `/zones/${cfg.saasZoneId}/custom_hostnames/${providerId}`, { method: 'DELETE' })
      if (!ok && status !== 404) return save('deleting', '正在解除绑定，请稍候。')
    }
    await db.prepare('DELETE FROM partner_domains WHERE id=?').bind(id).run()
    return
  }
  if (row.state !== 'active' && await completedOrders(env, row.partner_id) < REQUIRED_ORDERS) return save('error', eligibilityMessage)
  let txt: { Status: number; Answer?: { type: number; data: string }[] }
  try { txt = await dnsLookup('_gptibo-verify.' + row.hostname, 'TXT') } catch { return save(row.state, '解析检查暂时不可用，请稍后重试。') }
  if (!(txt.Answer ?? []).some(answer => answer.type === 16 && stripQuotes(answer.data) === row.verification)) return save('pending_dns', '等待域名归属验证，请检查 TXT 记录并保留该记录。')
  let routed = false
  try { routed = await routesToTarget(row.hostname, cfg.target) } catch { return save(row.state, '解析检查暂时不可用，请稍后重试。') }
  if (!routed) return save('pending_dns', row.apex ? '等待根域名解析生效；请在 Cloudflare DNS 添加 @ 的 CNAME，指向接入地址并设为“仅 DNS”，移除 @ 下冲突的 A/AAAA 记录。' : '等待 CNAME 解析生效；请使用仅 DNS 解析，关闭该记录的其他代理。')
  if (!row.provider_id) return save('pending_dns', '解析初步检查通过，正在申请 Cloudflare 域名接入验证。', 'creating')
  let host: CfHostname | null
  try {
    host = row.provider_id === 'creating' ? await cfEnsure(cfg, row.hostname) : await (async (): Promise<CfHostname | null> => {
      const { ok, status, result } = await cfApi(cfg, `/zones/${cfg.saasZoneId}/custom_hostnames/${row.provider_id}`)
      if (!ok && status === 404) return null
      if (!ok) throw new Error('custom hostname lookup failed')
      return result as CfHostname
    })()
  } catch {
    if (row.state === 'active') return save('active', '域名已启用，HTTPS 证书已就绪。')
    return save('error', '域名接入服务暂不可用或名额已满，系统会自动重试。')
  }
  if (!host || !host.id) return save('error', '域名接入已失效，系统将自动重新申请。', 'creating')
  const records = providerRecords(host)
  if (host.status === 'active' && host.ssl?.status === 'active') return save('active', '域名已启用，HTTPS 证书已就绪。', host.id, records)
  return save('pending_certificate', '系统正在签发 HTTPS 证书，通常几分钟内完成。', host.id, records)
}

// Cron reconcile: pending bindings refresh quickly while active ones only need
// certificate-renewal checks; oldest-checked first, bounded per run.
export async function reconcileDomains(env: Env) {
  const cfg = customDomainConfig(env)
  if (!cfg) return
  const now = Date.now()
  const rows = await env.INTEREST_DB.prepare(`SELECT id FROM partner_domains WHERE checked_at IS NULL OR checked_at < ? + CASE WHEN state='active' THEN 3600000 ELSE 180000 END ORDER BY checked_at LIMIT 20`).bind(now).all<{ id: string }>()
  for (const entry of rows.results) await checkOne(env, cfg, entry.id).catch(() => {})
}

// Storefront entry: a request to a bound, active hostname forwards into the
// shop's /s/{slug}/ routes so the SPA picks up the shop context. Platform
// hosts (siteHosts / SaaS zone) skip the lookup entirely.
export async function customDomainEntry(env: Env, url: URL): Promise<Response | null> {
  const cfg = customDomainConfig(env)
  if (!cfg) return null
  const host = url.hostname.toLowerCase()
  if (cfg.siteHosts.includes(host) || host === cfg.target || host.endsWith('.' + cfg.zone)) return null
  if (url.pathname.startsWith('/s/') || url.pathname.startsWith('/r/')) return null
  const row = await env.INTEREST_DB.prepare("SELECT p.slug FROM partner_domains d JOIN partners p ON p.id=d.partner_id WHERE d.hostname=? AND d.state='active' AND p.active=1").bind(host).first<{ slug: string }>()
  if (!row) return null
  const path = url.pathname === '/' ? '' : url.pathname
  return new Response(null, { status: 302, headers: { location: '/s/' + row.slug + path + url.search, 'cache-control': 'no-store' } })
}
