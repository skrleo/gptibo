-- USDT (TRC20) collection: snapshot the expected micro-USDT amount and the
-- CNY rate at payment creation so later env-rate changes never reinterpret
-- a pending order (same rule as delivery_supplier_orders.cny_per_usdt).
ALTER TABLE payments ADD COLUMN expected_raw INTEGER CHECK(expected_raw IS NULL OR expected_raw > 0);
ALTER TABLE payments ADD COLUMN cny_per_usdt REAL CHECK(cny_per_usdt IS NULL OR (cny_per_usdt > 0 AND cny_per_usdt <= 100));
