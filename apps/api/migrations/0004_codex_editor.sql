CREATE TABLE "agent_usage" (
	"owner_id" text NOT NULL,
	"day" text NOT NULL,
	"kind" text NOT NULL,
	"count" integer NOT NULL,
	CONSTRAINT "agent_usage_owner_id_day_kind_pk" PRIMARY KEY("owner_id","day","kind")
);
--> statement-breakpoint
CREATE TABLE "codex_connection" (
	"project_id" uuid PRIMARY KEY NOT NULL,
	"secret_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone,
	CONSTRAINT "codex_connection_secret_hash_unique" UNIQUE("secret_hash")
);
--> statement-breakpoint
CREATE TABLE "codex_run" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"owner_id" text NOT NULL,
	"tab_id" uuid NOT NULL,
	"context" jsonb NOT NULL,
	"prompt" text NOT NULL,
	"status" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_read_revision" integer,
	"events" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"result" text,
	"receipt" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "codex_run_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "frame_job" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"frame" integer NOT NULL,
	"fps" integer NOT NULL,
	"timeline" jsonb,
	"status" text DEFAULT 'queued' NOT NULL,
	"data" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "frame_job_project_id_revision_frame_unique" UNIQUE("project_id","revision","frame")
);
--> statement-breakpoint
ALTER TABLE "agent_usage" ADD CONSTRAINT "agent_usage_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "codex_connection" ADD CONSTRAINT "codex_connection_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "codex_run" ADD CONSTRAINT "codex_run_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "codex_run" ADD CONSTRAINT "codex_run_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "frame_job" ADD CONSTRAINT "frame_job_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "codex_run_project_id_tab_id_created_at_index" ON "codex_run" USING btree ("project_id","tab_id","created_at");--> statement-breakpoint
CREATE INDEX "frame_job_status_created_at_index" ON "frame_job" USING btree ("status","created_at");