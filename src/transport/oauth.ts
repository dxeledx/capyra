import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import express, { type RequestHandler } from 'express';
import { mcpAuthRouter, createOAuthMetadata, getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { metadataHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/metadata.js';
import { publicBaseUrl, publicEndpoint } from '../connection/urls.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { InvalidClientMetadataError, InvalidGrantError, InvalidRequestError, InvalidScopeError, InvalidTokenError, TooManyRequestsError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { AuthorizationParams, OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthClientInformationFull, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';

export interface AuthorizationRequest {
  id: string;
  clientName: string;
  redirectUri: string;
  createdAt: string;
  verificationCode: string;
}
export interface OAuthController {
  router: RequestHandler;
  requireAuth: RequestHandler;
  pending(): AuthorizationRequest[];
  grants(): Array<{ id: string; clientId: string; clientName: string; label?: string; status: 'active' | 'paused'; createdAt: string; lastUsedAt?: string; requestCount: number; expiresAt: string }>;
  decide(id: string, allow: boolean, label?: string): void;
  setLabel(grantId: string, label?: string): void;
  setPaused(grantId: string, paused: boolean): void;
  revoke(grantId?: string): void;
  close(): void;
}
interface Pending extends AuthorizationRequest { clientId: string; params: AuthorizationParams; expiresAt: number; redirect?: string }
interface Grant { id: string; clientId: string; label?: string; paused: boolean; createdAt: number; lastUsedAt?: number; requestCount: number; expiresAt: number }
interface Code { clientId: string; params: AuthorizationParams; expiresAt: number; grantId: string }
interface Token { clientId: string; grantId: string; expiresAt: number; kind: 'access' | 'refresh' }
export interface OAuthOptions { stateDir?: string; onAuthorized?(event: { owner: string; clientId: string; clientName: string }): void }

const secret = () => randomBytes(32).toString('base64url');
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const grantLifetimeMs = 30 * 24 * 60 * 60_000;
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));
function connectionLabel(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new Error('连接备注必须是文本');
  const label = value.trim();
  if (!label) return undefined;
  if (label.length > 80 || /[\u0000-\u001f\u007f]/.test(label)) throw new Error('连接备注最多 80 个字符，不能包含控制字符');
  return label;
}

export function validRedirectUri(value: string): boolean {
  try {
    const url = new URL(value);
    return value.length <= 2048 && !url.hash && !url.username && !url.password && (url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)));
  } catch { return false; }
}

export function createOAuth(issuer: URL, onRevoked?: (grantId?: string) => void, options: OAuthOptions = {}): OAuthController {
  const issuerKey = publicBaseUrl(issuer.href);
  const resource = new URL(publicEndpoint(issuer, 'mcp'));
  const clients = new Map<string, OAuthClientInformationFull>();
  const requests = new Map<string, Pending>();
  const codes = new Map<string, Code>();
  const grants = new Map<string, Grant>();
  const tokens = new Map<string, Token>();
  const router = express.Router();
  const lastUsagePersisted = new Map<string, number>();
  let usageDirty = false;
  // 授权按公开 issuer 隔离。磁盘只含令牌摘要；待批准请求及单次兑换码不跨重启复用。
  const file = options.stateDir ? join(options.stateDir, `oauth-${hash(issuerKey).slice(0, 24)}.json`) : undefined;
  function persist() {
    if (!file) return;
    mkdirSync(options.stateDir!, { recursive: true, mode: 0o700 });
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
      const descriptor = openSync(temp, 'wx', 0o600);
      try {
        writeFileSync(descriptor, JSON.stringify({ version: 1, issuer: issuerKey, clients: [...clients], grants: [...grants], tokens: [...tokens] }));
        fsyncSync(descriptor);
      } finally { closeSync(descriptor); }
      renameSync(temp, file);
      chmodSync(file, 0o600);
      const directory = openSync(options.stateDir!, 'r');
      try { fsyncSync(directory); } finally { closeSync(directory); }
      usageDirty = false;
      for (const grant of grants.values()) lastUsagePersisted.set(grant.id, grant.lastUsedAt ?? 0);
    } catch (error) { try { unlinkSync(temp); } catch {} throw error; }
  }
  if (file && existsSync(file)) {
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    if (saved.version !== 1 || saved.issuer !== issuerKey || !Array.isArray(saved.clients) || !Array.isArray(saved.grants) || !Array.isArray(saved.tokens) || saved.clients.length > 256 || saved.grants.length > 256 || saved.tokens.length > 512) throw new Error('OAuth state is invalid. Restore a trusted backup.');
    for (const [id, client] of saved.clients) {
      if (typeof id !== 'string' || client?.client_id !== id || !Array.isArray(client.redirect_uris) || !client.redirect_uris.every(validRedirectUri)) throw new Error('OAuth client state is invalid.');
      clients.set(id, client);
    }
    for (const [id, grant] of saved.grants) {
      if (typeof id !== 'string' || grant?.id !== id || !clients.has(grant.clientId) || !Number.isFinite(grant.expiresAt)) throw new Error('OAuth grant state is invalid.');
      if (grant.label !== undefined) connectionLabel(grant.label);
      if (grant.paused !== undefined && typeof grant.paused !== 'boolean') throw new Error('OAuth grant state is invalid.');
      if (grant.createdAt !== undefined && !Number.isFinite(grant.createdAt) || grant.lastUsedAt !== undefined && !Number.isFinite(grant.lastUsedAt) || grant.requestCount !== undefined && (!Number.isSafeInteger(grant.requestCount) || grant.requestCount < 0)) throw new Error('OAuth grant state is invalid.');
      if (grant.expiresAt > Date.now()) {
        const normalized: Grant = {
          id,
          clientId: grant.clientId,
          ...(grant.label ? { label: connectionLabel(grant.label) } : {}),
          paused: grant.paused === true,
          createdAt: Number.isFinite(grant.createdAt) ? grant.createdAt : grant.expiresAt - 24 * 60 * 60_000,
          ...(Number.isFinite(grant.lastUsedAt) ? { lastUsedAt: grant.lastUsedAt } : {}),
          requestCount: Number.isSafeInteger(grant.requestCount) ? grant.requestCount : 0,
          expiresAt: grant.expiresAt,
        };
        grants.set(id, normalized);
        lastUsagePersisted.set(id, normalized.lastUsedAt ?? 0);
      }
    }
    for (const [key, token] of saved.tokens) {
      if (!/^[a-f0-9]{64}$/.test(key) || !token || !['access', 'refresh'].includes(token.kind) || !Number.isFinite(token.expiresAt)) throw new Error('OAuth token state is invalid.');
      if (token.expiresAt > Date.now() && grants.get(token.grantId)?.clientId === token.clientId) tokens.set(key, token);
    }
    chmodSync(file, 0o600);
  }

  function revoke(grantId?: string) {
    for (const [key, token] of tokens) if (!grantId || token.grantId === grantId) tokens.delete(key);
    for (const [key, code] of codes) if (!grantId || code.grantId === grantId) codes.delete(key);
    if (grantId) { grants.delete(grantId); lastUsagePersisted.delete(grantId); }
    else { grants.clear(); requests.clear(); lastUsagePersisted.clear(); }
    // 撤销先使内存授权失效。即使磁盘故障，也必须中止活请求和任务，再向本机报告保存失败。
    try { persist(); } finally { onRevoked?.(grantId); }
  }
  function sweep() {
    const now = Date.now();
    for (const [id, request] of requests) if (request.expiresAt <= now) requests.delete(id);
    for (const [key, code] of codes) if (code.expiresAt <= now) codes.delete(key);
    for (const [key, token] of tokens) if (token.expiresAt <= now) tokens.delete(key);
    for (const [id, grant] of grants) if (grant.expiresAt <= now) revoke(id);
    // DCR client_id 是客户端保存的长期注册身份。授权过期不等于客户端注册失效，
    // 否则 ChatGPT 在重启后复用原 client_id 会收到 invalid_client。
  }
  function checkResource(requested?: URL) {
    if (requested && requested.href !== resource.href) throw new InvalidRequestError('The resource must match this Capyra MCP endpoint.');
  }
  function checkScopes(scopes?: string[]) {
    if (scopes?.some(scope => scope !== 'mcp')) throw new InvalidScopeError('Only the mcp scope is supported.');
  }
  function findCode(client: OAuthClientInformationFull, code: string): Code {
    const record = codes.get(hash(code));
    if (!record || record.clientId !== client.client_id || record.expiresAt <= Date.now() || !grants.has(record.grantId)) throw new InvalidGrantError('Invalid or expired authorization code.');
    return record;
  }
  function issue(grantId: string): OAuthTokens {
    const grant = grants.get(grantId);
    if (!grant || grant.expiresAt <= Date.now()) throw new InvalidGrantError('Authorization has expired. Connect again.');
    if (grant.paused) throw new InvalidGrantError('Authorization is paused on the local Capyra device.');
    // 同一授权只保留当前令牌对；刷新保持任务 owner，同时立即淘汰旧令牌。
    for (const [key, token] of tokens) if (token.grantId === grantId) tokens.delete(key);
    const access = secret();
    const refresh = secret();
    const expiresAt = Math.min(Date.now() + 60 * 60_000, grant.expiresAt);
    tokens.set(hash(access), { clientId: grant.clientId, grantId, kind: 'access', expiresAt });
    tokens.set(hash(refresh), { clientId: grant.clientId, grantId, kind: 'refresh', expiresAt: grant.expiresAt });
    persist();
    return { token_type: 'Bearer', access_token: access, refresh_token: refresh, expires_in: Math.max(1, Math.floor((expiresAt - Date.now()) / 1000)), scope: 'mcp' };
  }
  const provider: OAuthServerProvider = {
    clientsStore: {
      getClient: id => clients.get(id),
      registerClient: client => {
        sweep();
        if (clients.size >= 256) throw new TooManyRequestsError('Too many registered clients.');
        if (!client.redirect_uris.length || client.redirect_uris.length > 10 || !client.redirect_uris.every(validRedirectUri)) throw new InvalidClientMetadataError('Redirect URIs must use HTTPS or loopback HTTP, without credentials or fragments.');
        if (client.grant_types?.some(type => !['authorization_code', 'refresh_token'].includes(type))) throw new InvalidClientMetadataError('Unsupported grant type.');
        if (client.response_types?.some(type => type !== 'code')) throw new InvalidClientMetadataError('Only the code response type is supported.');
        if (!['none', 'client_secret_post', undefined].includes(client.token_endpoint_auth_method)) throw new InvalidClientMetadataError('Unsupported token endpoint authentication method.');
        const full: OAuthClientInformationFull = { ...client, client_name: (client.client_name ?? 'MCP client').slice(0, 160), client_id: randomUUID(), client_id_issued_at: Math.floor(Date.now() / 1000) };
        if (client.token_endpoint_auth_method === 'client_secret_post') full.client_secret = secret();
        clients.set(full.client_id, full);
        persist();
        return full;
      },
    },
    async authorize(client, params, res) {
      sweep();
      checkResource(params.resource);
      checkScopes(params.scopes);
      if (!validRedirectUri(params.redirectUri) || !/^[A-Za-z0-9_-]{43}$/.test(params.codeChallenge) || (params.state?.length ?? 0) > 2048) throw new InvalidRequestError('Invalid authorization parameters.');
      if (requests.size >= 64 || grants.size >= 256) throw new TooManyRequestsError('Too many authorization requests.');
      const id = secret();
      const verificationCode = randomBytes(3).toString('hex').toUpperCase();
      const request: Pending = { id, clientId: client.client_id, clientName: client.client_name ?? 'MCP client', redirectUri: params.redirectUri, params, createdAt: new Date().toISOString(), expiresAt: Date.now() + 5 * 60_000, verificationCode };
      requests.set(id, request);
      const nonce = secret();
      res.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self' ${issuer.origin}; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`);
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.type('html').send(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>连接 Capyra</title><style nonce="${nonce}">body{margin:0;background:#f5f3ed;color:#263a31;font:16px/1.7 system-ui}main{max-width:480px;margin:12vh auto;padding:32px;background:white;border-radius:24px}h1{font-size:28px}code{display:block;font-size:36px;letter-spacing:8px;margin:24px 0;color:#2b6652}p{overflow-wrap:anywhere}.muted{color:#66746b;font-size:14px}</style><main><p class="muted">CAPYRA · 连接确认</p><h1>请在本机确认连接</h1><p><strong>${escapeHtml(request.clientName)}</strong> 请求访问你的 Capyra 工作区。</p><p>打开本机 Capyra 控制台，核对下方验证码与回调地址后批准。连接获准后，后续操作按照本机当前的个人模式或共享账号保护设置执行。</p><code>${verificationCode}</code><p class="muted">回调：${escapeHtml(params.redirectUri)}</p><p id="status">正在等待本机确认。批准后会自动返回客户端。</p></main><script nonce="${nonce}">const status=document.getElementById('status');async function poll(){try{const response=await fetch('./oauth/pending/${id}',{cache:'no-store',credentials:'omit'});const result=await response.json();if(result.redirect){location.replace(result.redirect);return}if(!response.ok){status.textContent='连接请求已过期或已撤销，请返回客户端重新连接。';return}}catch{status.textContent='正在重试连接…'}setTimeout(poll,1500)}poll();</script></html>`);
    },
    async challengeForAuthorizationCode(client, code) { return findCode(client, code).params.codeChallenge; },
    async exchangeAuthorizationCode(client, code, _verifier, redirectUri, requestedResource) {
      const record = findCode(client, code);
      if (redirectUri !== record.params.redirectUri) throw new InvalidGrantError('The redirect URI does not match the authorization request.');
      checkResource(requestedResource);
      // SDK 已完成 S256 校验；同步删除保证并发兑换也只能成功一次。
      codes.delete(hash(code));
      const issued = issue(record.grantId);
      options.onAuthorized?.({ owner: `oauth:${record.grantId}`, clientId: client.client_id, clientName: client.client_name ?? 'MCP client' });
      return issued;
    },
    async exchangeRefreshToken(client, refresh, scopes, requestedResource) {
      checkScopes(scopes);
      checkResource(requestedResource);
      const token = tokens.get(hash(refresh));
      if (!token || token.kind !== 'refresh' || token.clientId !== client.client_id || token.expiresAt <= Date.now()) throw new InvalidGrantError('Invalid or expired refresh token.');
      return issue(token.grantId);
    },
    async verifyAccessToken(access) {
      const token = tokens.get(hash(access));
      const grant = token ? grants.get(token.grantId) : undefined;
      if (!token || token.kind !== 'access' || token.expiresAt <= Date.now() || !grant || grant.expiresAt <= Date.now()) throw new InvalidTokenError('Invalid or expired access token.');
      if (grant.paused) throw new InvalidTokenError('This connection is paused on the local Capyra device.');
      const now = Date.now();
      grant.lastUsedAt = now;
      grant.requestCount++;
      usageDirty = true;
      // 界面立即读取内存中的实时计数，磁盘活动时间按窗口合并，避免每个 MCP 请求同步刷盘。
      if (now - (lastUsagePersisted.get(grant.id) ?? 0) >= 30_000) persist();
      return { token: access, clientId: token.clientId, scopes: ['mcp'], expiresAt: Math.floor(token.expiresAt / 1000), resource, extra: { owner: `oauth:${token.grantId}` } };
    },
    async revokeToken(client, request) {
      const token = tokens.get(hash(request.token));
      if (token?.clientId === client.client_id) revoke(token.grantId);
    },
  };
  router.get('/oauth/pending/:id', (req, res) => {
    sweep();
    const request = requests.get(req.params.id);
    if (!request) { res.status(404).json({ error: 'Request expired or revoked.' }); return; }
    res.json(request.redirect ? { redirect: request.redirect } : { status: 'pending' });
  });
  // cloudflared通过本机连接转发，IP头不能证明调用者身份。各OAuth端点按本设备聚合限流，
  // 保留SDK各自的默认窗口和阈值，也不让伪造X-Forwarded-For/CF-Connecting-IP获得新额度。
  const rateLimit = { keyGenerator: () => 'capyra-device' };
  if (issuer.pathname !== '/') {
    // 代理只转发协议消息；公开 metadata 由本机授权服务按固定设备路径原生生成。
    const metadata = createOAuthMetadata({ provider, issuerUrl: issuer, scopesSupported: ['mcp'] });
    Object.assign(metadata, { authorization_endpoint: publicEndpoint(issuer, 'authorize'), token_endpoint: publicEndpoint(issuer, 'token'), registration_endpoint: publicEndpoint(issuer, 'register'), revocation_endpoint: publicEndpoint(issuer, 'revoke') });
    router.use('/.well-known/oauth-authorization-server', metadataHandler(metadata));
    router.use('/.well-known/oauth-protected-resource/mcp', metadataHandler({ resource: resource.href, authorization_servers: [issuer.href], scopes_supported: ['mcp'], resource_name: 'Capyra local workspace' }));
  }
  router.use(mcpAuthRouter({ provider, issuerUrl: issuer, resourceServerUrl: resource, scopesSupported: ['mcp'], resourceName: 'Capyra local workspace',
    authorizationOptions: { rateLimit }, tokenOptions: { rateLimit }, clientRegistrationOptions: { rateLimit }, revocationOptions: { rateLimit } }));
  const authenticate = requireBearerAuth({ verifier: provider, requiredScopes: ['mcp'], resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resource) });
  const requireAuth: RequestHandler = (req, res, next) => {
    void authenticate(req, res, error => {
      if (error) { next(error); return; }
      res.locals.capyraOwner = req.auth?.extra?.owner;
      next();
    });
  };
  const timer = setInterval(sweep, 60_000);
  timer.unref();
  return { router, requireAuth,
    pending() { sweep(); return [...requests.values()].filter(request => !request.redirect).map(({ id, clientName, redirectUri, createdAt, verificationCode }) => ({ id, clientName, redirectUri, createdAt, verificationCode })); },
    grants() { sweep(); return [...grants.values()].sort((left, right) => (right.lastUsedAt ?? right.createdAt) - (left.lastUsedAt ?? left.createdAt)).map(grant => ({
      id: grant.id,
      clientId: grant.clientId,
      clientName: clients.get(grant.clientId)?.client_name ?? 'MCP client',
      ...(grant.label ? { label: grant.label } : {}),
      status: grant.paused ? 'paused' : 'active',
      createdAt: new Date(grant.createdAt).toISOString(),
      ...(grant.lastUsedAt ? { lastUsedAt: new Date(grant.lastUsedAt).toISOString() } : {}),
      requestCount: grant.requestCount,
      expiresAt: new Date(grant.expiresAt).toISOString(),
    })); },
    decide(id, allow, label) {
      sweep();
      const request = requests.get(id);
      if (!request || request.redirect) throw new Error('Authorization request not found or already decided.');
      const redirect = new URL(request.params.redirectUri);
      if (request.params.state !== undefined) redirect.searchParams.set('state', request.params.state);
      if (allow) {
        const code = secret();
        const grantId = randomUUID();
        const now = Date.now();
        const normalizedLabel = connectionLabel(label);
        grants.set(grantId, { id: grantId, clientId: request.clientId, ...(normalizedLabel ? { label: normalizedLabel } : {}), paused: false, createdAt: now, requestCount: 0, expiresAt: now + grantLifetimeMs });
        persist();
        codes.set(hash(code), { clientId: request.clientId, params: request.params, expiresAt: Date.now() + 60_000, grantId });
        redirect.searchParams.set('code', code);
      } else redirect.searchParams.set('error', 'access_denied');
      request.redirect = redirect.href;
      request.expiresAt = Date.now() + 60_000;
    },
    setLabel(grantId, label) {
      sweep();
      const grant = grants.get(grantId);
      if (!grant) throw new Error('连接不存在或已经过期');
      const normalized = connectionLabel(label);
      if (normalized) grant.label = normalized; else delete grant.label;
      persist();
    },
    setPaused(grantId, paused) {
      sweep();
      const grant = grants.get(grantId);
      if (!grant) throw new Error('连接不存在或已经过期');
      if (grant.paused === paused) return;
      grant.paused = paused;
      // 暂停先在内存生效；即使保存失败，也必须立即中止这条连接的活请求和后台任务。
      try { persist(); } finally { if (paused) onRevoked?.(grantId); }
    },
    revoke,
    // 正常退出保留授权；显式撤销和入口变更才使持久令牌失效。
    close() { clearInterval(timer); if (usageDirty) { try { persist(); } catch {} } requests.clear(); codes.clear(); },
  };
}
