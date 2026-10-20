import { useEffect, useMemo, useRef, useState } from 'react'
import { closestCenter, DndContext, KeyboardSensor, PointerSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core'
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { restrictToVerticalAxis } from '@dnd-kit/modifiers'
import { CSS } from '@dnd-kit/utilities'
import { Check, GripVertical, Save, Undo2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ProductMark } from '@/components/brand'
import { api, errorMessage, type CatalogPlan } from '@/lib/api'
import { Feedback } from '@/components/workspace-loading'
import { STOREFRONT_PRODUCTS, type StorefrontProductId } from '../../shared/product-order'
import type { CatalogOrderSettings } from '../../shared/catalog-order'

const productFor = (id: string) => STOREFRONT_PRODUCTS.find(product => product.id === id)!

function SortablePlan({ plan, position, locked }: { plan: CatalogPlan; position: number; locked: boolean }) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: plan.id, disabled: locked })
  return <li ref={setNodeRef} className="catalog-sort-plan" data-dragging={isDragging || undefined} style={{ transform: CSS.Transform.toString(transform), transition }}>
    <Button type="button" ref={setActivatorNodeRef} variant="ghost" size="icon" {...attributes} {...listeners} aria-label={`拖动排序 ${plan.name}`} disabled={locked}><GripVertical size={15} /></Button>
    <span>{String(position + 1).padStart(2, '0')}</span>
    <strong>{plan.name}</strong>
    <small>{plan.enabled ? '前台可购买' : '已暂停'}</small>
  </li>
}

function PlanSorter({ productId, plans, planIds, locked, onMove }: { productId: StorefrontProductId; plans: CatalogPlan[]; planIds: string[]; locked: boolean; onMove: (from: string, to: string) => void }) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }))
  const sorted = useMemo(() => {
    const positions = new Map(planIds.map((id, index) => [id, index]))
    return [...plans].sort((a, b) => (positions.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (positions.get(b.id) ?? Number.MAX_SAFE_INTEGER))
  }, [plans, planIds])
  if (!sorted.length) return <p className="catalog-sort-empty">暂无套餐，可先保留商品展示位置。</p>
  const move = ({ active, over }: DragEndEvent) => {
    if (!locked && over && active.id !== over.id) onMove(String(active.id), String(over.id))
  }
  return <DndContext sensors={sensors} collisionDetection={closestCenter} modifiers={[restrictToVerticalAxis]} onDragEnd={move} accessibility={{
    screenReaderInstructions: { draggable: '按空格键开始拖动，使用上下方向键调整套餐顺序，再按空格键放下。' },
  }}>
    <SortableContext items={sorted.map(plan => plan.id)} strategy={verticalListSortingStrategy}>
      <ol className="catalog-sort-plans" aria-label={`${productFor(productId).name} 套餐顺序`}>{sorted.map((plan, index) => <SortablePlan key={plan.id} plan={plan} position={index} locked={locked} />)}</ol>
    </SortableContext>
  </DndContext>
}

function SortableProduct({ id, position, plans, planIds, locked, onMovePlan }: { id: StorefrontProductId; position: number; plans: CatalogPlan[]; planIds: string[]; locked: boolean; onMovePlan: (productId: StorefrontProductId, from: string, to: string) => void }) {
  const product = productFor(id)
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id, disabled: locked })
  return <li ref={setNodeRef} className="catalog-sort-product" data-dragging={isDragging || undefined} style={{ transform: CSS.Transform.toString(transform), transition }}>
    <div className="catalog-sort-product-head">
      <Button type="button" ref={setActivatorNodeRef} variant="ghost" size="icon" {...attributes} {...listeners} aria-label={`拖动排序 ${product.name}`} disabled={locked}><GripVertical size={18} /></Button>
      <span className="catalog-sort-position">{String(position + 1).padStart(2, '0')}</span>
      <ProductMark small productId={id} />
      <div><strong>{product.name}</strong><small>{plans.length ? `${plans.length} 个套餐` : '暂无套餐'}</small></div>
    </div>
    <PlanSorter productId={id} plans={plans} planIds={planIds} locked={locked} onMove={(from, to) => onMovePlan(id, from, to)} />
  </li>
}

function flattenedPlanIds(productIds: readonly StorefrontProductId[], planIds: readonly string[], plans: readonly CatalogPlan[]) {
  const positions = new Map(planIds.map((id, index) => [id, index]))
  return productIds.flatMap(productId => plans.filter(plan => plan.product_id === productId).sort((a, b) => (positions.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (positions.get(b.id) ?? Number.MAX_SAFE_INTEGER)).map(plan => plan.id))
}

export function CatalogOrderEditor({ settings, plans, disabled, onSaved }: { settings: CatalogOrderSettings; plans: CatalogPlan[]; disabled: boolean; onSaved: () => void }) {
  const [saved, setSaved] = useState(settings)
  const [productIds, setProductIds] = useState(settings.productIds)
  const [planIds, setPlanIds] = useState(settings.planIds)
  const [activeId, setActiveId] = useState<StorefrontProductId | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const submitting = useRef(false)
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }))
  const changed = productIds.join(',') !== saved.productIds.join(',') || planIds.join(',') !== saved.planIds.join(',')
  const locked = disabled || busy

  useEffect(() => {
    if (!changed) return
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [changed])

  const moveProduct = ({ active, over }: DragEndEvent) => {
    setActiveId(null)
    if (locked || !over || active.id === over.id) return
    const from = productIds.indexOf(active.id as StorefrontProductId), to = productIds.indexOf(over.id as StorefrontProductId)
    if (from < 0 || to < 0) return
    setProductIds(arrayMove(productIds, from, to)); setError(''); setMessage(`${productFor(String(active.id)).name} 已移至第 ${to + 1} 位，保存后生效。`)
  }
  const movePlan = (productId: StorefrontProductId, fromId: string, toId: string) => {
    const group = flattenedPlanIds([productId], planIds, plans)
    const from = group.indexOf(fromId), to = group.indexOf(toId)
    if (from < 0 || to < 0) return
    const moved = arrayMove(group, from, to)
    const next = [...planIds]
    const positions = group.map(id => next.indexOf(id)).filter(index => index >= 0).sort((a, b) => a - b)
    positions.forEach((position, index) => { next[position] = moved[index] })
    setPlanIds(next); setError(''); setMessage(`${plans.find(plan => plan.id === fromId)?.name ?? fromId} 已调整，保存后生效。`)
  }
  const undo = () => { setProductIds(saved.productIds); setPlanIds(saved.planIds); setError(''); setMessage('已撤销本次排序调整。') }
  const save = async () => {
    if (locked || submitting.current || !changed || activeId) return
    submitting.current = true; setBusy(true); setError(''); setMessage('')
    try {
      const result = await api<CatalogOrderSettings>('/api/admin/catalog-order', { productIds, planIds, version: saved.version })
      setSaved(result); setProductIds(result.productIds); setPlanIds(result.planIds); setMessage('商品与套餐顺序已保存并同步前台。'); onSaved()
    } catch (e) { setError(errorMessage(e)) }
    finally { submitting.current = false; setBusy(false) }
  }

  return <section className="admin-panel catalog-sort-panel" aria-busy={busy}>
    <div className="admin-panel-title"><div><h2>前台展示排序</h2><p>拖动商品调整整体顺序，拖动套餐调整商品内的套餐顺序。</p></div><span className={changed ? 'catalog-sort-dirty' : undefined}>{changed ? '有未保存调整' : '已同步'}</span></div>
    <DndContext sensors={sensors} collisionDetection={closestCenter} modifiers={[restrictToVerticalAxis]} onDragStart={({ active }) => { setActiveId(active.id as StorefrontProductId); setMessage('') }} onDragEnd={moveProduct} onDragCancel={() => setActiveId(null)} accessibility={{
      screenReaderInstructions: { draggable: '按空格键开始拖动，使用上下方向键调整商品顺序，再按空格键放下。' },
    }}>
      <SortableContext items={productIds} strategy={verticalListSortingStrategy}>
        <ol className="catalog-sort-products" aria-label="前台商品与套餐展示顺序">{productIds.map((id, index) => <SortableProduct key={id} id={id} position={index} plans={plans.filter(plan => plan.product_id === id)} planIds={planIds} locked={locked} onMovePlan={movePlan} />)}</ol>
      </SortableContext>
    </DndContext>
    <div className="catalog-sort-footer"><div><Feedback error={error} /><p role="status">{message || '排序只影响前台展示，不改变价格、上下架状态和已有订单。'}{!error && message.startsWith('商品与套餐顺序已保存') && <Check size={14} />}</p></div><div>{changed && <Button type="button" variant="ghost" disabled={locked || Boolean(activeId)} onClick={undo}><Undo2 size={15} />撤销</Button>}<Button type="button" disabled={locked || !changed || Boolean(activeId)} onClick={() => void save()}><Save size={15} />{busy ? '保存中…' : '保存排序'}</Button></div></div>
  </section>
}
