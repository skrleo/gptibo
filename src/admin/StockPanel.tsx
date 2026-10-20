import { useResource } from '@/lib/use-resource'
import { Feedback } from '@/components/workspace-loading'
import { emailProduct, productNameForId, productNameForPlan } from '../../shared/email-products'

type StockRow = { plan: string; stock: number | null; available: boolean | null }
type StockGroup = { source: 'recharge' | 'delivery_supplier' | 'account_supplier'; rows: StockRow[]; configured: boolean; error?: string }
type StockSummary = { groups: StockGroup[]; threshold: number }

const SOURCE_LABELS = { recharge: '充值供应商', delivery_supplier: '自动发货供应商', account_supplier: 'Gmail 供应商' }
const planName = (plan: string) => emailProduct(plan) ? productNameForId(emailProduct(plan)!.productId) : productNameForPlan(plan)

function stockCell(row: StockRow, threshold: number) {
  if (row.available === false) return { text: row.stock === null ? '已关闭销售' : `剩余 ${row.stock}`, low: true }
  if (row.stock === null) return { text: row.available ? '可售' : '未知', low: false }
  return { text: `剩余 ${row.stock}`, low: row.stock <= threshold }
}

export function StockPanel({ revision }: { revision: number }) {
  const { data, error, loading } = useResource<StockSummary>('/api/admin/stock', revision)
  const configured = data?.groups.some(group => group.configured)
  return <section className="admin-panel">
    <div className="admin-panel-title"><h2>供应库存</h2><span>{data ? `库存不高于 ${data.threshold} 时自动发送飞书补货提醒` : '实时读取各供应商商品库存'}</span></div>
    <Feedback error={error} loading={loading} data={data} shape="compact" />
    {data && (configured ? <div className="admin-table-scroll"><table className="admin-table"><thead><tr><th>商品</th><th>供应商</th><th>库存</th><th>状态</th></tr></thead><tbody>
      {data.groups.filter(group => group.configured).map(group => group.rows.length ? group.rows.map(row => {
        const cell = stockCell(row, data.threshold)
        return <tr key={row.plan}><td>{planName(row.plan)}<small>{row.plan}</small></td><td>{SOURCE_LABELS[group.source]}</td><td className="admin-numeric">{cell.text}</td><td><span className={`admin-pill ${cell.low ? '' : 'available'}`}>{cell.low ? '库存偏低' : '库存充足'}</span></td></tr>
      }) : <tr key={group.source}><td colSpan={4}>该供应商暂无映射商品{group.error ? ` · ${group.error}` : ''}</td></tr>)}
    </tbody></table></div> : <p className="admin-panel-footnote">尚未配置任何供应商，库存来自供应商实时查询，接入后自动显示。</p>)}
  </section>
}
