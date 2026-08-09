CREATE SCHEMA IF NOT EXISTS "app";

CREATE TYPE "app"."UserRole" AS ENUM ('SUPER_ADMIN', 'ADMIN', 'USER');
CREATE TYPE "app"."ProviderType" AS ENUM ('OPENAI', 'GENERIC_OPENAI', 'GEMINI', 'OLLAMA', 'OPEN_WEBUI');
CREATE TYPE "app"."ProviderAuthMode" AS ENUM ('NONE', 'BEARER', 'API_KEY');
CREATE TYPE "app"."HealthStatus" AS ENUM ('UNKNOWN', 'HEALTHY', 'DEGRADED', 'UNHEALTHY');
CREATE TYPE "app"."PromptMode" AS ENUM ('NONE', 'PREPEND', 'REPLACE');
CREATE TYPE "app"."ThinkingLevel" AS ENUM ('PROVIDER_DEFAULT', 'OFF', 'LOW', 'MEDIUM', 'HIGH');
CREATE TYPE "app"."ScanStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED');
CREATE TYPE "app"."RequestSource" AS ENUM ('API', 'PLAYGROUND', 'DOCS');
CREATE TYPE "app"."RequestStatus" AS ENUM ('RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED');
CREATE TYPE "app"."AttemptStatus" AS ENUM ('RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED');

CREATE TABLE "app"."users" (
  "id" UUID NOT NULL,
  "keycloak_subject" TEXT,
  "email" TEXT NOT NULL,
  "display_name" TEXT,
  "role" "app"."UserRole" NOT NULL DEFAULT 'USER',
  "active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "app"."provider_connections" (
  "id" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "type" "app"."ProviderType" NOT NULL,
  "base_url" TEXT NOT NULL,
  "auth_mode" "app"."ProviderAuthMode" NOT NULL DEFAULT 'BEARER',
  "encrypted_secret" TEXT,
  "timeout_ms" INTEGER NOT NULL DEFAULT 120000,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "health_status" "app"."HealthStatus" NOT NULL DEFAULT 'UNKNOWN',
  "last_health_check_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "provider_connections_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "provider_connections_timeout_ms_check" CHECK ("timeout_ms" BETWEEN 1000 AND 600000)
);

CREATE TABLE "app"."discovered_models" (
  "id" UUID NOT NULL,
  "provider_id" UUID NOT NULL,
  "upstream_model_id" TEXT NOT NULL,
  "display_name" TEXT,
  "capabilities" JSONB,
  "metadata" JSONB,
  "available" BOOLEAN NOT NULL DEFAULT true,
  "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "discovered_models_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "app"."scan_jobs" (
  "id" UUID NOT NULL,
  "provider_id" UUID NOT NULL,
  "status" "app"."ScanStatus" NOT NULL DEFAULT 'PENDING',
  "discovered_count" INTEGER NOT NULL DEFAULT 0,
  "safe_error_code" TEXT,
  "started_at" TIMESTAMP(3),
  "finished_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "scan_jobs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "app"."published_models" (
  "id" UUID NOT NULL,
  "provider_id" UUID NOT NULL,
  "upstream_model_id" TEXT NOT NULL,
  "default_alias" TEXT NOT NULL,
  "display_name" TEXT,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "capabilities" JSONB NOT NULL,
  "prompt_mode" "app"."PromptMode" NOT NULL DEFAULT 'NONE',
  "system_prompt" TEXT,
  "thinking_level" "app"."ThinkingLevel" NOT NULL DEFAULT 'PROVIDER_DEFAULT',
  "max_retries" INTEGER NOT NULL DEFAULT 0,
  "input_price_per_m" DECIMAL(20,8) NOT NULL DEFAULT 0,
  "output_price_per_m" DECIMAL(20,8) NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "published_models_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "published_models_max_retries_check" CHECK ("max_retries" BETWEEN 0 AND 5),
  CONSTRAINT "published_models_input_price_check" CHECK ("input_price_per_m" >= 0),
  CONSTRAINT "published_models_output_price_check" CHECK ("output_price_per_m" >= 0),
  CONSTRAINT "published_models_prompt_check" CHECK ("prompt_mode" = 'NONE' OR "system_prompt" IS NOT NULL)
);

CREATE TABLE "app"."user_model_grants" (
  "id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "published_model_id" UUID NOT NULL,
  "alias" TEXT NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "custom_input_price_per_m" DECIMAL(20,8),
  "custom_output_price_per_m" DECIMAL(20,8),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "user_model_grants_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "user_model_grants_input_price_check" CHECK ("custom_input_price_per_m" IS NULL OR "custom_input_price_per_m" >= 0),
  CONSTRAINT "user_model_grants_output_price_check" CHECK ("custom_output_price_per_m" IS NULL OR "custom_output_price_per_m" >= 0)
);

CREATE TABLE "app"."api_keys" (
  "id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "key_hash" TEXT NOT NULL,
  "prefix" TEXT NOT NULL,
  "last_four" TEXT NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "expires_at" TIMESTAMP(3),
  "last_used_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revoked_at" TIMESTAMP(3),
  CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "app"."inference_requests" (
  "id" UUID NOT NULL,
  "request_id" TEXT NOT NULL,
  "user_id" UUID NOT NULL,
  "api_key_id" UUID,
  "published_model_id" UUID NOT NULL,
  "endpoint" TEXT NOT NULL,
  "source" "app"."RequestSource" NOT NULL DEFAULT 'API',
  "model_alias" TEXT NOT NULL,
  "streamed" BOOLEAN NOT NULL DEFAULT false,
  "status" "app"."RequestStatus" NOT NULL DEFAULT 'RUNNING',
  "input_tokens" INTEGER NOT NULL DEFAULT 0,
  "cached_input_tokens" INTEGER NOT NULL DEFAULT 0,
  "output_tokens" INTEGER NOT NULL DEFAULT 0,
  "reasoning_tokens" INTEGER NOT NULL DEFAULT 0,
  "usage_estimated" BOOLEAN NOT NULL DEFAULT false,
  "input_price_snapshot" DECIMAL(20,8) NOT NULL,
  "output_price_snapshot" DECIMAL(20,8) NOT NULL,
  "cost_usd" DECIMAL(30,12) NOT NULL DEFAULT 0,
  "retry_count" INTEGER NOT NULL DEFAULT 0,
  "safe_error_code" TEXT,
  "latency_ms" INTEGER,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completed_at" TIMESTAMP(3),
  CONSTRAINT "inference_requests_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "inference_requests_usage_check" CHECK ("input_tokens" >= 0 AND "cached_input_tokens" >= 0 AND "output_tokens" >= 0 AND "reasoning_tokens" >= 0 AND "cost_usd" >= 0)
);

CREATE TABLE "app"."provider_attempts" (
  "id" UUID NOT NULL,
  "inference_request_id" UUID NOT NULL,
  "provider_id" UUID NOT NULL,
  "attempt_number" INTEGER NOT NULL,
  "status" "app"."AttemptStatus" NOT NULL DEFAULT 'RUNNING',
  "upstream_status" INTEGER,
  "error_category" TEXT,
  "upstream_error_code" TEXT,
  "retryable" BOOLEAN NOT NULL DEFAULT false,
  "input_tokens" INTEGER,
  "output_tokens" INTEGER,
  "latency_ms" INTEGER,
  "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completed_at" TIMESTAMP(3),
  CONSTRAINT "provider_attempts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "provider_attempts_number_check" CHECK ("attempt_number" > 0)
);

CREATE TABLE "app"."usage_daily_rollups" (
  "id" UUID NOT NULL,
  "usage_date" DATE NOT NULL,
  "user_id" UUID NOT NULL,
  "api_key_id" UUID,
  "published_model_id" UUID NOT NULL,
  "request_count" INTEGER NOT NULL DEFAULT 0,
  "error_count" INTEGER NOT NULL DEFAULT 0,
  "retry_count" INTEGER NOT NULL DEFAULT 0,
  "input_tokens" BIGINT NOT NULL DEFAULT 0,
  "output_tokens" BIGINT NOT NULL DEFAULT 0,
  "cost_usd" DECIMAL(30,12) NOT NULL DEFAULT 0,
  CONSTRAINT "usage_daily_rollups_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "app"."audit_logs" (
  "id" UUID NOT NULL,
  "actor_user_id" UUID,
  "action" TEXT NOT NULL,
  "entity_type" TEXT NOT NULL,
  "entity_id" TEXT,
  "request_id" TEXT,
  "metadata" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "users_keycloak_subject_key" ON "app"."users"("keycloak_subject");
CREATE UNIQUE INDEX "users_email_key" ON "app"."users"("email");
CREATE INDEX "users_role_active_idx" ON "app"."users"("role", "active");
CREATE UNIQUE INDEX "provider_connections_name_key" ON "app"."provider_connections"("name");
CREATE INDEX "provider_connections_type_active_idx" ON "app"."provider_connections"("type", "active");
CREATE INDEX "discovered_models_provider_id_available_idx" ON "app"."discovered_models"("provider_id", "available");
CREATE UNIQUE INDEX "discovered_models_provider_id_upstream_model_id_key" ON "app"."discovered_models"("provider_id", "upstream_model_id");
CREATE INDEX "scan_jobs_provider_id_created_at_idx" ON "app"."scan_jobs"("provider_id", "created_at");
CREATE UNIQUE INDEX "published_models_default_alias_key" ON "app"."published_models"("default_alias");
CREATE INDEX "published_models_provider_id_upstream_model_id_idx" ON "app"."published_models"("provider_id", "upstream_model_id");
CREATE INDEX "published_models_active_idx" ON "app"."published_models"("active");
CREATE INDEX "user_model_grants_user_id_active_idx" ON "app"."user_model_grants"("user_id", "active");
CREATE UNIQUE INDEX "user_model_grants_user_id_alias_key" ON "app"."user_model_grants"("user_id", "alias");
CREATE UNIQUE INDEX "user_model_grants_user_id_published_model_id_key" ON "app"."user_model_grants"("user_id", "published_model_id");
CREATE UNIQUE INDEX "api_keys_key_hash_key" ON "app"."api_keys"("key_hash");
CREATE INDEX "api_keys_user_id_active_idx" ON "app"."api_keys"("user_id", "active");
CREATE UNIQUE INDEX "inference_requests_request_id_key" ON "app"."inference_requests"("request_id");
CREATE INDEX "inference_requests_user_id_created_at_idx" ON "app"."inference_requests"("user_id", "created_at");
CREATE INDEX "inference_requests_published_model_id_created_at_idx" ON "app"."inference_requests"("published_model_id", "created_at");
CREATE INDEX "inference_requests_status_created_at_idx" ON "app"."inference_requests"("status", "created_at");
CREATE INDEX "provider_attempts_provider_id_started_at_idx" ON "app"."provider_attempts"("provider_id", "started_at");
CREATE UNIQUE INDEX "provider_attempts_inference_request_id_attempt_number_key" ON "app"."provider_attempts"("inference_request_id", "attempt_number");
CREATE INDEX "usage_daily_rollups_usage_date_user_id_idx" ON "app"."usage_daily_rollups"("usage_date", "user_id");
CREATE UNIQUE INDEX "usage_daily_rollups_usage_date_user_id_api_key_id_published_key" ON "app"."usage_daily_rollups"("usage_date", "user_id", "api_key_id", "published_model_id");
CREATE INDEX "audit_logs_created_at_idx" ON "app"."audit_logs"("created_at");
CREATE INDEX "audit_logs_entity_type_entity_id_idx" ON "app"."audit_logs"("entity_type", "entity_id");

ALTER TABLE "app"."discovered_models" ADD CONSTRAINT "discovered_models_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "app"."provider_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "app"."scan_jobs" ADD CONSTRAINT "scan_jobs_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "app"."provider_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "app"."published_models" ADD CONSTRAINT "published_models_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "app"."provider_connections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "app"."user_model_grants" ADD CONSTRAINT "user_model_grants_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "app"."user_model_grants" ADD CONSTRAINT "user_model_grants_published_model_id_fkey" FOREIGN KEY ("published_model_id") REFERENCES "app"."published_models"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "app"."api_keys" ADD CONSTRAINT "api_keys_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "app"."inference_requests" ADD CONSTRAINT "inference_requests_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "app"."inference_requests" ADD CONSTRAINT "inference_requests_api_key_id_fkey" FOREIGN KEY ("api_key_id") REFERENCES "app"."api_keys"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "app"."inference_requests" ADD CONSTRAINT "inference_requests_published_model_id_fkey" FOREIGN KEY ("published_model_id") REFERENCES "app"."published_models"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "app"."provider_attempts" ADD CONSTRAINT "provider_attempts_inference_request_id_fkey" FOREIGN KEY ("inference_request_id") REFERENCES "app"."inference_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "app"."provider_attempts" ADD CONSTRAINT "provider_attempts_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "app"."provider_connections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "app"."usage_daily_rollups" ADD CONSTRAINT "usage_daily_rollups_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "app"."usage_daily_rollups" ADD CONSTRAINT "usage_daily_rollups_api_key_id_fkey" FOREIGN KEY ("api_key_id") REFERENCES "app"."api_keys"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "app"."usage_daily_rollups" ADD CONSTRAINT "usage_daily_rollups_published_model_id_fkey" FOREIGN KEY ("published_model_id") REFERENCES "app"."published_models"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "app"."audit_logs" ADD CONSTRAINT "audit_logs_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "app"."users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
