export const MANUAL_PRODUCTS = {
  'muse-ai-once': { productId: 'muse-ai', name: 'Muse AI' },
} as const

export type ManualPlan = keyof typeof MANUAL_PRODUCTS

export function manualProduct(plan: string) {
  return Object.hasOwn(MANUAL_PRODUCTS, plan) ? MANUAL_PRODUCTS[plan as ManualPlan] : null
}

export function isManualFulfillmentPlan(plan: string): plan is ManualPlan {
  return manualProduct(plan) !== null
}
