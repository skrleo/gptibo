-- 后台配置的发件邮箱池；api_key 为空时使用平台邮件服务密钥，读接口不回显密钥。
CREATE TABLE mail_senders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT NOT NULL,
  from_email TEXT NOT NULL,
  from_name TEXT NOT NULL DEFAULT '',
  api_key TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
  sort_order INTEGER NOT NULL DEFAULT 0,
  sent_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 0
);

-- 邮件队列模板与节奏配置（单行）。占位符：{order} {email} {sender} {index} {total}。
CREATE TABLE mail_queue_settings (
  id INTEGER PRIMARY KEY CHECK(id=1),
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  duration_minutes INTEGER NOT NULL DEFAULT 5 CHECK(duration_minutes BETWEEN 1 AND 60),
  version INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL DEFAULT 0
);
INSERT INTO mail_queue_settings(id,subject,body,duration_minutes) VALUES (1,'您的邮件服务（订单 {order}）','您好，\n这是您的邮件服务订单 {order} 的第 {index} 封邮件（共 {total} 封），由发件邮箱 {sender} 发出。',5);

-- 支付完成后创建的队列任务；每分钟的 cron 认领到期步骤并经邮件服务发送。
CREATE TABLE mail_queue_tasks (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL UNIQUE REFERENCES orders(id),
  status TEXT NOT NULL CHECK(status IN ('queued','sending','done','failed','cancelled')),
  total_steps INTEGER NOT NULL,
  done_steps INTEGER NOT NULL DEFAULT 0,
  failed_steps INTEGER NOT NULL DEFAULT 0,
  start_at INTEGER NOT NULL,
  next_run_at INTEGER NOT NULL,
  step_spacing_ms INTEGER NOT NULL,
  lease_token TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 0
);

-- 每个发件邮箱一封；request_key 作为邮件服务幂等键，重试复用同一封邮件。
CREATE TABLE mail_queue_steps (
  task_id TEXT NOT NULL REFERENCES mail_queue_tasks(id),
  step_index INTEGER NOT NULL,
  sender_id INTEGER NOT NULL REFERENCES mail_senders(id),
  recipient TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sending','sent','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  request_key TEXT NOT NULL,
  provider_id TEXT,
  sent_at INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(task_id, step_index)
);

INSERT INTO catalog_plans(id,product_id,name,price_cents,enabled,renewal_only,updated_at,purchase_note,delivery_instructions,partner_enabled)
VALUES ('mail-queue-once','mail-queue','5 分钟服务',500,1,0,0,'付款后系统按后台配置的发件邮箱，在服务时长内陆续向您下单邮箱发送邮件，进度可在原订单查看。','订单生效后，您下单使用的邮箱将在服务时长内陆续收到来自多个发件邮箱的邮件。',0);
