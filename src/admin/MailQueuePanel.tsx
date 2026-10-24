import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Feedback } from '@/components/workspace-loading'
import { api, errorMessage } from '@/lib/api'
import { useResource } from '@/lib/use-resource'

type Sender = { id: number; label: string; from_email: string; from_name: string; enabled: number; sort_order: number; sent_count: number; key_length: number; updated_at: number; version: number }
type Settings = { subject: string; body: string; duration_minutes: number; version: number }
type Task = { id: string; order_id: string; status: 'queued' | 'sending' | 'done' | 'failed' | 'cancelled'; total_steps: number; done_steps: number; failed_steps: number; next_run_at: number; created_at: number; updated_at: number; last_error: string | null; customer_email: string | null; order_status: string; payment_status: string; refund_hold: number; refunded_cents: number }
type QueueData = { senders: Sender[]; settings: Settings | null; tasks: Task[] }

const time = (value: number) => new Date(value).toLocaleString('zh-CN', { hour12: false })
const TASK_LABELS: Record<Task['status'], string> = { queued: '排队中', sending: '发送中', done: '已完成', failed: '发送失败', cancelled: '已取消' }
const TASK_STATES: Record<Task['status'], string> = { queued: '', sending: 'available', done: 'available', failed: 'unavailable', cancelled: '' }

export function MailQueuePanel({ revision, onUpdated }: { revision: number; onUpdated: () => void }) {
  const resource = useResource<QueueData>('/api/admin/mail-queue', revision)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [form, setForm] = useState({ label: '', fromEmail: '', fromName: '', apiKey: '', sortOrder: 0 })
  const [edit, setEdit] = useState<Sender | null>(null)
  const [template, setTemplate] = useState<Settings | null>(null)
  async function call(action: () => Promise<unknown>, done: string) {
    if (busy) return
    setBusy(true); setError(''); setNotice('')
    try { await action(); setNotice(done); setEdit(null); setTemplate(null); onUpdated() }
    catch (e) { setError(errorMessage(e)) }
    finally { setBusy(false) }
  }
  const senders = resource.data?.senders ?? []
  const settings = resource.data?.settings ?? null
  return <section className="admin-panel" aria-label="邮件队列服务">
    <div className="admin-panel-title"><div><h2>邮件队列服务</h2><p>付款确认后自动创建队列任务，发件邮箱池按服务时长向客户下单邮箱陆续发送。</p></div></div>
    <Feedback error={error || resource.error} loading={resource.loading} data={resource.data} shape="compact" />
    {notice && <p className="admin-success" role="status">{notice}</p>}
    {settings && (template ? <form className="admin-edit-form" onSubmit={e => { e.preventDefault(); void call(() => api('/api/admin/mail-queue/settings', { version: settings.version, subject: template.subject, body: template.body, durationMinutes: template.duration_minutes }), '队列配置已更新') }}>
      <h3>编辑模板与节奏</h3>
      <label htmlFor="mail-queue-subject">邮件主题（占位符 {'{order} {email} {sender} {index} {total}'}）</label>
      <Input id="mail-queue-subject" value={template.subject} onChange={e => setTemplate({ ...template, subject: e.target.value })} maxLength={200} disabled={busy} />
      <label htmlFor="mail-queue-body">邮件正文</label>
      <textarea id="mail-queue-body" rows={6} value={template.body} onChange={e => setTemplate({ ...template, body: e.target.value })} maxLength={2000} disabled={busy} />
      <label htmlFor="mail-queue-duration">服务时长（分钟，1–60）</label>
      <Input id="mail-queue-duration" type="number" min={1} max={60} value={template.duration_minutes} onChange={e => setTemplate({ ...template, duration_minutes: Number(e.target.value) })} disabled={busy} />
      <Button type="submit" disabled={busy || !template.subject.trim() || !template.body.trim()}>保存配置</Button>
      <Button type="button" variant="outline" disabled={busy} onClick={() => setTemplate(null)}>取消</Button>
    </form> : <div className="admin-edit-form">
      <h3>当前配置</h3>
      <p className="admin-subtle">服务时长 {settings.duration_minutes} 分钟 · 新任务创建时快照当前模板，修改不影响进行中的任务。</p>
      <p className="admin-subtle" style={{ whiteSpace: 'pre-wrap' }}>主题：{settings.subject}<br />正文：{settings.body}</p>
      <Button variant="outline" disabled={busy} onClick={() => setTemplate(settings)}>编辑模板与节奏</Button>
    </div>)}
    <h3>发件邮箱池（{senders.filter(s => s.enabled).length} 启用 / {senders.length} 总数）</h3>
    {senders.length > 0 && <div className="admin-table-scroll"><table className="admin-table"><thead><tr><th>名称</th><th>发件地址</th><th>状态</th><th>已发送</th><th>排序</th><th>更新时间</th><th /></tr></thead><tbody>
      {senders.map(sender => <tr key={sender.id}>
        <td>{sender.label}</td>
        <td>{sender.from_name ? `${sender.from_name} ` : ''}{sender.from_email}{sender.key_length > 0 ? ' · 独立密钥' : ''}</td>
        <td><span className={`admin-pill ${sender.enabled ? 'available' : ''}`}>{sender.enabled ? '启用' : '停用'}</span></td>
        <td className="admin-numeric">{sender.sent_count}</td>
        <td className="admin-numeric">{sender.sort_order}</td>
        <td>{time(sender.updated_at)}</td>
        <td className="admin-actions">
          <Button variant="outline" disabled={busy} onClick={() => void call(() => api('/api/admin/mail-queue/senders', { action: 'test', id: sender.id }), '测试邮件已提交，请查收管理员邮箱')}>测试</Button>
          <Button variant="outline" disabled={busy} onClick={() => void call(() => api('/api/admin/mail-queue/senders', { action: 'toggle', id: sender.id, enabled: !sender.enabled, version: sender.version }), sender.enabled ? '已停用' : '已启用')}>{sender.enabled ? '停用' : '启用'}</Button>
          <Button variant="outline" disabled={busy} onClick={() => setEdit(sender)}>编辑</Button>
          {!sender.sent_count && <Button variant="outline" disabled={busy} onClick={() => void call(() => api('/api/admin/mail-queue/senders', { action: 'delete', id: sender.id, version: sender.version }), '发件邮箱已删除')}>删除</Button>}
        </td>
      </tr>)}
    </tbody></table></div>}
    {edit ? <form className="admin-edit-form" onSubmit={e => { e.preventDefault(); void call(() => api('/api/admin/mail-queue/senders', { action: 'update', id: edit.id, version: edit.version, label: form.label, fromEmail: form.fromEmail, fromName: form.fromName, apiKey: form.apiKey, sortOrder: form.sortOrder }), '发件邮箱已更新') }}>
      <h3>编辑发件邮箱</h3>
      <label htmlFor="sender-label">名称</label>
      <Input id="sender-label" value={form.label} onChange={e => setForm({ ...form, label: e.target.value })} maxLength={60} disabled={busy} />
      <label htmlFor="sender-email">发件地址</label>
      <Input id="sender-email" value={form.fromEmail} onChange={e => setForm({ ...form, fromEmail: e.target.value })} maxLength={254} disabled={busy} />
      <label htmlFor="sender-name">发件人名称（可选）</label>
      <Input id="sender-name" value={form.fromName} onChange={e => setForm({ ...form, fromName: e.target.value })} maxLength={60} disabled={busy} />
      <label htmlFor="sender-key">独立 API 密钥（留空保持现值，清空请输入空格后删除）</label>
      <Input id="sender-key" value={form.apiKey} onChange={e => setForm({ ...form, apiKey: e.target.value })} maxLength={200} disabled={busy} placeholder="留空 = 使用平台邮件服务密钥" />
      <label htmlFor="sender-order">排序值（小的排前）</label>
      <Input id="sender-order" type="number" min={0} value={form.sortOrder} onChange={e => setForm({ ...form, sortOrder: Number(e.target.value) })} disabled={busy} />
      <Button type="submit" disabled={busy || !form.label.trim() || !form.fromEmail.includes('@')}>保存</Button>
      <Button type="button" variant="outline" disabled={busy} onClick={() => setEdit(null)}>取消</Button>
    </form> : <form className="admin-edit-form" onSubmit={e => { e.preventDefault(); void call(() => api('/api/admin/mail-queue/senders', { action: 'create', label: form.label, fromEmail: form.fromEmail, fromName: form.fromName, apiKey: form.apiKey, sortOrder: form.sortOrder }).then(() => setForm({ label: '', fromEmail: '', fromName: '', apiKey: '', sortOrder: senders.length })), '发件邮箱已新增') }}>
      <h3>新增发件邮箱</h3>
      <label htmlFor="new-sender-label">名称</label>
      <Input id="new-sender-label" value={form.label} onChange={e => setForm({ ...form, label: e.target.value })} maxLength={60} disabled={busy} placeholder="例如：通知邮箱 A" />
      <label htmlFor="new-sender-email">发件地址</label>
      <Input id="new-sender-email" value={form.fromEmail} onChange={e => setForm({ ...form, fromEmail: e.target.value })} maxLength={254} disabled={busy} placeholder="noreply@example.com" />
      <label htmlFor="new-sender-name">发件人名称（可选）</label>
      <Input id="new-sender-name" value={form.fromName} onChange={e => setForm({ ...form, fromName: e.target.value })} maxLength={60} disabled={busy} />
      <label htmlFor="new-sender-key">独立 API 密钥（可选）</label>
      <Input id="new-sender-key" value={form.apiKey} onChange={e => setForm({ ...form, apiKey: e.target.value })} maxLength={200} disabled={busy} placeholder="留空 = 使用平台邮件服务密钥" />
      <label htmlFor="new-sender-order">排序值（小的排前）</label>
      <Input id="new-sender-order" type="number" min={0} value={form.sortOrder} onChange={e => setForm({ ...form, sortOrder: Number(e.target.value) })} disabled={busy} />
      <Button type="submit" disabled={busy || !form.label.trim() || !form.fromEmail.includes('@')}>新增</Button>
    </form>}
    <h3>队列任务（最近 {resource.data?.tasks.length ?? 0} 条）</h3>
    {(resource.data?.tasks.length ?? 0) > 0 ? <div className="admin-table-scroll"><table className="admin-table"><thead><tr><th>订单</th><th>客户邮箱</th><th>状态</th><th>进度</th><th>下次执行</th><th>更新时间</th><th /></tr></thead><tbody>
      {resource.data!.tasks.map(task => <tr key={task.id}>
        <td>{task.order_id}</td>
        <td>{task.customer_email}</td>
        <td><span className={`admin-pill ${TASK_STATES[task.status]}`}>{TASK_LABELS[task.status]}</span></td>
        <td className="admin-numeric">{task.done_steps}/{task.total_steps}{task.failed_steps > 0 ? `（${task.failed_steps} 失败）` : ''}</td>
        <td>{['queued', 'sending'].includes(task.status) ? time(task.next_run_at) : '—'}</td>
        <td>{time(task.updated_at)}{task.last_error ? ` · ${task.last_error}` : ''}</td>
        <td className="admin-actions">
          {['queued', 'sending'].includes(task.status) && <Button variant="outline" disabled={busy} onClick={() => void call(() => api(`/api/admin/mail-queue/tasks/${task.id}`, { action: 'cancel' }), '队列任务已取消')}>取消</Button>}
          {['failed', 'cancelled', 'done'].includes(task.status) && (task.failed_steps > 0 || task.status === 'cancelled') && <Button variant="outline" disabled={busy} onClick={() => void call(() => api(`/api/admin/mail-queue/tasks/${task.id}`, { action: 'retry' }), task.status === 'cancelled' ? '队列任务已恢复' : '失败步骤已重试')}>重试</Button>}
        </td>
      </tr>)}
    </tbody></table></div> : <p className="admin-subtle">暂无队列任务；有付款的邮件服务订单会出现在这里。</p>}
    <p className="admin-panel-footnote">队列由每分钟的系统任务驱动：任务创建后按服务时长平摊发送节奏，单个发件邮箱连续 3 次失败后跳过，订单退款或暂停兑换时任务自动取消。</p>
  </section>
}
