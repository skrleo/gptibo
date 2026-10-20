import { useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Feedback } from '@/components/workspace-loading'
import { api, errorMessage } from '@/lib/api'
import { useResource } from '@/lib/use-resource'
import { CircleDollarSign, KeyRound, PackageCheck, RefreshCcw, ShieldAlert, ShoppingCart } from 'lucide-react'

type Config = { configured: boolean; checkoutEnabled: boolean; goodsId: number | null; maxCostCents: number | null }
type Goods = { goodsId: number; name: string; priceCents: number; stock: number; enabled: boolean }
export function GmailSupplierPanel({ revision }: { revision: number }) {
  const config = useResource<Config>('/api/admin/account_supplier', revision)
  const ready = Boolean(config.data?.configured && config.data.checkoutEnabled)
  return <section className="admin-panel gmail-supplier-panel"><div className="admin-panel-title gmail-supplier-heading"><div><h2>Gmail 自动采购</h2><p>付款确认后自动下单，通过邮件完成交付。</p></div>{config.data && <span className={`connection-state ${ready ? 'is-ready' : ''}`}>{ready ? '自动采购运行中' : config.data.configured ? '自动采购已关闭' : '需要配置'}</span>}</div>
    <Feedback error={config.error} loading={config.loading} data={config.data} shape="compact" />
    {config.data && <div className="gmail-supplier-overview">
      <div className={config.data.configured ? 'is-ready' : ''}><KeyRound size={18} /><div><span>接口凭据</span><strong>{config.data.configured ? '已连接' : '未配置'}</strong><small>{config.data.configured ? '供应商接口可用' : '在服务器环境中设置'}</small></div></div>
      <div className={config.data.checkoutEnabled ? 'is-ready' : ''}><ShoppingCart size={18} /><div><span>自动采购</span><strong>{config.data.checkoutEnabled ? '已启用' : '未启用'}</strong><small>{config.data.checkoutEnabled ? '付款后自动创建采购单' : '新订单不会自动采购'}</small></div></div>
      <div className={config.data.maxCostCents !== null ? 'is-ready' : ''}><CircleDollarSign size={18} /><div><span>单笔成本上限</span><strong>{config.data.maxCostCents !== null ? `¥${(config.data.maxCostCents / 100).toFixed(2)}` : '未设置'}</strong><small>{config.data.maxCostCents !== null ? '超过上限时暂停采购' : '建议配置风控上限'}</small></div></div>
    </div>}
    {config.data?.configured && config.data.goodsId && <SupplierGoods id={config.data.goodsId} revision={revision} />}
    <div className="gmail-supplier-rules"><p><RefreshCcw size={15} /><span><strong>避免重复采购</strong>采购超时只查询原采购单，不重复下单。</span></p><p><ShieldAlert size={15} /><span><strong>自动风控</strong>进价超过成本上限或库存不足时暂停新购买。</span></p><small>售价与代理拿货价在“商品与套餐”和“代理管理”中调整。</small></div>
  </section>
}
function SupplierGoods({ id, revision }: { id: number; revision: number }) {
  const product = useResource<Goods>(`/api/admin/account_supplier/goods/${id}`, revision)
  return <><Feedback error={product.error} loading={product.loading} data={product.data} shape="compact" />{product.data && <div className="gmail-supplier-product"><PackageCheck size={18} /><div><span>当前采购商品 · #{product.data.goodsId}</span><strong>{product.data.name}</strong></div><dl><div><dt>当前进价</dt><dd>¥{(product.data.priceCents / 100).toFixed(2)}</dd></div><div><dt>供应库存</dt><dd>{product.data.stock}</dd></div></dl><span className={`connection-state ${product.data.enabled ? 'is-ready' : ''}`}>{product.data.enabled ? '供应商在售' : '供应商已停售'}</span></div>}</>
}
type Purchase = { state: string; goodsId: number; supplierOrder: string | null; actualCostCents: number | null; maxCostCents: number; updatedAt: number }
export function GmailOrderPanel({ id, revision, orderVersion, onSaved }: { id: string; revision: number; orderVersion: number; onSaved: () => void }) {
  const endpoint = `/api/admin/orders/${id}/account_supplier`, resource = useResource<{ purchase: Purchase | null }>(endpoint, revision)
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), lock = useRef(false)
  const [confirmed, setConfirmed] = useState(false), [note, setNote] = useState('')
  async function sync(resolve = false) {
    if (lock.current) return
    lock.current = true; setBusy(true); setError('')
    try { await api(endpoint, resolve ? { action: 'confirm-not-purchased', confirmed, note, orderVersion, updatedAt: resource.data?.purchase?.updatedAt } : { action: 'sync' }); onSaved() } catch (e) { setError(errorMessage(e)); onSaved() } finally { lock.current = false; setBusy(false) }
  }
  const labels: Record<string, string> = { prepared: '待确认付款并采购', creating: '采购处理中', unknown: '原采购结果待核对', purchased: '账号采购已核验', rejected: '采购未完成，请核对供应商记录后处理售后' }
  return <section className="email-delivery-panel" aria-label="Gmail 采购记录"><h3>Gmail 采购记录</h3><Feedback error={error || resource.error} loading={resource.loading} data={resource.data} shape="compact" />
    {resource.data?.purchase && <p>{labels[resource.data.purchase.state]}<br />商品编号 {resource.data.purchase.goodsId} · 供应商单号 {resource.data.purchase.supplierOrder ?? '尚未确认'}<br />实际成本 {resource.data.purchase.actualCostCents !== null ? `¥${(resource.data.purchase.actualCostCents / 100).toFixed(2)}` : '待核验'}</p>}
    <Button variant="outline" disabled={busy} onClick={() => void sync()}>{busy ? '正在核对…' : '核对采购与发货进度'}</Button>
    {resource.data?.purchase && ['creating', 'unknown'].includes(resource.data.purchase.state) && <details><summary>已在供应商后台核实原采购未发生</summary><p>仅在核实原订单无扣款、无发货后登记。登记后停止自动采购，可通过售后退款；请勿在说明中填写账号密码。</p><label className="admin-checkbox"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} disabled={busy} />已核实原采购单无扣款、无发货</label><Input aria-label="采购核查说明" value={note} onChange={e => setNote(e.target.value)} maxLength={500} disabled={busy} placeholder="供应商核查记录或处理结果" /><Button variant="outline" disabled={busy || !confirmed || note.trim().length < 6} onClick={() => void sync(true)}>登记采购未发生</Button></details>}
  </section>
}
