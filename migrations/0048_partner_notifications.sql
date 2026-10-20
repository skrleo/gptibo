-- Partner notification preferences plus the delivery queue for the
-- order-completed email, mirroring the recharge_reminders retry shape.
CREATE TABLE partner_settings (
  partner_id TEXT PRIMARY KEY REFERENCES partners(id),
  order_completed_email INTEGER NOT NULL DEFAULT 0 CHECK(order_completed_email IN (0,1)),
  version INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE partner_order_emails (
  order_id TEXT PRIMARY KEY REFERENCES orders(id),
  first_attempt_at INTEGER,
  delivered_at INTEGER,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER NOT NULL DEFAULT 0,
  lock_token TEXT NOT NULL DEFAULT ''
);
CREATE INDEX partner_order_emails_next ON partner_order_emails(next_attempt_at);
