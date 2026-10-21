package management

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
	"gptibo/storefront/internal/auth"
	"gptibo/storefront/internal/catalog"
	"gptibo/storefront/internal/fault"
	"gptibo/storefront/internal/security"
)

// Admin-configured catalog display order, the Go twin of the Worker's
// /api/admin/catalog-order. The single row carries an explicit version for
// optimistic concurrency; plans missing from a saved order fall back to
// sort_order on the storefront read side.

func normalizeOrder(saved, known []string) []string {
	ok := map[string]bool{}
	for _, id := range known {
		ok[id] = true
	}
	seen := map[string]bool{}
	out := []string{}
	for _, id := range append(append([]string{}, saved...), known...) {
		if ok[id] && !seen[id] {
			out = append(out, id)
			seen[id] = true
		}
	}
	return out
}

// permutation requires an exact reorder of the known list, matching the
// Worker's validCatalogOrder: same length, no duplicates, nothing dropped.
func permutation(values, known []string) bool {
	if len(values) != len(known) {
		return false
	}
	remaining := map[string]bool{}
	for _, id := range known {
		remaining[id] = true
	}
	for _, id := range values {
		if !remaining[id] {
			return false
		}
		delete(remaining, id)
	}
	return true
}

func (s Service) CatalogOrder(ctx context.Context) (map[string]any, error) {
	tx, e := s.Store.DB.BeginTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly})
	if e != nil {
		return nil, e
	}
	defer tx.Rollback(ctx)
	out, e := s.catalogOrder(ctx, tx)
	if e != nil {
		return nil, e
	}
	return out, tx.Commit(ctx)
}

func (s Service) catalogOrder(ctx context.Context, tx pgx.Tx) (map[string]any, error) {
	known, e := knownPlanIds(ctx, tx)
	if e != nil {
		return nil, e
	}
	var productIds, planIds []string
	var version int64
	e = tx.QueryRow(ctx, `SELECT product_ids,plan_ids,version FROM catalog_order WHERE id=1`).Scan(&productIds, &planIds, &version)
	if errors.Is(e, pgx.ErrNoRows) {
		return map[string]any{"productIds": catalog.KnownProducts(), "planIds": known, "version": 0}, nil
	}
	if e != nil {
		return nil, e
	}
	return map[string]any{"productIds": catalog.NormalizeProductOrder(productIds), "planIds": normalizeOrder(planIds, known), "version": version}, nil
}

func knownPlanIds(ctx context.Context, tx pgx.Tx) ([]string, error) {
	idRows, e := tx.Query(ctx, `SELECT id FROM catalog_plans ORDER BY sort_order,id`)
	if e != nil {
		return nil, e
	}
	defer idRows.Close()
	known := []string{}
	for idRows.Next() {
		var id string
		if e := idRows.Scan(&id); e != nil {
			return nil, e
		}
		known = append(known, id)
	}
	return known, idRows.Err()
}

func (s Service) SaveCatalogOrder(ctx context.Context, token string, productIds, planIds []string, version int64) (map[string]any, error) {
	if version < 0 {
		return nil, fault.New(400, "排序版本无效，请刷新重试。")
	}
	if !permutation(productIds, catalog.KnownProducts()) {
		return nil, fault.New(400, "商品列表无效，请刷新后重新排序。")
	}
	e := s.write(ctx, "admin", token, func(tx pgx.Tx, p auth.Principal) error {
		known, e := knownPlanIds(ctx, tx)
		if e != nil {
			return e
		}
		if !permutation(planIds, known) {
			return fault.New(400, "套餐列表无效，请刷新后重新排序。")
		}
		tag, e := tx.Exec(ctx, `INSERT INTO catalog_order(id,product_ids,plan_ids,version,change_id,updated_at)
			SELECT 1,$1,$2,1,$3,now() WHERE COALESCE((SELECT version FROM catalog_order WHERE id=1),0)=$4
			ON CONFLICT(id) DO UPDATE SET product_ids=EXCLUDED.product_ids,plan_ids=EXCLUDED.plan_ids,version=catalog_order.version+1,change_id=EXCLUDED.change_id,updated_at=now()
			WHERE catalog_order.version=$4`, productIds, planIds, security.ID(), version)
		if e != nil {
			return e
		}
		if tag.RowsAffected() == 0 {
			return conflict()
		}
		return audit(ctx, tx, p, "catalog-order", "catalog", map[string]any{"note": p.Subject + ": 调整商品与套餐展示顺序"})
	})
	if e != nil {
		return nil, e
	}
	return s.CatalogOrder(ctx)
}
