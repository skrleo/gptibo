import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveStorefrontLocale, translateStorefront } from '../src/lib/storefront-locale.ts'

test('explicit language selection wins over browser preferences', () => {
  assert.equal(resolveStorefrontLocale('en', ['zh-CN']), 'en')
  assert.equal(resolveStorefrontLocale('zh-CN', ['en-US']), 'zh-CN')
})

test('first visit selects the first supported browser language and safely defaults to Chinese', () => {
  assert.equal(resolveStorefrontLocale(null, ['en-GB', 'zh-CN']), 'en')
  assert.equal(resolveStorefrontLocale(null, ['zh-TW', 'en-US']), 'zh-CN')
  assert.equal(resolveStorefrontLocale('invalid', ['fr-FR', 'EN-us']), 'en')
  assert.equal(resolveStorefrontLocale(null, ['fr-FR']), 'zh-CN')
  assert.equal(resolveStorefrontLocale(null, []), 'zh-CN')
})

test('translations preserve Chinese defaults, shop content and literal interpolation values', () => {
  assert.equal(translateStorefront('en', '全部商品'), 'All products')
  assert.equal(translateStorefront('zh-CN', '全部商品'), '全部商品')
  assert.equal(translateStorefront('en', '商家自定义公告'), '商家自定义公告')
  assert.equal(translateStorefront('en', '{product} 上线提醒', { product: 'Claude $& {product}' }), 'Claude $& {product} launch updates')
  assert.equal(translateStorefront('zh-CN', '{product} 上线提醒', { product: 'Claude' }), 'Claude 上线提醒')
  assert.equal(translateStorefront('en', 'toString'), 'toString')
  assert.equal(translateStorefront('en', '{product} 上线提醒'), '{product} launch updates')
})

test('orders page and recovery workflow have complete English copy', () => {
  const messages = [
    ['订单记录', 'Order history'],
    ['每一步，都有记录。', 'Every step, recorded.'],
    ['全部订单', 'All orders'],
    ['退款 / 售后', 'Refunds / support'],
    ['还没有购买记录。', 'No orders yet.'],
    ['新订单可通过下单邮箱找回；未留邮箱的旧订单仍需保留原浏览器 Cookie。', 'Recover new orders with the order email. Older orders without an email still require the original browser cookie.'],
    ['通过邮箱找回订单', 'Recover orders by email'],
    ['待邮件发货', 'Awaiting email delivery'],
    ['部分退款', 'Partially refunded'],
  ] as const
  for (const [source, english] of messages) assert.equal(translateStorefront('en', source), english)
  assert.equal(translateStorefront('en', '已验证 {email} · 同时展示此浏览器与邮箱的最近 100 笔订单。', { email: 'buyer@example.com' }), 'Verified buyer@example.com · Showing the latest 100 orders from this browser and email.')
  assert.equal(translateStorefront('en', '{seconds} 秒后可重发', { seconds: 42 }), 'Resend in 42s')
})
