-- Muse AI per-item product with manual fulfillment, mirroring the Workers
-- migration 0054. No supplier mapping exists, so orders stay pending until an
-- admin completes them by hand.
INSERT INTO catalog_plans(id,product_id,name,price_cents,enabled,renewal_only,updated_at,purchase_note,delivery_instructions,partner_enabled)
VALUES ('muse-ai-once','muse-ai','单个',1200,true,false,now(),'Muse AI 单个商品。付款确认后由工作人员人工处理，交付进度可在原订单查看。','',false);
