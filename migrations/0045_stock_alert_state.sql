-- Single-row state so the per-minute cron can throttle supplier stock checks
-- and avoid repeating the same low-stock Feishu alert.
CREATE TABLE stock_alert_state (
  id TEXT PRIMARY KEY CHECK(id = 'state'),
  low_plans TEXT NOT NULL DEFAULT '',
  checked_at INTEGER NOT NULL DEFAULT 0,
  alerted_at INTEGER NOT NULL DEFAULT 0
);
