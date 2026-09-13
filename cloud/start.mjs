#!/usr/bin/env node
import { resolve } from 'node:path';
import { startIdentityCloud } from '../dist/identity/cloud.js';
import { CloudflareApiProvider } from '../dist/connection/cloudflare-api.js';

const port = Number(process.env.CAPYRA_IDENTITY_PORT || 4320);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('CAPYRA_IDENTITY_PORT must be a TCP port');
const cf = ['CF_ACCOUNT_ID', 'CF_ZONE_ID', 'CF_BASE_DOMAIN', 'CF_API_TOKEN'];
const present = cf.filter(name => Boolean(process.env[name]));
if (present.length && present.length !== cf.length) throw new Error('Set all four CF_ACCOUNT_ID, CF_ZONE_ID, CF_BASE_DOMAIN, CF_API_TOKEN variables together');
const provider = present.length ? new CloudflareApiProvider({
  accountId: process.env.CF_ACCOUNT_ID,
  zoneId: process.env.CF_ZONE_ID,
  baseDomain: process.env.CF_BASE_DOMAIN,
  apiToken: process.env.CF_API_TOKEN,
  controlPort: Number(process.env.CAPYRA_CONTROL_PORT || 4318),
}) : undefined;
const cloud = await startIdentityCloud({
  stateDir: resolve(process.env.CAPYRA_IDENTITY_STATE || '.capyra/identity-cloud'),
  host: process.env.CAPYRA_IDENTITY_HOST || '127.0.0.1',
  port,
  publicOrigin: process.env.CAPYRA_IDENTITY_ORIGIN,
  publicBasePath: process.env.CAPYRA_IDENTITY_BASE_PATH,
  provider,
});
console.log(`Capyra account service: ${cloud.origin}`);
console.log(`Managed device connections: ${provider ? 'configured' : 'not configured'}`);
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void cloud.close().then(() => process.exit(0)); });
