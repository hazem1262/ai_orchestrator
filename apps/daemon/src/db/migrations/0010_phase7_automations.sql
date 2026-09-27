CREATE TABLE `automation_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`automation_id` text NOT NULL,
	`trigger_key` text NOT NULL,
	`trigger_source` text NOT NULL,
	`vars_json` text DEFAULT '{}' NOT NULL,
	`started_at` text NOT NULL,
	`ended_at` text,
	`status` text NOT NULL,
	`session_pk` text,
	`pty_id` text,
	`worktree_path` text,
	`cost_usd` real,
	`summary` text,
	`pr_url` text,
	`diff_stat_json` text,
	`log_path` text,
	`error` text,
	`rerun_of` text,
	FOREIGN KEY (`automation_id`) REFERENCES `automations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `automation_runs_trigger_key` ON `automation_runs` (`automation_id`,`trigger_key`);--> statement-breakpoint
CREATE INDEX `automation_runs_by_automation` ON `automation_runs` (`automation_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `automation_runs_by_status` ON `automation_runs` (`status`);--> statement-breakpoint
CREATE TABLE `automation_suggestions` (
	`id` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`project_id` text,
	`title` text NOT NULL,
	`detail` text NOT NULL,
	`ticket` text,
	`file` text,
	`line` integer,
	`dedupe_key` text NOT NULL,
	`state` text DEFAULT 'new' NOT NULL,
	`created_at` text NOT NULL,
	`decided_at` text,
	`run_pty_id` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `automation_suggestions_dedupe` ON `automation_suggestions` (`dedupe_key`);--> statement-breakpoint
CREATE INDEX `automation_suggestions_state` ON `automation_suggestions` (`state`,`created_at`);--> statement-breakpoint
CREATE TABLE `automations` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`trigger_json` text NOT NULL,
	`action_json` text NOT NULL,
	`budget_usd` real NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
