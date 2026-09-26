CREATE TABLE `checkpoints` (
	`id` text PRIMARY KEY NOT NULL,
	`session_pk` text NOT NULL,
	`session_id` text NOT NULL,
	`worktree_path` text NOT NULL,
	`turn` integer NOT NULL,
	`ref` text NOT NULL,
	`commit` text NOT NULL,
	`kind` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `checkpoints_ref_uq` ON `checkpoints` (`ref`);--> statement-breakpoint
CREATE INDEX `checkpoints_session_idx` ON `checkpoints` (`session_pk`);--> statement-breakpoint
CREATE INDEX `checkpoints_worktree_idx` ON `checkpoints` (`worktree_path`);--> statement-breakpoint
CREATE TABLE `pr_cache` (
	`key` text PRIMARY KEY NOT NULL,
	`repo` text NOT NULL,
	`number` integer NOT NULL,
	`url` text NOT NULL,
	`state` text NOT NULL,
	`title` text NOT NULL,
	`checks` text NOT NULL,
	`review` text NOT NULL,
	`head_ref` text,
	`failed_checks_json` text DEFAULT '[]' NOT NULL,
	`updated_at` text NOT NULL,
	`fetched_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `pr_cache_head_idx` ON `pr_cache` (`head_ref`);--> statement-breakpoint
CREATE TABLE `worktrees` (
	`path` text PRIMARY KEY NOT NULL,
	`repo` text NOT NULL,
	`branch` text NOT NULL,
	`base` text,
	`ticket` text,
	`dirty` integer DEFAULT false NOT NULL,
	`pr_url` text,
	`state` text DEFAULT 'active' NOT NULL,
	`created_by_app` integer DEFAULT false NOT NULL,
	`head` text,
	`is_main` integer DEFAULT false NOT NULL,
	`origin` text NOT NULL,
	`session_pks_json` text DEFAULT '[]' NOT NULL,
	`project_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`archived_at` text
);
--> statement-breakpoint
CREATE INDEX `worktrees_repo_idx` ON `worktrees` (`repo`);--> statement-breakpoint
CREATE INDEX `worktrees_branch_idx` ON `worktrees` (`branch`);