CREATE TABLE "export_attempt" (
	"export_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"progress" integer DEFAULT 0 NOT NULL,
	"claim" uuid,
	"lease_until" timestamp with time zone,
	"error" text,
	"remote_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	CONSTRAINT "export_attempt_export_id_number_pk" PRIMARY KEY("export_id","number")
);
--> statement-breakpoint
CREATE TABLE "export_source" (
	"export_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	CONSTRAINT "export_source_export_id_asset_id_pk" PRIMARY KEY("export_id","asset_id")
);
--> statement-breakpoint
CREATE TABLE "export_version" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"title" text NOT NULL,
	"release" text NOT NULL,
	"manifest" jsonb NOT NULL,
	"timeline" jsonb NOT NULL,
	"storage" text NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"watch_token" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "export_version_watch_token_unique" UNIQUE("watch_token"),
	CONSTRAINT "export_version_project_id_revision_release_unique" UNIQUE("project_id","revision","release")
);
--> statement-breakpoint
CREATE TABLE "rough_cut_review" (
	"project_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"run_id" uuid,
	"options" jsonb NOT NULL,
	"base_revision" integer NOT NULL,
	"before" jsonb NOT NULL,
	"operations" jsonb NOT NULL,
	"receipt" jsonb NOT NULL,
	"committed_revision" integer,
	"preview_image" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rough_cut_review_project_id_id_pk" PRIMARY KEY("project_id","id")
);
--> statement-breakpoint
ALTER TABLE "export_attempt" ADD CONSTRAINT "export_attempt_export_id_export_version_id_fk" FOREIGN KEY ("export_id") REFERENCES "public"."export_version"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "export_source" ADD CONSTRAINT "export_source_export_id_export_version_id_fk" FOREIGN KEY ("export_id") REFERENCES "public"."export_version"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "export_source" ADD CONSTRAINT "export_source_asset_id_project_asset_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."project_asset"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "export_version" ADD CONSTRAINT "export_version_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rough_cut_review" ADD CONSTRAINT "rough_cut_review_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rough_cut_review" ADD CONSTRAINT "rough_cut_review_run_id_codex_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."codex_run"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "export_attempt_status_lease_until_created_at_index" ON "export_attempt" USING btree ("status","lease_until","created_at");--> statement-breakpoint
CREATE INDEX "export_version_expires_at_index" ON "export_version" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "rough_cut_review_project_id_created_at_index" ON "rough_cut_review" USING btree ("project_id","created_at");