CREATE TABLE `supervisor_decisions` (
	`id` text PRIMARY KEY NOT NULL,
	`session_pk` text NOT NULL,
	`project_id` text,
	`question` text NOT NULL,
	`decision` text NOT NULL,
	`answer` text,
	`confidence` real DEFAULT 0 NOT NULL,
	`reason` text NOT NULL,
	`intent` text,
	`sent` integer DEFAULT false NOT NULL,
	`cost_usd` real,
	`model` text,
	`feedback` text,
	`ts` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `supervisor_decisions_session` ON `supervisor_decisions` (`session_pk`,`ts`);--> statement-breakpoint
CREATE INDEX `supervisor_decisions_ts` ON `supervisor_decisions` (`ts`);--> statement-breakpoint
CREATE TABLE `supervisor_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text,
	`kind` text NOT NULL,
	`pattern` text NOT NULL,
	`intent` text,
	`answer` text,
	`source` text DEFAULT 'user' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`note` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `supervisor_rules_kind` ON `supervisor_rules` (`kind`,`enabled`);--> statement-breakpoint
CREATE TABLE `supervisor_targets` (
	`target_type` text NOT NULL,
	`target_id` text NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`target_type`, `target_id`)
);
