-- Per-task cron failure streaks so silent reconciliation stalls page someone,
-- mirroring the Workers migration 0051. Timestamps are millisecond epochs.
CREATE TABLE cron_health (
  task text PRIMARY KEY,
  fail_streak integer NOT NULL DEFAULT 0,
  last_alert_at bigint NOT NULL DEFAULT 0,
  updated_at bigint NOT NULL DEFAULT 0
);
