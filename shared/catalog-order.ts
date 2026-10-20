import { DEFAULT_PRODUCT_ORDER, normalizeProductOrder, type StorefrontProductId } from './product-order.ts'

export type CatalogOrderSettings = {
  productIds: StorefrontProductId[]
  planIds: string[]
  version: number
}

export function normalizePlanOrder(saved: readonly string[] = [], known: readonly string[] = []): string[] {
  const knownIds = new Set(known)
  return [...new Set([...saved, ...known])].filter(id => knownIds.has(id))
}

export function validCatalogOrder(value: unknown, known: readonly string[]): value is string[] {
  return Array.isArray(value) && value.length === known.length && new Set(value).size === known.length && value.every(id => typeof id === 'string' && known.includes(id))
}

export function defaultCatalogOrder(planIds: readonly string[]): CatalogOrderSettings {
  return { productIds: [...DEFAULT_PRODUCT_ORDER], planIds: [...planIds], version: 0 }
}

export function normalizedCatalogOrder(productIds: readonly string[], planIds: readonly string[], knownPlanIds: readonly string[], version: number): CatalogOrderSettings {
  return { productIds: normalizeProductOrder(productIds), planIds: normalizePlanOrder(planIds, knownPlanIds), version }
}
