-- Custom domains for partner storefronts (Cloudflare for SaaS); one binding per
-- partner. State mirrors the customer-facing setup: pending_dns,
-- pending_certificate, active, error, deleting.
CREATE TABLE partner_domains (
  id TEXT PRIMARY KEY,
  partner_id TEXT NOT NULL UNIQUE REFERENCES partners(id),
  hostname TEXT NOT NULL UNIQUE,
  apex INTEGER NOT NULL DEFAULT 0 CHECK(apex IN (0,1)),
  state TEXT NOT NULL DEFAULT 'pending_dns' CHECK(state IN ('pending_dns','pending_certificate','active','error','deleting')),
  message TEXT NOT NULL DEFAULT '',
  verification TEXT NOT NULL,
  provider_id TEXT,
  provider_records TEXT NOT NULL DEFAULT '[]',
  checked_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX partner_domains_checked ON partner_domains(checked_at);
