-- Per-task cron failure streaks so silent reconciliation stalls page someone.
CREATE TABLE cron_health (
  task TEXT PRIMARY KEY,
  fail_streak INTEGER NOT NULL DEFAULT 0,
  last_alert_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);
