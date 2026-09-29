ALTER TABLE "integrations" ADD COLUMN "verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "integrations" ADD COLUMN "last_error" text;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "health_url" text;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "alert_source" text DEFAULT 'datadog' NOT NULL;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "slack_channel_id" text;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "slack_channel_name" text;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "base_branch" text;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "autonomy_level" text DEFAULT 'L3' NOT NULL;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "read_only" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "interval_seconds" integer DEFAULT 60 NOT NULL;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "notion_parent_page_id" text;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "email_recipients" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "health_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "health_last_error" text;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "last_polled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "last_poll_outcome" text;--> statement-breakpoint
CREATE UNIQUE INDEX "integrations_org_provider_idx" ON "integrations" USING btree ("organization_id","provider");