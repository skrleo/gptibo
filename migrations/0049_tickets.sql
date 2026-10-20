-- Partner order tickets with a symmetric admin/partner surface:
-- creation is idempotent per (partner, key), replies per (ticket, key),
-- and every reply bumps tickets.version for optimistic concurrency.
CREATE TABLE tickets (
  id TEXT PRIMARY KEY,
  partner_id TEXT NOT NULL REFERENCES partners(id),
  order_id TEXT NOT NULL,
  subject TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','processing','waiting','resolved')),
  version INTEGER NOT NULL DEFAULT 1,
  idempotency_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(partner_id, idempotency_key)
);
CREATE INDEX tickets_partner_updated ON tickets(partner_id, updated_at DESC);
CREATE INDEX tickets_updated ON tickets(updated_at DESC);
CREATE TABLE ticket_events (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL REFERENCES tickets(id),
  actor_role TEXT NOT NULL CHECK(actor_role IN ('admin','partner')),
  body TEXT NOT NULL,
  status TEXT NOT NULL,
  request_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(ticket_id, request_key)
);
CREATE INDEX ticket_events_ticket ON ticket_events(ticket_id, created_at);
