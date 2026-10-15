-- Security audit keeps short fingerprints only: no raw IPs, cookies, codes or bodies.
CREATE TABLE security_events (
  id TEXT PRIMARY KEY,
  time INTEGER NOT NULL,
  kind TEXT NOT NULL,
  ip TEXT NOT NULL,
  request_id TEXT NOT NULL,
  route TEXT NOT NULL,
  method TEXT NOT NULL,
  status INTEGER NOT NULL,
  role TEXT NOT NULL,
  account TEXT NOT NULL,
  session TEXT NOT NULL,
  target TEXT NOT NULL
);
CREATE INDEX security_events_time ON security_events(time);
-- At most one digest email per 15 minute window; rows double as the dedupe marker.
CREATE TABLE security_alerts (
  window_id INTEGER PRIMARY KEY,
  sent_at INTEGER NOT NULL,
  totals TEXT NOT NULL,
  routes TEXT NOT NULL
);
