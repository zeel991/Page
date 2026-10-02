ALTER TABLE "evidence" ADD COLUMN "backend" text;--> statement-breakpoint
-- Existing rows keep their meaning: every DATADOG_* row came from Datadog.
UPDATE "evidence" SET "kind" = 'OBS_METRIC', "backend" = 'datadog' WHERE "kind" = 'DATADOG_METRIC';--> statement-breakpoint
UPDATE "evidence" SET "kind" = 'OBS_LOG', "backend" = 'datadog' WHERE "kind" = 'DATADOG_LOG';--> statement-breakpoint
UPDATE "evidence" SET "kind" = 'OBS_ALERT', "backend" = 'datadog' WHERE "kind" = 'DATADOG_MONITOR';
