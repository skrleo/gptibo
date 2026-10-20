import type { Workbook } from 'exceljs'
import type { CatalogPlan } from './api'

export type PlanImportRow = { id: string; productId?: string; name?: string; priceCents?: number; enabled?: boolean; renewalOnly?: boolean; partnerEnabled?: boolean; purchaseNote?: string; deliveryInstructions?: string }

const HEADERS = ['商品编号', '产品', '套餐名称', '售价（元）', '允许购买', '仅续费', '开放代理销售', '购买说明', '默认领取说明']

const styleSheets = (workbook: Workbook) => {
  for (const sheet of workbook.worksheets) {
    sheet.views = [{ state: 'frozen', ySplit: 1 }]
    sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: sheet.rowCount, column: sheet.columnCount } }
    sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } }
    sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF126BDE' } }
    sheet.getRow(1).height = 26
    sheet.columns.forEach((column, i) => { column.width = i === 0 ? 24 : i >= 7 ? 48 : 16; column.alignment = { vertical: 'top', wrapText: true } })
  }
}

export async function plansWorkbook(plans: CatalogPlan[]) {
  const { default: ExcelJS } = await import('exceljs')
  const workbook = new ExcelJS.Workbook(); workbook.creator = 'GPTibo'; workbook.created = new Date()
  const sheet = workbook.addWorksheet('商品套餐')
  sheet.addRow(HEADERS)
  plans.forEach(plan => sheet.addRow([plan.id, plan.product_id, plan.name, plan.price_cents / 100, plan.enabled ? 1 : 0, plan.renewal_only ? 1 : 0, plan.partner_enabled === 0 ? 0 : 1, plan.purchase_note ?? '', plan.delivery_instructions ?? '']))
  styleSheets(workbook)
  sheet.getColumn(4).numFmt = '0.00'
  // All plan data is stored as literal strings, never formulas.
  return new Uint8Array(await workbook.xlsx.writeBuffer())
}

export async function downloadPlans(plans: CatalogPlan[]) {
  const buffer = await plansWorkbook(plans)
  const url = URL.createObjectURL(new Blob([buffer as BlobPart], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }))
  const link = document.createElement('a'); link.href = url; link.download = `商品套餐-${new Date().toISOString().slice(0, 10)}.xlsx`; link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

const bool = (value: unknown) => value === true || value === 1 || value === '1' || value === '是' ? true : value === false || value === 0 || value === '0' || value === '否' ? false : undefined

export async function readPlansWorkbook(file: File): Promise<PlanImportRow[]> {
  const { default: ExcelJS } = await import('exceljs')
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(await file.arrayBuffer())
  const sheet = workbook.worksheets[0]
  if (!sheet) throw new Error('表格中没有工作表。')
  const header = sheet.getRow(1)
  const columns = new Map(HEADERS.map(name => {
    const found = [1, 2, 3, 4, 5, 6, 7, 8, 9].map(column => header.getCell(column)).findIndex(cell => String(cell.value ?? '').trim() === name)
    return [name, found >= 0 ? found + 1 : 0]
  }))
  if (!columns.get('商品编号')) throw new Error('表格缺少「商品编号」列，请使用后台导出的模板。')
  const rows: PlanImportRow[] = []
  sheet.eachRow((row, number) => {
    if (number === 1) return
    const cell = (name: string) => columns.get(name) ? row.getCell(columns.get(name)!) : null
    const value = (name: string) => cell(name)?.value
    const id = String(value('商品编号') ?? '').trim()
    if (!id) return
    const price = value('售价（元）')
    const note = (name: string) => { const text = String(value(name) ?? '').trim(); return text || undefined }
    rows.push({
      id,
      productId: value('产品') ? String(value('产品')).trim() : undefined,
      name: value('套餐名称') ? String(value('套餐名称')).trim() : undefined,
      priceCents: price === null || price === undefined || price === '' ? undefined : Math.round(Number(price) * 100),
      enabled: bool(value('允许购买')),
      renewalOnly: bool(value('仅续费')),
      partnerEnabled: bool(value('开放代理销售')),
      purchaseNote: note('购买说明'),
      deliveryInstructions: note('默认领取说明'),
    })
  })
  return rows
}
