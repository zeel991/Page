DROP INDEX "revision_runs_service_revision_idx";--> statement-breakpoint
ALTER TABLE "revision_runs" ADD COLUMN "failure_key" text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "revision_runs_service_revision_failure_idx" ON "revision_runs" USING btree ("service_id","deployed_revision","failure_key");