ALTER TABLE "app"."provider_connections"
ADD COLUMN "deleted_at" TIMESTAMP(3);

ALTER TABLE "app"."published_models"
ADD COLUMN "deleted_at" TIMESTAMP(3);

CREATE INDEX "provider_connections_deleted_at_idx"
ON "app"."provider_connections"("deleted_at");

CREATE INDEX "published_models_deleted_at_idx"
ON "app"."published_models"("deleted_at");

-- Usage is financial/audit history and must never disappear as a side effect of
-- deleting a model. The service archives models when this constraint blocks a
-- physical delete.
ALTER TABLE "app"."usage_daily_rollups"
DROP CONSTRAINT "usage_daily_rollups_published_model_id_fkey";

ALTER TABLE "app"."usage_daily_rollups"
ADD CONSTRAINT "usage_daily_rollups_published_model_id_fkey"
FOREIGN KEY ("published_model_id") REFERENCES "app"."published_models"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;
