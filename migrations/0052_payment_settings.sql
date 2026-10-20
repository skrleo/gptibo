-- Admin-selected checkout channels. Absent row = every configured channel is offered.
CREATE TABLE payment_settings (
  id INTEGER PRIMARY KEY CHECK(id=1),
  providers TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL DEFAULT 0
);
