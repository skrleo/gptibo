-- Default Alipay payout payee bound by the partner; payout requests
-- snapshot it into partner_payouts.recipient at submit time.
ALTER TABLE partner_settings ADD COLUMN payout_phone TEXT NOT NULL DEFAULT '';
ALTER TABLE partner_settings ADD COLUMN payout_name TEXT NOT NULL DEFAULT '';
