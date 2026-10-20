import test from 'node:test'
import assert from 'node:assert/strict'
import { customerFixture } from './customer-fixture.ts'
import { withCronHealth } from '../worker/cron-health.ts'
import type { Env } from '../worker/platform.ts'

const failing = () => { throw new Error('job exploded') }
const healthy = async () => 'ok'

test('cron health alerts after 3 consecutive failures, re-alerts every 6h and announces recovery', async t => {
  const s = await customerFixture(); t.after(() => s.db.close())
  const env = { ...s.env, FEISHU_APP_ID: 'app', FEISHU_APP_SECRET: 'secret', FEISHU_PAYOUT_RECIPIENT: 'ou_alerts' } as Env
  const sent: { uuid?: string; text?: string }[] = []
  t.mock.method(globalThis, 'fetch', async (url: string | URL, init?: RequestInit) => {
    assert.equal(String(url).startsWith('https://open.feishu.cn/open-apis/'), true)
    if (String(url).endsWith('/auth/v3/tenant_access_token/internal')) return Response.json({ code: 0, tenant_access_token: 'tok' })
    const payload = JSON.parse(String(init?.body)) as { uuid: string; content: string }
    sent.push({ uuid: payload.uuid, text: JSON.parse(payload.content).text })
    return Response.json({ code: 0 })
  })

  // Healthy runs never touch the alert channel or even create a row.
  await withCronHealth(env, 'payments', healthy)
  await withCronHealth(env, 'payments', healthy)
  assert.equal((s.db.prepare('SELECT COUNT(*) n FROM cron_health').get() as { n: number }).n, 0)
  assert.equal(sent.length, 0)

  await withCronHealth(env, 'payments', failing)
  await withCronHealth(env, 'payments', failing)
  assert.equal(sent.length, 0) // two failures stay quiet
  await withCronHealth(env, 'payments', failing)
  assert.equal(sent.length, 1)
  assert.match(sent[0].text!, /已连续失败 3 次/)
  assert.equal(sent[0].uuid, 'ymx-cron-payments-' + Math.floor(Date.now() / 21600000))

  // Still failing inside the re-alert window: counted, not re-paged.
  await withCronHealth(env, 'payments', failing)
  await withCronHealth(env, 'payments', failing)
  assert.equal(sent.length, 1)
  assert.equal((s.db.prepare("SELECT fail_streak FROM cron_health WHERE task='payments'").get() as { fail_streak: number }).fail_streak, 5)

  // Six hours later the next failure re-alerts.
  const realNow = Date.now()
  t.mock.method(Date, 'now', () => realNow + 6 * 60 * 60 * 1000 + 1000)
  await withCronHealth(env, 'payments', failing)
  assert.equal(sent.length, 2)
  assert.match(sent[1].text!, /已连续失败 6 次/)

  // Recovery after an alerted streak announces itself and clears the streak.
  await withCronHealth(env, 'payments', healthy)
  assert.equal(sent.length, 3)
  assert.match(sent[2].text!, /已恢复正常/)
  assert.equal((s.db.prepare("SELECT fail_streak FROM cron_health WHERE task='payments'").get() as { fail_streak: number }).fail_streak, 0)

  // Flapping below the threshold recovers silently.
  await withCronHealth(env, 'payments', failing)
  await withCronHealth(env, 'payments', healthy)
  assert.equal(sent.length, 3)
})

test('failures are counted even without Feishu configured', async t => {
  const s = await customerFixture(); t.after(() => s.db.close())
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw new Error('network') })
  for (let i = 0; i < 4; i++) await withCronHealth(s.env, 'xgift', failing)
  assert.equal(calls, 0) // no channel configured → no send attempts
  assert.equal((s.db.prepare("SELECT fail_streak FROM cron_health WHERE task='xgift'").get() as { fail_streak: number }).fail_streak, 4)
})
