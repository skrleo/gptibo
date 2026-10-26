import { ApiError, json, type Env } from './platform.ts'
import { productNameForId } from '../shared/email-products.ts'
import { weightedLength } from '../shared/x-post.ts'

// X (Twitter) posting for storefront promotion: an admin composer plus one
// daily promo tweet picked from the live catalog. OAuth 1.0a user context
// covers a single-account bot; the four credentials live in wrangler secrets
// and the auto-post cadence is gated by the X_POST_AUTO_DAILY var.

type XCredentials = { apiKey: string; apiSecret: string; accessToken: string; accessSecret: string }

const X_API_BASE = 'https://api.x.com'
const BEIJING_OFFSET = 8 * 3_600_000
const DAY_MS = 86_400_000

function credentialsOf(env: Env): XCredentials | null {
  const { X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_TOKEN_SECRET } = env
  return X_API_KEY && X_API_SECRET && X_ACCESS_TOKEN && X_ACCESS_TOKEN_SECRET
    ? { apiKey: X_API_KEY, apiSecret: X_API_SECRET, accessToken: X_ACCESS_TOKEN, accessSecret: X_ACCESS_TOKEN_SECRET }
    : null
}

const OAUTH_EXTRA = /[!'()*]/g
const percent = (value: string) => encodeURIComponent(value).replace(OAUTH_EXTRA, ch => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`)

// Nonce/timestamp are injectable so tests can pin the signature to a
// known-good vector instead of asserting on moving values.
export async function oauthHeader(method: string, endpoint: string, credentials: XCredentials, nonce = crypto.randomUUID().replace(/-/g, ''), timestamp = String(Math.floor(Date.now() / 1000))) {
  const params: Record<string, string> = { oauth_consumer_key: credentials.apiKey, oauth_nonce: nonce, oauth_signature_method: 'HMAC-SHA1', oauth_timestamp: timestamp, oauth_token: credentials.accessToken, oauth_version: '1.0' }
  const base = Object.keys(params).sort().map(key => `${percent(key)}=${percent(params[key])}`).join('&')
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(`${percent(credentials.apiSecret)}&${percent(credentials.accessSecret)}`), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign'])
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode([method.toUpperCase(), percent(endpoint), percent(base)].join('&')))
  const signature = btoa(String.fromCharCode(...new Uint8Array(mac)))
  return 'OAuth ' + Object.entries({ ...params, oauth_signature: signature }).map(([key, value]) => `${key}="${percent(value)}"`).sort().join(', ')
}

export async function postTweet(env: Env, text: string) {
  const credentials = credentialsOf(env)
  if (!credentials) throw new ApiError('尚未配置 X API 凭据。', 400)
  const endpoint = `${X_API_BASE}/2/tweets`
  const response = await fetch(endpoint, { method: 'POST', headers: { Authorization: await oauthHeader('POST', endpoint, credentials), 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) })
  const payload = await response.json().catch(() => ({})) as { data?: { id?: string }; detail?: string; title?: string }
  if (!response.ok) throw new ApiError(payload.detail || payload.title || `X 接口返回 ${response.status}。`, 502)
  return payload.data?.id ?? ''
}

const price = (cents: number) => (cents / 100).toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1')

export async function dailyPromoText(env: Env, now = Date.now()) {
  const plans = (await env.INTEREST_DB.prepare('SELECT product_id, price_cents FROM catalog_plans WHERE enabled=1').all<{ product_id: string; price_cents: number }>()).results
  const cheapest = new Map<string, number>()
  for (const plan of plans) cheapest.set(plan.product_id, Math.min(cheapest.get(plan.product_id) ?? Number.MAX_SAFE_INTEGER, plan.price_cents))
  const entries = [...cheapest.entries()]
  if (!entries.length) return null
  // Rotate through on-sale products by Beijing day so consecutive promos differ.
  const [productId, cents] = entries[Math.floor((now + BEIJING_OFFSET) / DAY_MS) % entries.length]
  return `【今日精选】${productNameForId(productId)} ¥${price(cents)}\n支付宝/USDT 直付，付款后快速交付。\n→ https://gift2card.com/product/${productId}`
}

// One promo per Beijing day, published from 10:00 local; the sent mark in
// social_posts keeps the every-minute cron idempotent across retries.
export async function postDailyPromo(env: Env, now = Date.now()) {
  if (env.X_POST_AUTO_DAILY !== 'true' || !credentialsOf(env)) return
  if (Math.floor(((now + BEIJING_OFFSET) % DAY_MS) / 3_600_000) < 10) return
  const dayStart = Math.floor((now + BEIJING_OFFSET) / DAY_MS) * DAY_MS - BEIJING_OFFSET
  if (await env.INTEREST_DB.prepare("SELECT 1 FROM social_posts WHERE source='daily' AND created_at >= ? LIMIT 1").bind(dayStart).first()) return
  const text = await dailyPromoText(env, now)
  if (!text) return
  const tweetId = await postTweet(env, text)
  await env.INTEREST_DB.prepare('INSERT INTO social_posts(id,content,tweet_id,source,created_at) VALUES (?,?,?,?,?)').bind(crypto.randomUUID(), text, tweetId, 'daily', now).run()
}

type SocialPost = { id: string; content: string; tweet_id: string | null; source: 'daily' | 'manual'; created_at: number }

export async function xSocialRoutes(request: Request, env: Env, url: URL) {
  if (url.pathname !== '/api/admin/x-social') throw new ApiError('未找到接口。', 404)
  if (request.method === 'GET') {
    const posts = (await env.INTEREST_DB.prepare('SELECT id, content, tweet_id, source, created_at FROM social_posts ORDER BY created_at DESC LIMIT 20').all<SocialPost>()).results
    return json({ configured: Boolean(credentialsOf(env)), autoDaily: env.X_POST_AUTO_DAILY === 'true', posts })
  }
  if (request.method === 'POST') {
    const body = await request.json().catch(() => null) as { text?: unknown } | null
    const text = typeof body?.text === 'string' ? body.text.trim() : ''
    if (!text) throw new ApiError('请填写帖子内容。', 400)
    if (weightedLength(text) > 280) throw new ApiError('内容超出 X 长度限制。', 400)
    const tweetId = await postTweet(env, text)
    await env.INTEREST_DB.prepare('INSERT INTO social_posts(id,content,tweet_id,source,created_at) VALUES (?,?,?,?,?)').bind(crypto.randomUUID(), text, tweetId, 'manual', Date.now()).run()
    return json({ ok: true, tweetId })
  }
  throw new ApiError('此管理接口只支持查询与发布。', 405)
}
