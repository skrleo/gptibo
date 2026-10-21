-- Admin-configured catalog display order for products and plans, mirroring the
-- Workers migration 0053. Absent row = every plan keeps its sort_order default.
CREATE TABLE catalog_order (
  id integer PRIMARY KEY CHECK (id = 1),
  product_ids text[] NOT NULL,
  plan_ids text[] NOT NULL,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  change_id text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
