import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Feedback } from '@/components/workspace-loading'
import { api, errorMessage } from '@/lib/api'
import { useResource } from '@/lib/use-resource'
import { weightedLength } from '../../shared/x-post'

type SocialPost = { id: string; content: string; tweet_id: string | null; source: 'daily' | 'manual'; created_at: number }
type SocialSettings = { configured: boolean; autoDaily: boolean; posts: SocialPost[] }

function time(value: number) { return new Date(value).toLocaleString('zh-CN', { hour12: false }) }

export function XSocialPanel({ revision }: { revision: number }) {
  const [refresh, setRefresh] = useState(0)
  const { data, error, loading } = useResource<SocialSettings>('/api/admin/x-social', revision + refresh)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [message, setMessage] = useState('')
  const remaining = 280 - weightedLength(text)
  const publish = async () => {
    setBusy(true); setSaveError(''); setMessage('')
    try {
      await api('/api/admin/x-social', { text })
      setMessage('已发布到 X。'); setText(''); setRefresh(v => v + 1)
    } catch (caught) { setSaveError(errorMessage(caught)) } finally { setBusy(false) }
  }
  return (
    <section className="admin-panel">
      <div className="admin-panel-title"><h2>X 帖子</h2><span>{data?.autoDaily ? '每日促销帖已开启' : '每日促销帖未开启'}</span></div>
      <Feedback error={error} loading={loading} data={data} shape="compact" />
      {data && !data.configured && <p className="admin-panel-footnote">尚未配置 X API 凭据。在 developer.x.com 免费层创建应用并生成令牌后，依次执行 wrangler secret put X_API_KEY、X_API_SECRET、X_ACCESS_TOKEN、X_ACCESS_TOKEN_SECRET 即可发布。</p>}
      {data && data.configured && <>
        <textarea value={text} onChange={event => setText(event.target.value)} placeholder="写点想发布的内容，例如促销、上新公告…" style={{ width: '100%', minHeight: 96, padding: '10px 12px', borderRadius: 10, border: '1px solid var(--border, #ddd)', font: 'inherit' }} />
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 8 }}>
          <small style={{ color: remaining < 0 ? 'crimson' : 'inherit' }}>{remaining < 0 ? `超出 ${-remaining} 个字符` : `还可输入 ${remaining} 个字符`}</small>
          <Button disabled={busy || !text.trim() || remaining < 0} onClick={() => void publish()}>发布</Button>
        </div>
      </>}
      {message && <p className="admin-success" role="status">{message}</p>}
      <Feedback error={saveError} />
      <p className="admin-panel-footnote">{data?.autoDaily ? '每天上午 10 点后自动发布一条在售商品精选，同一天不会重复。' : '开启每日促销帖：在 wrangler.jsonc 将 X_POST_AUTO_DAILY 设为 true 并部署，每天自动发布一条在售商品精选。'}</p>
      <div className="admin-audit-list">
        {data?.posts.length ? data.posts.map(post => <div key={post.id}><strong>{post.source === 'daily' ? '自动促销' : '手动发布'}</strong><span>{post.content}</span><time>{time(post.created_at)}</time>{post.tweet_id && <a href={`https://x.com/i/web/status/${post.tweet_id}`} target="_blank" rel="noreferrer">查看</a>}</div>) : data ? <p>还没有发布记录。</p> : null}
      </div>
    </section>
  )
}
