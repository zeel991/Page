CREATE TABLE "plans" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"max_services" integer NOT NULL,
	"max_incidents_per_month" integer NOT NULL,
	"included_model_usd" double precision
);
--> statement-breakpoint
-- Placeholder limits; billing is not wired. Every existing workspace starts free.
INSERT INTO "plans" ("id", "name", "max_services", "max_incidents_per_month", "included_model_usd") VALUES
  ('free', 'Free', 1, 10, 5),
  ('team', 'Team', 25, 500, 200);--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "plan_id" text DEFAULT 'free' NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE no action ON UPDATE no action;