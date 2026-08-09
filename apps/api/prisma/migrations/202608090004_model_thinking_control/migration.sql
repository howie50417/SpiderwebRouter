CREATE TYPE "app"."ThinkingControlMode" AS ENUM ('FIXED', 'USER_SELECTABLE');

ALTER TABLE "app"."published_models"
  ADD COLUMN "thinking_control_mode" "app"."ThinkingControlMode" NOT NULL DEFAULT 'FIXED',
  ADD COLUMN "supported_thinking_levels" "app"."ThinkingLevel"[] NOT NULL DEFAULT ARRAY[]::"app"."ThinkingLevel"[];
