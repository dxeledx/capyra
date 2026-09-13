export interface IdentityUser { id: string; email: string; createdAt: string }
export interface DeviceScope { workspaces: string[]; capabilities: string[] }
export interface DeviceConnection { tunnelId: string; publicUrl: string; dnsRecordId?: string }
export interface IdentityDevice {
  id: string; ownerId: string; name: string; fingerprint: string; createdAt: string;
  updatedAt: string; revokedAt?: string; version: number; scope: DeviceScope; connection?: DeviceConnection; bridge?: { publicUrl: string; updatedAt: string };
}
export interface ApprovalRelayStatus {
  state: 'inactive' | 'ready' | 'syncing' | 'paused' | 'error';
  pending: number; lastSyncedAt?: string; error?: string; approvalUrl?: string;
  requiresLocalApproval: { id: string; kind: 'access' | 'task'; reason: string }[];
}
export interface IdentityStatus {
  configured: boolean; cloudUrl?: string; user?: IdentityUser; sessionExpiresAt?: string;
  device?: IdentityDevice; active: boolean; checkedAt?: string; error?: string;
  approvalRelay?: ApprovalRelayStatus;
  pairing?: { code: string; expiresAt: string; fingerprint: string };
}
export interface ConnectionProvider {
  provision(input: { deviceId: string; mcpPort: number }): Promise<DeviceConnection & { token: string }>;
  revoke(input: { tunnelId: string; dnsRecordId?: string }): Promise<void>;
  rotate(input: { tunnelId: string }): Promise<{ token: string }>;
}
