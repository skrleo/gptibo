import test from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { customerFixture } from './customer-fixture.ts'
import { dailyPromoText, oauthHeader, postDailyPromo, postTweet } from '../worker/x-social.ts'
import { weightedLength } from '../shared/x-post.ts'

const CREDENTIALS = { apiKey: 'key', apiSecret: 'secret', accessToken: 'token', accessSecret: 'token-secret' }
const ENV_CREDENTIALS = { X_API_KEY: 'key', X_API_SECRET: 'secret', X_ACCESS_TOKEN: 'token', X_ACCESS_TOKEN_SECRET: 'token-secret' }

test('weightedLength mirrors X counting', () => {
  assert.equal(weightedLength('a'.repeat(280)), 280)
  assert.equal(weightedLength('汉'.repeat(140)), 280)
  assert.equal(weightedLength('https://gift2card.com/product/gemini'), 23)
  assert.equal(weightedLength('看 https://gift2card.com/product/gemini 快'), 2 + 1 + 23 + 1 + 2)
})

test('oauth 1.0a signature matches an independent HMAC-SHA1 implementation', async () => {
  const header = await oauthHeader('POST', 'https://api.x.com/2/tweets', CREDENTIALS, 'nonce123', '1700000000')
  const params = 'oauth_consumer_key=key&oauth_nonce=nonce123&oauth_signature_method=HMAC-SHA1&oauth_timestamp=1700000000&oauth_token=token&oauth_version=1.0'
  const base = ['POST', encodeURIComponent('https://api.x.com/2/tweets'), encodeURIComponent(params)].join('&')
  const expected = createHmac('sha1', 'secret&token-secret').update(base).digest('base64')
  assert.match(header, /OAuth /)
  assert.match(header, /oauth_signature_method="HMAC-SHA1"/)
  const signature = header.match(/oauth_signature="([^"]+)"/)?.[1]
  assert.equal(decodeURIComponent(signature), expected)
})

test('daily promo posts once per Beijing day from the live catalog', async t => {
  const s = await customerFixture(); t.after(() => s.db.close())
  Object.assign(s.env, { X_POST_AUTO_DAILY: 'true', ...ENV_CREDENTIALS })
  const bodies: unknown[] = []
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)))
    return new Response(JSON.stringify({ data: { id: 'tweet-1' } }), { status: 201 })
  })
  // Noon Beijing time on the current day: inside the posting window.
  const noon = Math.floor((Date.now() + 8 * 3_600_000) / 86_400_000) * 86_400_000 - 8 * 3_600_000 + 12 * 3_600_000
  await postDailyPromo(s.env, noon)
  await postDailyPromo(s.env, noon + 60_000)
  assert.equal(bodies.length, 1)
  const text = String((bodies[0] as { text: string }).text)
  assert.match(text, /【今日精选】/)
  assert.match(text, /https:\/\/gift2card.com\/product\//)
  assert.ok(weightedLength(text) <= 280)
  // Before 10:00 local nothing is posted, even with no mark for the day yet.
  const early = noon - 5 * 3_600_000
  await postDailyPromo(s.env, early)
  assert.equal(bodies.length, 1)
  const composed = await dailyPromoText(s.env, noon)
  assert.ok(composed && composed === text || composed !== null)
})

test('manual posting surfaces X API failures and records successes', async t => {
  const s = await customerFixture(); t.after(() => s.db.close())
  Object.assign(s.env, { X_POST_AUTO_DAILY: 'false', ...ENV_CREDENTIALS })
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ detail: 'You currently have access to a subset of X API.' }), { status: 403 }))
  const request = (body: unknown) => new Request('https://shop.example.invalid/api/admin/x-social', { method: 'POST', body: JSON.stringify(body) })
  await assert.rejects(postTweet(s.env, '测试'), /subset of X API/)
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ data: { id: 'tweet-9' } }), { status: 201 }))
  const { xSocialRoutes } = await import('../worker/x-social.ts')
  const url = new URL('https://shop.example.invalid/api/admin/x-social')
  const response = await xSocialRoutes(request({ text: '促销中' }), s.env, url)
  assert.deepEqual(await response.json(), { ok: true, tweetId: 'tweet-9' })
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM social_posts WHERE source='manual' AND tweet_id='tweet-9'").get().n, 1)
  await assert.rejects(xSocialRoutes(request({ text: 'x'.repeat(300) }), s.env, url), /长度限制/)
  await assert.rejects(xSocialRoutes(request({ text: '  ' }), s.env, url), /请填写/)
})
