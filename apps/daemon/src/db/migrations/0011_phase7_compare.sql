CREATE TABLE `compare_groups` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text,
	`prompt` text NOT NULL,
	`ticket` text,
	`repo` text NOT NULL,
	`base` text NOT NULL,
	`state` text DEFAULT 'running' NOT NULL,
	`winner_index` integer,
	`estimate_usd` real,
	`variants_json` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `compare_groups_created` ON `compare_groups` (`created_at`);