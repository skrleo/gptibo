package worker

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"gptibo/storefront/internal/store"
)

// Cron jobs fail into the log today, so a stalled reconciliation is invisible
// until a customer complains. Count consecutive failures per task and page the
// shared Feishu bot once a stall is real: alert after alertAfter consecutive
// failures, re-alert every reralert window while it stays broken, and announce
// recovery when it comes back. Mirrors worker/cron-health.ts on the Workers side.
const (
	alertAfter = 3
	reralert   = 6 * time.Hour
)

type Alerter interface {
	Alert(ctx context.Context, key, text string) error
}

type Health struct {
	Store  *store.Store
	Sender Alerter
}

func (h *Health) Failure(ctx context.Context, task string) {
	if h == nil || ctx.Err() != nil {
		return
	}
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	now := time.Now().UnixMilli()
	if _, e := h.Store.DB.Exec(ctx, `INSERT INTO cron_health(task,fail_streak,updated_at) VALUES($1,1,$2)
		ON CONFLICT(task) DO UPDATE SET fail_streak=cron_health.fail_streak+1,updated_at=EXCLUDED.updated_at`, task, now); e != nil {
		return
	}
	var streak, lastAlert int64
	if e := h.Store.DB.QueryRow(ctx, `SELECT fail_streak,last_alert_at FROM cron_health WHERE task=$1`, task).Scan(&streak, &lastAlert); e != nil || streak < alertAfter || now-lastAlert < reralert.Milliseconds() {
		return
	}
	// Claim the alert window before sending so overlapping runs cannot double-page.
	tag, e := h.Store.DB.Exec(ctx, `UPDATE cron_health SET last_alert_at=$1 WHERE task=$2 AND last_alert_at=$3`, now, task, lastAlert)
	if e != nil || tag.RowsAffected() == 0 {
		return
	}
	h.alert(ctx, task, fmt.Sprintf("定时任务 %s 已连续失败 %d 次，请检查服务日志与依赖服务。", task, streak))
}

func (h *Health) Success(ctx context.Context, task string) {
	if h == nil || ctx.Err() != nil {
		return
	}
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	var streak int64
	if e := h.Store.DB.QueryRow(ctx, `SELECT fail_streak FROM cron_health WHERE task=$1`, task).Scan(&streak); e != nil || streak == 0 {
		return
	}
	if _, e := h.Store.DB.Exec(ctx, `UPDATE cron_health SET fail_streak=0,updated_at=$1 WHERE task=$2`, time.Now().UnixMilli(), task); e != nil {
		return
	}
	if streak >= alertAfter {
		h.alert(ctx, task, fmt.Sprintf("定时任务 %s 已恢复正常（此前连续失败 %d 次）。", task, streak))
	}
}

// alert is best-effort: a failed page leaves the streak in place so the next
// window retries, and never breaks the job loop itself.
func (h *Health) alert(ctx context.Context, task, text string) {
	if h.Sender == nil {
		return
	}
	if e := h.Sender.Alert(ctx, task, text); e != nil {
		slog.Default().Warn("cron health alert failed", "task", task, "err", e)
	}
}
