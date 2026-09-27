CREATE TABLE `connector_tokens_meta` (
	`connector` text PRIMARY KEY NOT NULL,
	`auth_kind` text NOT NULL,
	`account_id` text,
	`account_label` text,
	`scopes_json` text DEFAULT '[]' NOT NULL,
	`cursor_json` text DEFAULT '{}' NOT NULL,
	`last_status` text DEFAULT 'ok' NOT NULL,
	`connected_at` text NOT NULL,
	`last_checked_at` text
);
--> statement-breakpoint
CREATE TABLE `push_subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`device_id` text,
	`endpoint` text NOT NULL,
	`p256dh` text NOT NULL,
	`auth` text NOT NULL,
	`created_at` text NOT NULL,
	`last_ok_at` text,
	`failures` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`device_id`) REFERENCES `remote_devices`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `push_subscriptions_endpoint_unique` ON `push_subscriptions` (`endpoint`);--> statement-breakpoint
CREATE TABLE `remote_devices` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`token_hash` text NOT NULL,
	`login` text,
	`created_at` text NOT NULL,
	`last_seen_at` text,
	`revoked_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `remote_devices_token_hash_unique` ON `remote_devices` (`token_hash`);--> statement-breakpoint
CREATE TABLE `slack_threads` (
	`inbox_item_id` text PRIMARY KEY NOT NULL,
	`session_pk` text,
	`channel` text NOT NULL,
	`root_ts` text NOT NULL,
	`last_seen_ts` text NOT NULL,
	`app_ts_json` text DEFAULT '[]' NOT NULL,
	`reactions_done_json` text DEFAULT '[]' NOT NULL,
	`state` text DEFAULT 'open' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `slack_threads_state_idx` ON `slack_threads` (`state`);--> statement-breakpoint
CREATE TABLE `webauthn_credentials` (
	`id` text PRIMARY KEY NOT NULL,
	`device_id` text NOT NULL,
	`public_key` text NOT NULL,
	`counter` integer DEFAULT 0 NOT NULL,
	`transports_json` text DEFAULT '[]' NOT NULL,
	`created_at` text NOT NULL,
	`last_used_at` text,
	FOREIGN KEY (`device_id`) REFERENCES `remote_devices`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `webauthn_credentials_device_idx` ON `webauthn_credentials` (`device_id`);