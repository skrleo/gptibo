CREATE TABLE catalog_order (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  product_ids TEXT NOT NULL,
  plan_ids TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  change_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
