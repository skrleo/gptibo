// Only the official Alipay QR payload may cross the storefront boundary.
// Supplier cashier URLs and their access tokens remain server-side.
export function publicAlipayQr(value: unknown): string | null {
  return typeof value === 'string' && value === value.trim() && /^https:\/\/qr\.alipay\.com\/[A-Za-z0-9]{8,128}$/.test(value) ? value : null
}

// USDT (TRC20) collection shows the bare receiving address; nothing else about
// the merchant's on-chain setup may cross the storefront boundary.
export const TRON_ADDRESS = /^T[1-9A-HJ-NP-Za-km-z]{33}$/
export function publicTronAddress(value: unknown): string | null {
  return typeof value === 'string' && value === value.trim() && TRON_ADDRESS.test(value) ? value : null
}
