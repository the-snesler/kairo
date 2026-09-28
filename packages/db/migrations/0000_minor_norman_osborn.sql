CREATE TABLE `account` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`user_id` text NOT NULL,
	`access_token` text,
	`refresh_token` text,
	`id_token` text,
	`access_token_expires_at` integer,
	`refresh_token_expires_at` integer,
	`scope` text,
	`password` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `account_access` (
	`user_id` text NOT NULL,
	`connected_account_id` text NOT NULL,
	`role` text DEFAULT 'owner' NOT NULL,
	PRIMARY KEY(`user_id`, `connected_account_id`),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`connected_account_id`) REFERENCES `connected_account`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `calendar` (
	`id` text PRIMARY KEY NOT NULL,
	`connected_account_id` text NOT NULL,
	`google_calendar_id` text NOT NULL,
	`name` text NOT NULL,
	`color` text,
	`access_role` text,
	`time_zone` text,
	`sync_cursor` text,
	`sync_status` text DEFAULT 'pending' NOT NULL,
	`last_synced_at` integer,
	`last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`connected_account_id`) REFERENCES `connected_account`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `calendar_account_google_id` ON `calendar` (`connected_account_id`,`google_calendar_id`);--> statement-breakpoint
CREATE TABLE `connected_account` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_user_id` text NOT NULL,
	`provider` text NOT NULL,
	`provider_subject` text,
	`display_name` text,
	`encrypted_credentials` text,
	`status` text DEFAULT 'connected' NOT NULL,
	`last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`owner_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `connected_account_provider_subject` ON `connected_account` (`provider`,`provider_subject`);--> statement-breakpoint
CREATE TABLE `event_decision` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`external_event_id` text NOT NULL,
	`state` text DEFAULT 'undecided' NOT NULL,
	`destination_calendar_id` text,
	`decided_at` integer,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`external_event_id`) REFERENCES `external_event`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`destination_calendar_id`) REFERENCES `calendar`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `event_decision_user_external` ON `event_decision` (`user_id`,`external_event_id`);--> statement-breakpoint
CREATE TABLE `event_projection` (
	`id` text PRIMARY KEY NOT NULL,
	`decision_id` text NOT NULL,
	`destination_calendar_id` text,
	`google_event_id` text,
	`last_applied_source_revision` text,
	`last_applied_etag` text,
	`sync_state` text DEFAULT 'pending' NOT NULL,
	`conflict_kind` text,
	`last_error` text,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`decision_id`) REFERENCES `event_decision`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`destination_calendar_id`) REFERENCES `calendar`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `event_projection_decision_id_unique` ON `event_projection` (`decision_id`);--> statement-breakpoint
CREATE TABLE `external_event` (
	`id` text PRIMARY KEY NOT NULL,
	`source_id` text NOT NULL,
	`uid` text NOT NULL,
	`recurrence_id` text DEFAULT '' NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`location` text,
	`start_at` integer,
	`end_at` integer,
	`start_date` text,
	`end_date` text,
	`time_zone` text,
	`all_day` integer DEFAULT false NOT NULL,
	`recurrence_rule` text,
	`status` text DEFAULT 'confirmed' NOT NULL,
	`source_revision` text NOT NULL,
	`raw_ics` text,
	`first_seen_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`withdrawn_at` integer,
	FOREIGN KEY (`source_id`) REFERENCES `ics_source`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `external_event_identity` ON `external_event` (`source_id`,`uid`,`recurrence_id`);--> statement-breakpoint
CREATE INDEX `external_event_range` ON `external_event` (`start_at`,`end_at`);--> statement-breakpoint
CREATE TABLE `google_event` (
	`id` text PRIMARY KEY NOT NULL,
	`calendar_id` text NOT NULL,
	`google_event_id` text NOT NULL,
	`recurring_event_id` text,
	`original_start_time` text,
	`etag` text,
	`event_type` text,
	`title` text DEFAULT '' NOT NULL,
	`description` text,
	`location` text,
	`start_at` integer,
	`end_at` integer,
	`start_date` text,
	`end_date` text,
	`time_zone` text,
	`all_day` integer DEFAULT false NOT NULL,
	`status` text DEFAULT 'confirmed' NOT NULL,
	`response_status` text,
	`color_id` text,
	`color` text,
	`html_link` text,
	`projection_id` text,
	`task_block_id` text,
	`raw_json` text,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`calendar_id`) REFERENCES `calendar`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `google_event_calendar_google_id` ON `google_event` (`calendar_id`,`google_event_id`);--> statement-breakpoint
CREATE INDEX `google_event_range` ON `google_event` (`start_at`,`end_at`);--> statement-breakpoint
CREATE TABLE `ics_source` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_user_id` text NOT NULL,
	`url` text NOT NULL,
	`name` text NOT NULL,
	`color` text,
	`etag` text,
	`last_modified` text,
	`last_successful_fetch_at` integer,
	`next_poll_at` integer,
	`status` text DEFAULT 'pending' NOT NULL,
	`last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`owner_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ics_source_owner` ON `ics_source` (`owner_user_id`);--> statement-breakpoint
CREATE TABLE `session` (
	`id` text PRIMARY KEY NOT NULL,
	`expires_at` integer NOT NULL,
	`token` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`ip_address` text,
	`user_agent` text,
	`user_id` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_token_unique` ON `session` (`token`);--> statement-breakpoint
CREATE TABLE `sync_job` (
	`id` text PRIMARY KEY NOT NULL,
	`job_key` text NOT NULL,
	`kind` text NOT NULL,
	`target_id` text NOT NULL,
	`next_run_at` integer NOT NULL,
	`lease_until` integer,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sync_job_job_key_unique` ON `sync_job` (`job_key`);--> statement-breakpoint
CREATE INDEX `sync_job_due` ON `sync_job` (`next_run_at`,`lease_until`);--> statement-breakpoint
CREATE TABLE `task` (
	`id` text PRIMARY KEY NOT NULL,
	`connection_id` text NOT NULL,
	`todoist_id` text NOT NULL,
	`content` text NOT NULL,
	`description` text,
	`project_id` text,
	`project_name` text,
	`priority` integer DEFAULT 1 NOT NULL,
	`due_date` text,
	`due_date_time` integer,
	`due_time_zone` text,
	`duration_minutes` integer,
	`completed` integer DEFAULT false NOT NULL,
	`deleted` integer DEFAULT false NOT NULL,
	`provider_updated_at` integer,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`connection_id`) REFERENCES `task_connection`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `task_connection_todoist_id` ON `task` (`connection_id`,`todoist_id`);--> statement-breakpoint
CREATE TABLE `task_block` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`calendar_id` text NOT NULL,
	`google_event_id` text,
	`start_at` integer NOT NULL,
	`end_at` integer NOT NULL,
	`sync_state` text DEFAULT 'pending' NOT NULL,
	`last_applied_etag` text,
	`last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `task`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`calendar_id`) REFERENCES `calendar`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `task_connection` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_user_id` text NOT NULL,
	`provider_subject` text,
	`encrypted_credentials` text,
	`sync_token` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`last_synced_at` integer,
	`last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`owner_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `user` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`email_verified` integer DEFAULT false NOT NULL,
	`image` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_email_unique` ON `user` (`email`);--> statement-breakpoint
CREATE TABLE `user_calendar_setting` (
	`user_id` text NOT NULL,
	`calendar_id` text NOT NULL,
	`visible` integer DEFAULT true NOT NULL,
	`is_default` integer DEFAULT false NOT NULL,
	`is_maybe` integer DEFAULT false NOT NULL,
	PRIMARY KEY(`user_id`, `calendar_id`),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`calendar_id`) REFERENCES `calendar`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `verification` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
