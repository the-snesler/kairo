CREATE TABLE `task_estimate` (
	`task_id` text PRIMARY KEY NOT NULL,
	`minutes` integer NOT NULL,
	`confidence` text,
	`rationale` text,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`input_hash` text NOT NULL,
	`estimated_at` integer NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `task`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `task` ADD `due_string` text;--> statement-breakpoint
ALTER TABLE `task` ADD `due_recurring` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `task` ADD `duration_override_minutes` integer;--> statement-breakpoint
ALTER TABLE `task` ADD `pending_patch` text;--> statement-breakpoint
ALTER TABLE `task` ADD `completed_at` integer;--> statement-breakpoint
ALTER TABLE `task_connection` ADD `provider` text DEFAULT 'todoist' NOT NULL;--> statement-breakpoint
ALTER TABLE `task_connection` ADD `scope` text;--> statement-breakpoint
CREATE INDEX `task_block_task` ON `task_block` (`task_id`);