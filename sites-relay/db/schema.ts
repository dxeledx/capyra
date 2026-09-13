import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';
export const devices = sqliteTable('devices', {
  id: text('id').primaryKey(), publicKey: text('public_key').notNull(), name: text('name').notNull(),
  createdAt: integer('created_at').notNull(), seenAt: integer('seen_at').notNull(), revoked: integer('revoked').notNull().default(0),
});
export const nonces = sqliteTable('nonces', {
  id: text('id').primaryKey(), expiresAt: integer('expires_at').notNull(),
}, t => [index('nonce_expiry').on(t.expiresAt)]);
export const requests = sqliteTable('requests', {
  id: text('id').primaryKey(), deviceId: text('device_id').notNull().references(() => devices.id),
  payload: text('payload').notNull(), response: text('response'), state: text('state').notNull().default('queued'),
  createdAt: integer('created_at').notNull(), expiresAt: integer('expires_at').notNull(),
}, t => [index('request_device_state').on(t.deviceId,t.state,t.createdAt),index('request_expiry').on(t.expiresAt)]);
