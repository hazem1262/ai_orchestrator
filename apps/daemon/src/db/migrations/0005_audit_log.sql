CREATE TABLE `audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`ts` text NOT NULL,
	`actor` text NOT NULL,
	`actor_detail` text,
	`action` text NOT NULL,
	`target` text,
	`session_pk` text,
	`params_json` text DEFAULT '{}' NOT NULL,
	`result` text NOT NULL,
	`error` text
);
--> statement-breakpoint
CREATE INDEX `audit_log_ts_idx` ON `audit_log` (`ts`);--> statement-breakpoint
CREATE INDEX `audit_log_session_pk_idx` ON `audit_log` (`session_pk`);--> statement-breakpoint
CREATE INDEX `audit_log_action_idx` ON `audit_log` (`action`);