import type { AccountingReport } from '../../shared/accounting.ts'
import { styleSheets } from './plan-export'

const time = (ms: number) => new Date(ms).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
const nullable = (value: number | null, missing: string) => value === null ? missing : value / 100

export async function accountingWorkbook(report: AccountingReport) {
  const { default: ExcelJS } = await import('exceljs')
  const workbook = new ExcelJS.Workbook(); workbook.creator = 'Gift2Card'; workbook.created = new Date(report.asOf)
  const summary = workbook.addWorksheet('汇总')
  summary.addRow(['套餐', '单数', '已付款', '已完成', '付款金额（元）', '退款（元）', '完成采购成本（元）', '代理分成（元）', '已完成净利润（元）'])
  report.groups.forEach(group => summary.addRow([
    group.plan_name, group.order_count, group.paid_count, group.completed_count,
    group.paid_cents / 100, group.refund_cents / 100,
    group.missing_cost_count ? '待补成本' : group.cost_cents / 100,
    group.missing_commission_count ? '待核对' : group.commission_cents / 100,
    group.profit_cents === null ? '待核对' : group.profit_cents / 100,
  ]))
  const details = workbook.addWorksheet('订单明细')
  details.addRow(['订单编号', '下单时间（北京时间）', '套餐', '来源', '状态', '付款状态', '付款（元）', '退款（元）', '采购成本（元）', '代理分成（元）', '净利润（元）'])
  report.orders.forEach(order => {
    const completed = order.status === 'success' && order.payment_status === 'paid'
    details.addRow([
      order.id, time(order.created_at), order.plan_name, order.partner_name || '直营',
      order.status, order.payment_status === 'paid' ? '已付款' : '未付款',
      order.paid_cents / 100, order.refund_cents / 100,
      !completed ? '' : nullable(order.cost_cents, '待补成本'),
      !completed ? '' : nullable(order.commission_cents, '待核对'),
      !completed ? '' : nullable(order.profit_cents, '待核对'),
    ])
  })
  styleSheets(workbook)
  // All report data is stored as literal strings, never formulas.
  return new Uint8Array(await workbook.xlsx.writeBuffer())
}

export async function downloadAccountingReport(report: AccountingReport) {
  const buffer = await accountingWorkbook(report)
  const url = URL.createObjectURL(new Blob([buffer as BlobPart], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }))
  const link = document.createElement('a'); link.href = url; link.download = `订单利润分析-${new Date(report.asOf + 8 * 3600000).toISOString().slice(0, 10)}.xlsx`; link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
