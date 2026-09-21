CREATE TABLE `archive_entries` (
	`path` text PRIMARY KEY NOT NULL,
	`session_pk` text NOT NULL,
	`agent_id` text,
	`project_id` text NOT NULL,
	`archive_path` text NOT NULL,
	`codec` text NOT NULL,
	`source_size` integer NOT NULL,
	`source_mtime_ms` integer NOT NULL,
	`bytes` integer NOT NULL,
	`archived_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `archive_entries_session_idx` ON `archive_entries` (`session_pk`);--> statement-breakpoint
CREATE TABLE `inbox_items` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`session_id` text,
	`project_id` text,
	`ticket` text,
	`reason` text NOT NULL,
	`dedupe_key` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`state` text NOT NULL,
	`snooze_until` text,
	`payload_json` text DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `inbox_items_active_dedupe` ON `inbox_items` (`dedupe_key`) WHERE state in ('open', 'snoozed');--> statement-breakpoint
CREATE INDEX `inbox_items_state_idx` ON `inbox_items` (`state`,`updated_at`);--> statement-breakpoint
CREATE TABLE `test_results` (
	`session_pk` text NOT NULL,
	`ts` text NOT NULL,
	`command` text NOT NULL,
	`passed` integer NOT NULL,
	`failed` integer NOT NULL,
	`skipped` integer NOT NULL,
	`duration_ms` integer,
	PRIMARY KEY(`session_pk`, `ts`)
);
