export const MAIL_QUEUE_PRODUCTS = {
  'mail-queue-once': { productId: 'mail-queue', name: '邮件服务' },
} as const

export type MailQueuePlan = keyof typeof MAIL_QUEUE_PRODUCTS

export function mailQueueProduct(plan: string) {
  return Object.hasOwn(MAIL_QUEUE_PRODUCTS, plan) ? MAIL_QUEUE_PRODUCTS[plan as MailQueuePlan] : null
}

export function isMailQueuePlan(plan: string): plan is MailQueuePlan {
  return mailQueueProduct(plan) !== null
}

export const MAIL_QUEUE_PLAN_SQL = Object.keys(MAIL_QUEUE_PRODUCTS).map(plan => `'${plan}'`).join(',')
