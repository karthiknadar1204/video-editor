CREATE TABLE "project_edit" (
	"project_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"actor_id" text NOT NULL,
	"request_id" uuid NOT NULL,
	"command" jsonb NOT NULL,
	"forward" jsonb NOT NULL,
	"inverse" jsonb NOT NULL,
	"affected" jsonb,
	"state" text,
	"target_revision" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_edit_project_id_revision_pk" PRIMARY KEY("project_id","revision"),
	CONSTRAINT "project_edit_project_id_request_id_unique" UNIQUE("project_id","request_id")
);
--> statement-breakpoint
ALTER TABLE "project_edit" ADD CONSTRAINT "project_edit_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_edit" ADD CONSTRAINT "project_edit_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_edit_project_id_state_revision_index" ON "project_edit" USING btree ("project_id","state","revision");