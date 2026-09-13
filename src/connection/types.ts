export type CheckState = 'unknown' | 'checking' | 'ok' | 'error' | 'authorization_required';
export interface ConnectionCheck { state: CheckState; checkedAt?: string; detail?: string; httpStatus?: number }
export interface ConnectionNetwork {
  dns: ConnectionCheck; tcp: ConnectionCheck; vpnInterfaces: string[]; proxyVariables: string[]; recommendations: string[]; fakeIpDetected?: boolean;
}
export interface ConnectionConfiguration {
  mode: 'managed' | 'quick' | 'sites'; autoStart: boolean; tunnelId?: string; publicUrl?: string; sitesUrl?: string;
  protocol: 'auto' | 'http2' | 'quic';
}
export interface ConnectionConfigurationInput extends Partial<ConnectionConfiguration> { token?: string; clearToken?: boolean; enrollmentToken?: string }
export interface CloudflaredInstallation { installed: boolean; path?: string; version?: string; source?: 'managed' | 'system'; checksumVerified: boolean; error?: string }
export interface ConnectionStatus {
  configuration: ConnectionConfiguration & { hasToken: boolean }; installation: CloudflaredInstallation;
  tunnel: { state: 'stopped' | 'starting' | 'established' | 'reconnecting' | 'error'; pid?: number; url?: string; since?: string; retryAt?: string; readiness?: ConnectionCheck; connections?: number };
  local: ConnectionCheck; public: ConnectionCheck; oauthDiscovery: ConnectionCheck; mcp: ConnectionCheck;
  network: ConnectionNetwork;
  authorization: { state: 'unknown' | 'authorized' | 'revoked'; observedAt?: string; clientName?: string };
  toolCall: { state: 'not_observed' | 'observed'; observedAt?: string; clientName?: string; tool?: string; count: number };
  // 客户端自报名称不能证明 ChatGPT 身份；真实产品验收在独立 QA 记录中保存。
  chatgptVerification: 'not_verified';
  chatgpt: { name: string; mcpUrl?: string; authentication: 'OAuth'; instructions: string[] };
  lastError?: string; recentEvents: { at: string; message: string }[]; externalDependencies: string[];
}
export interface ConnectionHost {
  mcpPort: number; controlPort: number;
  onPublicUrl?(url: string | undefined): void | Promise<void>;
  onTunnelUrl?(url: string | undefined): void | Promise<void>;
  bridge?: {
    publicUrl(): string | undefined;
    publish(upstream: string): Promise<{ publicUrl: string; upstream: string; updatedAt: string; expiresAt: number }>;
    remove(): Promise<void>;
  };
  getProbeToken?(): string | undefined | Promise<string | undefined>;
}
export interface ConnectionService {
  configureHost(host: Partial<ConnectionHost>): Promise<void>;
  configure(input: ConnectionConfigurationInput): Promise<ConnectionStatus>;
  status(): ConnectionStatus;
  detect(): Promise<CloudflaredInstallation>;
  install(): Promise<CloudflaredInstallation>;
  start(): Promise<ConnectionStatus>;
  stop(): Promise<ConnectionStatus>;
  restart(): Promise<ConnectionStatus>;
  restore(): Promise<ConnectionStatus>;
  diagnose(): Promise<ConnectionStatus>;
  observeOAuth(event: { status: 'authorized' | 'revoked'; clientName?: string; selfTest?: boolean }): void;
  observeToolCall(event: { clientName?: string; tool?: string; selfTest?: boolean }): void;
  close(): Promise<void>;
}
