CREATE TABLE `agents` (
	`session_pk` text NOT NULL,
	`id` text NOT NULL,
	`parent_id` text,
	`depth` integer NOT NULL,
	`agent_type` text NOT NULL,
	`description` text NOT NULL,
	`background` integer DEFAULT false NOT NULL,
	`tool_use_id` text,
	`usage_json` text NOT NULL,
	`started_at` text NOT NULL,
	`ended_at` text,
	`status` text NOT NULL,
	`transcript_path` text NOT NULL,
	PRIMARY KEY(`session_pk`, `id`)
);
--> statement-breakpoint
CREATE TABLE `events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_pk` text NOT NULL,
	`agent_id` text DEFAULT '' NOT NULL,
	`seq` integer NOT NULL,
	`uuid` text NOT NULL,
	`parent_uuid` text,
	`ts` text NOT NULL,
	`kind` text NOT NULL,
	`turn` integer NOT NULL,
	`text` text,
	`tool` text,
	`tool_use_id` text,
	`mcp_server` text,
	`input_json` text,
	`search_input` text,
	`message_id` text,
	`model` text,
	`usage_json` text,
	`duration_ms` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `events_session_agent_seq` ON `events` (`session_pk`,`agent_id`,`seq`);--> statement-breakpoint
CREATE INDEX `events_session_turn` ON `events` (`session_pk`,`turn`);--> statement-breakpoint
CREATE TABLE `file_offsets` (
	`path` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`session_pk` text,
	`agent_id` text,
	`size` integer NOT NULL,
	`mtime_ms` integer NOT NULL,
	`offset` integer NOT NULL,
	`state_json` text,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `history_prompts` (
	`session_id` text NOT NULL,
	`ts` text NOT NULL,
	`display` text NOT NULL,
	`project` text NOT NULL,
	PRIMARY KEY(`session_id`, `ts`)
);
--> statement-breakpoint
CREATE TABLE `labels` (
	`session_pk` text NOT NULL,
	`label` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`session_pk`, `label`)
);
--> statement-breakpoint
CREATE INDEX `labels_label` ON `labels` (`label`);--> statement-breakpoint
CREATE TABLE `pins` (
	`session_pk` text PRIMARY KEY NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`path_prefixes_json` text NOT NULL,
	`hidden` integer DEFAULT false NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `pty_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`session_pk` text,
	`command` text NOT NULL,
	`args_json` text NOT NULL,
	`cwd` text NOT NULL,
	`pid` integer NOT NULL,
	`started_at` text NOT NULL,
	`exited_at` text,
	`exit_code` integer
);
--> statement-breakpoint
CREATE TABLE `saved_views` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`query_json` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`pk` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`id` text NOT NULL,
	`project_id` text,
	`start_cwd` text NOT NULL,
	`name` text,
	`first_prompt` text,
	`last_prompt` text,
	`recap` text,
	`started_at` text NOT NULL,
	`last_activity_at` text NOT NULL,
	`cost_usd` real,
	`models_json` text DEFAULT '[]' NOT NULL,
	`tickets_json` text DEFAULT '[]' NOT NULL,
	`prs_json` text DEFAULT '[]' NOT NULL,
	`skills_json` text DEFAULT '[]' NOT NULL,
	`availability` text NOT NULL,
	`has_subagents` integer DEFAULT false NOT NULL,
	`touched_prod` integer DEFAULT false NOT NULL,
	`automated` integer DEFAULT false NOT NULL,
	`transcript_path` text,
	`origin` text DEFAULT 'transcript' NOT NULL,
	`data_json` text NOT NULL,
	`indexed_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_source_id` ON `sessions` (`source`,`id`);--> statement-breakpoint
CREATE INDEX `sessions_activity` ON `sessions` (`last_activity_at`);--> statement-breakpoint
CREATE INDEX `sessions_project_activity` ON `sessions` (`project_id`,`last_activity_at`);