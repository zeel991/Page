-- Identity, memberships, and an organisation column on every table the console reads.
-- Existing rows are backfilled before any column becomes NOT NULL, and existing
-- users keep their workspace as an owner membership.
CREATE TYPE "public"."membership_role" AS ENUM('owner', 'admin', 'member');--> statement-breakpoint
CREATE TABLE "memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"role" "membership_role" DEFAULT 'member' NOT NULL,
	"slack_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
INSERT INTO "memberships" ("user_id", "organization_id", "role") SELECT "id", "organization_id", 'owner' FROM "users";--> statement-breakpoint
ALTER TABLE "users" DROP CONSTRAINT "users_organization_id_organizations_id_fk";
--> statement-breakpoint
DROP INDEX "users_org_email_idx";--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "email" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "organization_id" uuid;--> statement-breakpoint
ALTER TABLE "evidence" ADD COLUMN "organization_id" uuid;--> statement-breakpoint
ALTER TABLE "regressions" ADD COLUMN "organization_id" uuid;--> statement-breakpoint
ALTER TABLE "telemetry_snapshots" ADD COLUMN "organization_id" uuid;--> statement-breakpoint
ALTER TABLE "tool_calls" ADD COLUMN "organization_id" uuid;--> statement-breakpoint
UPDATE "evidence" e SET "organization_id" = i."organization_id" FROM "incidents" i WHERE e."incident_id" = i."id";--> statement-breakpoint
UPDATE "regressions" r SET "organization_id" = s."organization_id" FROM "services" s WHERE r."service_id" = s."id";--> statement-breakpoint
UPDATE "telemetry_snapshots" t SET "organization_id" = s."organization_id" FROM "services" s WHERE t."service_id" = s."id";--> statement-breakpoint
UPDATE "agent_runs" a SET "organization_id" = i."organization_id" FROM "incidents" i WHERE a."incident_id" = i."id";--> statement-breakpoint
-- A run never attached to an incident predates tenancy; with one organisation it
-- can only belong to that one. With several it is ambiguous, and is deleted rather
-- than guessed into a tenant.
UPDATE "agent_runs" SET "organization_id" = (SELECT "id" FROM "organizations") WHERE "organization_id" IS NULL AND (SELECT count(*) FROM "organizations") = 1;--> statement-breakpoint
DELETE FROM "tool_calls" WHERE "agent_run_id" IN (SELECT "id" FROM "agent_runs" WHERE "organization_id" IS NULL);--> statement-breakpoint
DELETE FROM "agent_runs" WHERE "organization_id" IS NULL;--> statement-breakpoint
UPDATE "tool_calls" t SET "organization_id" = a."organization_id" FROM "agent_runs" a WHERE t."agent_run_id" = a."id";--> statement-breakpoint
ALTER TABLE "agent_runs" ALTER COLUMN "organization_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "evidence" ALTER COLUMN "organization_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "regressions" ALTER COLUMN "organization_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "telemetry_snapshots" ALTER COLUMN "organization_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "tool_calls" ALTER COLUMN "organization_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "auth_provider" text DEFAULT 'github' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "provider_subject" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "login" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "avatar_url" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "last_sign_in_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "memberships_user_org_idx" ON "memberships" USING btree ("user_id","organization_id");--> statement-breakpoint
CREATE INDEX "memberships_org_idx" ON "memberships" USING btree ("organization_id");--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "regressions" ADD CONSTRAINT "regressions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telemetry_snapshots" ADD CONSTRAINT "telemetry_snapshots_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_calls" ADD CONSTRAINT "tool_calls_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_runs_org_idx" ON "agent_runs" USING btree ("organization_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "users_provider_subject_idx" ON "users" USING btree ("auth_provider","provider_subject");--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "organization_id";
