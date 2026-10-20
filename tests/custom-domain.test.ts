import test from 'node:test'
import assert from 'node:assert/strict'
import { customerFixture } from './customer-fixture.ts'
import { checkOne, customDomainConfig, customDomainEntry, domainBind, domainCheckRoute, domainRemove, domainView } from '../worker/custom-domain.ts'
import { ApiError } from '../worker/platform.ts'

const cfgEnv = (s: Awaited<ReturnType<typeof customerFixture>>) => ({
  ...s.env,
  CUSTOM_DOMAINS_ENABLED: 'true',
  CUSTOM_DOMAINS_ZONE: 'shops.example.invalid',
  CUSTOM_DOMAINS_TARGET: 'shops-target.shops.example.invalid',
  CUSTOM_DOMAINS_SITE_HOSTS: 'shop.example.invalid',
  CF_SAAS_ZONE_ID: 'a'.repeat(32),
  CF_SAAS_API_TOKEN: 'token',
})

const bindRequest = (hostname: string) => new Request('https://api.example.test/api/partner/domain', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://api.example.test' }, body: JSON.stringify({ hostname }) })

type DohAnswer = { type: number; data: string }

// One fetch mock serving both DoH answers and the Cloudflare custom-hostname API.
function mockProviderFetch() {
  const dns: { txt: Map<string, string[]>; cname: Map<string, string>; a: Map<string, string[]> } = { txt: new Map(), cname: new Map(), a: new Map() }
  const hostnames = new Map<string, { id: string; hostname: string; status: string; ownership_verification?: { name?: string; value?: string }; ssl?: { status?: string; validation_records?: { txt_name?: string; txt_value?: string }[] } }>()
  let serial = 0
  const fetchMock = async (url: string | URL, init?: RequestInit) => {
    const href = String(url)
    if (href.startsWith('https://cloudflare-dns.com/')) {
      const query = new URL(href).searchParams
      const name = query.get('name')!
      let answer: DohAnswer[] | undefined
      if (query.get('type') === 'TXT') answer = dns.txt.get(name)?.map(data => ({ type: 16, data: '"' + data + '"' }))
      else if (query.get('type') === 'CNAME') answer = dns.cname.has(name) ? [{ type: 5, data: dns.cname.get(name)! + '.' }] : undefined
      else answer = (dns.a.get(name) ?? []).map(data => ({ type: 1, data }))
      return Response.json({ Status: 0, ...(answer ? { Answer: answer } : {}) })
    }
    if (href.startsWith('https://api.cloudflare.com/client/v4/zones/')) {
      const path = new URL(href).pathname
      if (path.endsWith('/custom_hostnames') && init?.method === 'POST') {
        const requested = JSON.parse(String(init.body)) as { hostname: string }
        if ([...hostnames.values()].some(entry => entry.hostname === requested.hostname)) return Response.json({ success: false, errors: [{ code: 1414, message: 'duplicate' }] }, { status: 409 })
        const record = { id: 'ch-' + ++serial, hostname: requested.hostname, status: 'pending', ownership_verification: { name: '_cf-custom-hostname.' + requested.hostname, value: 'own-' + serial }, ssl: { status: 'pending_validation', validation_records: [{ txt_name: '_acme-challenge.' + requested.hostname, txt_value: 'dcv-' + serial }] } }
        hostnames.set(record.id, record)
        return Response.json({ success: true, result: record }, { status: 201 })
      }
      const record = path.endsWith('/custom_hostnames')
        ? [...hostnames.values()].find(entry => entry.hostname === new URL(href).searchParams.get('hostname')) ?? null
        : hostnames.get(path.split('/').pop()!) ?? null
      if (!record && path.endsWith('/custom_hostnames')) return Response.json({ success: true, result: [] }) // CF lists miss as 200 + []
      if (!record) return Response.json({ success: false, errors: [{ code: 7042, message: 'not found' }] }, { status: 404 })
      if (init?.method === 'DELETE') { hostnames.delete(record.id); return Response.json({ success: true, result: { id: record.id } }) }
      return Response.json({ success: true, result: record })
    }
    throw new Error('unexpected external fetch: ' + href)
  }
  return { fetchMock, dns, hostnames }
}

async function seedPartner(s: Awaited<ReturnType<typeof customerFixture>>, id: string, slug: string, orders = 0) {
  const now = Date.now()
  await s.db.prepare('INSERT INTO partners(id,slug,name,email,created_at,updated_at) VALUES (?,?,?,?,?,?)').run(id, slug, 'Partner ' + id, id + '@example.test', now, now)
  await seedOrders(s, id, orders)
}

function seedOrders(s: Awaited<ReturnType<typeof customerFixture>>, id: string, orders: number) {
  const now = Date.now()
  const insert = s.db.prepare('INSERT INTO orders(id,owner_hash,idempotency_key,plan,plan_name,price_cents,mode,payment_status,status,partner_id,created_at,updated_at,last_event_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
  for (let index = 0; index < orders; index++) insert.run('YMX-' + id + '-' + index, 'h' + id + index, 'k' + id + index, 'plus', 'Plus', 13900, 'live', 'paid', 'success', id, now + index, now + index, 'e' + id + index)
}

test('custom domain lifecycle walks pending_dns → pending_certificate → active and removes cleanly', async t => {
  const s = await customerFixture(); t.after(() => s.db.close())
  const provider = mockProviderFetch()
  t.mock.method(globalThis, 'fetch', provider.fetchMock)
  const env = cfgEnv(s)
  await seedPartner(s, 'p1', 'alpha')
  const partner = { id: 'p1' }

  let view = await domainView(env, partner.id)
  assert.equal(view.enabled, true)
  assert.equal(view.eligible, false)
  assert.equal(view.domain, null)
  assert.equal(view.target, 'shops-target.shops.example.invalid')

  await assert.rejects(() => domainBind(bindRequest('brand.example.com'), env, partner), (e: unknown) => e instanceof ApiError && e.status === 403)

  seedOrders(s, 'p1', 3)
  view = await (await domainBind(bindRequest('brand.example.com'), env, partner)).json() as typeof view
  assert.equal(view.eligible, true)
  assert.equal(view.domain!.state, 'pending_dns')
  assert.equal(view.domain!.records.length, 2)
  assert.equal(view.domain!.records[0].type, 'CNAME')
  assert.equal(view.domain!.records[1].name, '_gptibo-verify.brand.example.com')
  const verification = view.domain!.records[1].value

  // Rebinding the same host or as an already-bound partner is idempotent.
  await domainBind(bindRequest('brand.example.com'), env, partner)

  // Another qualifying partner cannot take a bound hostname.
  await seedPartner(s, 'p2', 'beta', 3)
  await assert.rejects(() => domainBind(bindRequest('brand.example.com'), env, { id: 'p2' }), (e: unknown) => e instanceof ApiError && e.status === 409)

  await assert.rejects(() => domainBind(bindRequest('x.shops.example.invalid'), env, partner), (e: unknown) => e instanceof ApiError && e.status === 400)

  // The route shell applies rate limiting; the lifecycle below drives checkOne
  // directly, the same entry the cron reconcile uses.
  const cfg = customDomainConfig(env)!
  const runCheck = async () => {
    await checkOne(env, cfg, (s.db.prepare('SELECT id FROM partner_domains').get() as { id: string }).id)
    return domainView(env, partner.id) as Promise<typeof view>
  }

  view = await runCheck()
  assert.equal(view.domain!.state, 'pending_dns')
  assert.match(view.domain!.message, /归属验证/)

  provider.dns.txt.set('_gptibo-verify.brand.example.com', [verification])
  view = await runCheck()
  assert.equal(view.domain!.state, 'pending_dns')
  assert.match(view.domain!.message, /CNAME 解析生效/)

  provider.dns.cname.set('brand.example.com', 'shops-target.shops.example.invalid')
  view = await runCheck()
  assert.equal(view.domain!.state, 'pending_dns')
  assert.match(view.domain!.message, /正在申请/)

  view = await runCheck()
  assert.equal(view.domain!.state, 'pending_certificate')
  assert.equal(view.domain!.records.length, 4)

  const record = [...provider.hostnames.values()][0]
  record.status = 'active'; record.ssl!.status = 'active'
  view = await runCheck()
  assert.equal(view.domain!.state, 'active')

  const entry = await customDomainEntry(env, new URL('https://brand.example.com/orders'))
  assert.equal(entry!.status, 302)
  assert.equal(entry!.headers.get('location'), '/s/alpha/orders')
  const root = await customDomainEntry(env, new URL('https://brand.example.com/'))
  assert.equal(root!.headers.get('location'), '/s/alpha')
  assert.equal(await customDomainEntry(env, new URL('https://shop.example.invalid/')), null)
  assert.equal(await customDomainEntry(env, new URL('https://brand.example.com/s/alpha/')), null)

  await domainRemove(new Request('https://api.example.test/api/partner/domain/remove', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://api.example.test' }, body: JSON.stringify({ hostname: 'brand.example.com' }) }), env, partner)
  view = await domainView(env, partner.id)
  assert.equal(view.domain, null)
  assert.equal(provider.hostnames.size, 0)
})
