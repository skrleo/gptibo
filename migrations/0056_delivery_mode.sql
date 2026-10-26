-- Per-plan fulfillment switch: 'auto' keeps the configured supplier flow,
-- 'manual' sends new orders to the staff-assisted workflow (no procurement
-- snapshot is taken at order time, so the order never auto-purchases).
ALTER TABLE catalog_plans ADD COLUMN delivery_mode TEXT NOT NULL DEFAULT 'auto' CHECK(delivery_mode IN ('auto','manual'));
