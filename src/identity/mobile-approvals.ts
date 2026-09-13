import { IdentityError } from './security.js';
export interface MobileApprovalRequest { id: string; kind: 'access' | 'task'; digest: string; description: string; workspace: string; details: unknown; expiresAt: number }
export interface MobileApprovalDecision { id: string; kind: 'access' | 'task'; digest: string; approve: boolean; visibility: 'local' | 'client' }
interface Device { id: string; ownerId: string; name: string; version: number; revokedAt?: string }
interface Entry { deviceId: string; version: number; request: MobileApprovalRequest; frozen: string; decision?: MobileApprovalDecision; delivered?: boolean; active?: boolean }
const fail = () => { throw new IdentityError('Invalid mobile approval request', 400); };
function identity(value: Record<string, unknown>) {
  if (typeof value.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value.id) || !['access','task'].includes(String(value.kind)) || typeof value.digest !== 'string' || !/^[a-f0-9]{64}$/.test(value.digest)) fail();
}
/** 云端仅暂存设备冻结的请求；重启丢弃待处理项，不会补发或推断批准。 */
export class MobileApprovals {
  private entries = new Map<string, Entry>();
  constructor(private devices: () => Device[]) {}
  private sweep() {
    const devices = this.devices();
    for (const [key, value] of this.entries) if (value.request.expiresAt <= Date.now() || !devices.some(d => d.id === value.deviceId && d.version === value.version && !d.revokedAt)) this.entries.delete(key);
  }
  sync(device: Device, input: unknown): { deviceId: string; version: number; decisions: MobileApprovalDecision[] } {
    this.sweep();
    const raw=input as { requests?: unknown };
    if (!raw || Object.keys(raw).join() !== 'requests' || !Array.isArray(raw.requests) || raw.requests.length > 128 || Buffer.byteLength(JSON.stringify(raw)) > 256*1024) fail();
    const staged = new Map<string, Entry>();
    for (const value of raw.requests as unknown[]) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
      const r = value as Record<string, unknown>; identity(r);
      if (Object.keys(r).sort().join() !== 'description,details,digest,expiresAt,id,kind,workspace' || typeof r.description !== 'string' || r.description.length > 4096 || typeof r.workspace !== 'string' || r.workspace.length > 4096 || !r.workspace || r.details === undefined || Buffer.byteLength(JSON.stringify(r.details)) > 32*1024 || !Number.isSafeInteger(r.expiresAt) || Number(r.expiresAt) <= Date.now() || Number(r.expiresAt) > Date.now()+5*60_000) fail();
      const request=structuredClone(r) as unknown as MobileApprovalRequest;
      const key = `${device.id}:${device.version}:${request.kind}:${request.id}`;
      if (staged.has(key)) fail();
      const frozen=JSON.stringify([request.id,request.kind,request.digest,request.description,request.workspace,request.details,request.expiresAt]);
      const old=this.entries.get(key);
      // 相同请求 ID 的内容变化必须由本机生成新 ID；批准绝不迁移到另一组参数。
      if (old && old.frozen !== frozen) throw new IdentityError('Approval request changed; use a new request ID', 409);
      staged.set(key,old ?? {deviceId:device.id,version:device.version,request,frozen});
    }
    const combined=new Map([...this.entries,...staged]);
    if (combined.size > 8192 || [...combined.values()].filter(entry=>entry.deviceId===device.id).length > 512 || [...combined.values()].reduce((bytes,entry)=>bytes+Buffer.byteLength(entry.frozen),0) > 16*1024*1024) throw new IdentityError('Mobile approval service is busy',429);
    for(const [key,entry] of this.entries) if(entry.deviceId===device.id && !staged.has(key)) entry.active=false;
    const decisions:MobileApprovalDecision[]=[];
    for(const [key,entry] of staged) {
      entry.active=true;this.entries.set(key,entry);
      if(entry.decision && !entry.delivered) { decisions.push(structuredClone(entry.decision));entry.delivered=true; }
    }
    return {deviceId:device.id,version:device.version,decisions};
  }
  list(ownerId: string) {
    this.sweep();const devices=this.devices();
    return {requests:[...this.entries.values()].filter(e=>e.active && !e.decision && devices.some(d=>d.id===e.deviceId&&d.ownerId===ownerId)).map(e=>({deviceId:e.deviceId,deviceName:devices.find(d=>d.id===e.deviceId)!.name,...structuredClone(e.request)}))};
  }
  decide(device: Device, input: unknown) {
    this.sweep();const r=input as Record<string,unknown>;
    if(!r || typeof r!=='object' || Array.isArray(r)) fail();identity(r);
    if(Object.keys(r).sort().join()!=='approve,digest,id,kind,visibility' || typeof r.approve!=='boolean' || !['local','client'].includes(String(r.visibility))) fail();
    const entry=this.entries.get(`${device.id}:${device.version}:${r.kind}:${r.id}`);
    if(!entry || !entry.active || entry.request.digest!==r.digest || entry.decision || device.revokedAt) throw new IdentityError('Approval request expired, changed, or was already decided',409);
    entry.decision=structuredClone(r) as unknown as MobileApprovalDecision;return {ok:true};
  }
}
