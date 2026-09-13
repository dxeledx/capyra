CREATE TABLE `devices` (
	`id` text PRIMARY KEY NOT NULL,
	`public_key` text NOT NULL,
	`name` text NOT NULL,
	`created_at` integer NOT NULL,
	`seen_at` integer NOT NULL,
	`revoked` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `nonces` (
	`id` text PRIMARY KEY NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `nonce_expiry` ON `nonces` (`expires_at`);--> statement-breakpoint
CREATE TABLE `requests` (
	`id` text PRIMARY KEY NOT NULL,
	`device_id` text NOT NULL,
	`payload` text NOT NULL,
	`response` text,
	`state` text DEFAULT 'queued' NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `request_device_state` ON `requests` (`device_id`,`state`,`created_at`);--> statement-breakpoint
CREATE INDEX `request_expiry` ON `requests` (`expires_at`);