CREATE TABLE `budgets` (
	`id` text PRIMARY KEY NOT NULL,
	`scope_type` text NOT NULL,
	`scope_id` text DEFAULT '' NOT NULL,
	`period` text NOT NULL,
	`limit_usd` real NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `budgets_scope_period` ON `budgets` (`scope_type`,`scope_id`,`period`);--> statement-breakpoint
CREATE TABLE `digests` (
	`week_start` text PRIMARY KEY NOT NULL,
	`markdown` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `goals` (
	`id` text PRIMARY KEY NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text NOT NULL,
	`objective` text NOT NULL,
	`state` text NOT NULL,
	`blocked_reason` text,
	`source` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `goals_target` ON `goals` (`target_type`,`target_id`);--> statement-breakpoint
CREATE TABLE `handoffs` (
	`id` text PRIMARY KEY NOT NULL,
	`session_pk` text NOT NULL,
	`status` text NOT NULL,
	`summary` text NOT NULL,
	`evidence_json` text NOT NULL,
	`files_json` text NOT NULL,
	`next_steps_json` text NOT NULL,
	`blockers_json` text NOT NULL,
	`links_json` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `handoffs_session` ON `handoffs` (`session_pk`,`created_at`);--> statement-breakpoint
CREATE TABLE `ledger_cursors` (
	`session_pk` text NOT NULL,
	`agent_key` text NOT NULL,
	`after_seq` integer NOT NULL,
	`last_ts` text,
	PRIMARY KEY(`session_pk`, `agent_key`)
);
--> statement-breakpoint
CREATE TABLE `recaps` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`target_key` text NOT NULL,
	`transcript_offset` integer NOT NULL,
	`model` text NOT NULL,
	`engine` text NOT NULL,
	`text` text NOT NULL,
	`cost_usd` real NOT NULL,
	`input_tokens_approx` integer NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `recaps_cache_key` ON `recaps` (`kind`,`target_key`,`transcript_offset`);--> statement-breakpoint
CREATE INDEX `recaps_created_at` ON `recaps` (`created_at`);--> statement-breakpoint
CREATE TABLE `reminders` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`session_pk` text,
	`ticket` text,
	`text` text NOT NULL,
	`due_at` text NOT NULL,
	`send_to_session` integer DEFAULT false NOT NULL,
	`state` text NOT NULL,
	`created_at` text NOT NULL,
	`fired_at` text
);
--> statement-breakpoint
CREATE INDEX `reminders_state_due` ON `reminders` (`state`,`due_at`);--> statement-breakpoint
CREATE TABLE `scheduled_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`cron` text,
	`run_at` text,
	`payload_json` text DEFAULT '{}' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`last_fired_at` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `stream_links` (
	`ticket` text NOT NULL,
	`kind` text NOT NULL,
	`ref` text NOT NULL,
	`origin` text NOT NULL,
	`excluded` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`ticket`, `kind`, `ref`)
);
--> statement-breakpoint
CREATE INDEX `stream_links_ref` ON `stream_links` (`kind`,`ref`);--> statement-breakpoint
CREATE TABLE `streams` (
	`ticket` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`title` text,
	`stage` text NOT NULL,
	`session_ids_json` text DEFAULT '[]' NOT NULL,
	`prs_json` text DEFAULT '[]' NOT NULL,
	`plans_json` text DEFAULT '[]' NOT NULL,
	`worktrees_json` text DEFAULT '[]' NOT NULL,
	`cost_usd` real DEFAULT 0 NOT NULL,
	`last_activity_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `tool_uses` (
	`session_pk` text NOT NULL,
	`agent_key` text NOT NULL,
	`fact_key` text NOT NULL,
	`ts` text NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`tool_use_id` text,
	`project_id` text,
	`duration_ms` integer,
	PRIMARY KEY(`session_pk`, `agent_key`, `fact_key`)
);
--> statement-breakpoint
CREATE INDEX `tool_uses_ts` ON `tool_uses` (`ts`);--> statement-breakpoint
CREATE INDEX `tool_uses_tool_use_id` ON `tool_uses` (`tool_use_id`);--> statement-breakpoint
CREATE TABLE `usage_blocks` (
	`start` text PRIMARY KEY NOT NULL,
	`end` text NOT NULL,
	`tokens` integer NOT NULL,
	`cost_usd` real NOT NULL,
	`entries` integer NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `usage_entries` (
	`session_pk` text NOT NULL,
	`agent_key` text NOT NULL,
	`message_id` text NOT NULL,
	`ts` text NOT NULL,
	`source` text NOT NULL,
	`project_id` text,
	`tickets_json` text DEFAULT '[]' NOT NULL,
	`model` text NOT NULL,
	`input` integer NOT NULL,
	`output` integer NOT NULL,
	`cache_read` integer NOT NULL,
	`cache_write` integer NOT NULL,
	`est_cost_usd` real DEFAULT 0 NOT NULL,
	`alloc_cost_usd` real DEFAULT 0 NOT NULL,
	`authoritative` integer DEFAULT false NOT NULL,
	`latency_ms` integer,
	PRIMARY KEY(`session_pk`, `agent_key`, `message_id`)
);
--> statement-breakpoint
CREATE INDEX `usage_entries_ts` ON `usage_entries` (`ts`);--> statement-breakpoint
CREATE INDEX `usage_entries_project_ts` ON `usage_entries` (`project_id`,`ts`);