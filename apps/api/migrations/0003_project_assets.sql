CREATE TABLE "project_asset" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"mime" text NOT NULL,
	"size" integer NOT NULL,
	"storage" text NOT NULL,
	"state" text NOT NULL,
	"asset" jsonb,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "project_asset" ADD CONSTRAINT "project_asset_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_asset_project_id_index" ON "project_asset" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "project_asset_state_expires_at_index" ON "project_asset" USING btree ("state","expires_at");