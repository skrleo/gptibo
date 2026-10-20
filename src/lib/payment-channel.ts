export function paymentChannel(provider?: string) {
  if (provider === 'usdt') return { name: 'USDT (TRC20)', mark: 'U', action: '复制地址并转账' }
  const wechat = provider === 'gatewaya-wxpay' || provider === 'gatewayb-wxpay'
  const thirdParty = Boolean(provider?.startsWith('gatewaya-') || provider?.startsWith('gatewayb-'))
  return { name: wechat ? '微信支付' : '支付宝支付', mark: wechat ? '微' : '支', action: thirdParty ? '打开收银台' : '打开支付宝' }
}
