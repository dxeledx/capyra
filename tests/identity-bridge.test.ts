import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import dns from 'node:dns/promises';
import https from 'node:https';
import { startIdentityCloud } from '../src/identity/cloud.js';
import { createIdentityService } from '../src/identity/client.js';
import { secret, signProof } from '../src/identity/security.js';
import { bridgeRoute, bridgeUpstream, publicBridgeAddress } from '../src/identity/cloud-bridge.js';

test('bridge origin and route allowlists reject private targets, controls, encoded paths and redirects', () => {
  assert.equal(bridgeUpstream('https://sample-device.trycloudflare.com/'), 'https://sample-device.trycloudflare.com');
  for (const value of ['http://sample.trycloudflare.com','https://sample.trycloudflare.com:444','https://sample.trycloudflare.com/path','https://sample.trycloudflare.com@127.0.0.1','https://sample.trycloudflare.com.evil.test','https://a.b.trycloudflare.com']) assert.throws(() => bridgeUpstream(value));
  for (const address of ['127.0.0.1','10.1.1.1','100.64.0.1','169.254.169.254','192.168.0.1','198.18.0.1','::1','::ffff:127.0.0.1','fc00::1','2001:db8::1']) assert.equal(publicBridgeAddress(address), false, address);
  assert.equal(publicBridgeAddress('104.16.1.1'), true);
  for (const path of ['/api/state','/console','/mcp/../api/state','/%6dcp','//mcp','/oauth/pending/../../api']) assert.equal(bridgeRoute('GET', path), false);
});

test('signed device bridge preserves bytes and stream while enforcing proof, DNS, lease, route and revocation', async t => {
  const root = await mkdtemp(join(tmpdir(), 'capyra-bridge-'));
  const cloud = await startIdentityCloud({ stateDir: join(root,'cloud'), publicBasePath: '/capyra' });
  const local = createIdentityService({ stateDir: join(root,'local'), cloudUrl: cloud.url, pollIntervalMs: 0 });
  const observed: {path: string; body: string; headers: Record<string,string>}[] = [];
  let privateDns = false; let dnsMissing = false; let publicDnsMissing = false; let redirect = false; let hold = false; let incoming: PassThrough | undefined;
  t.mock.method(dns, 'lookup', async () => { if(dnsMissing)throw Object.assign(new Error('missing'),{code:'ENOTFOUND'});return [{ address: privateDns ? '127.0.0.1' : '104.16.1.1', family: 4 }]; });
  t.mock.method(dns.Resolver.prototype,'resolve4',async()=>{if(publicDnsMissing)throw Object.assign(new Error('missing'),{code:'ENOTFOUND'});return ['104.16.1.1'];});
  t.mock.method(https, 'request', (options: any, callback: any) => {
    let body='';
    const request = new Writable({ write(chunk, _encoding, done) { body += chunk.toString(); done(); }, final(done) {
      observed.push({path:options.path,body,headers:options.headers});
      incoming = Object.assign(new PassThrough(), { statusCode: redirect ? 302 : 200, headers: redirect ? {location:'http://127.0.0.1/private'} : {'content-type':'text/event-stream','content-security-policy':"default-src 'self'"} });
      callback(incoming); incoming.write('data: first\n\n'); if (!hold) incoming.end('data: second\n\n'); done();
    }});
    Object.assign(request, {setTimeout(){return request;}}); return request;
  });
  const call = async (method: string, body?: unknown, token?: string) => fetch(cloud.url+'/v1/device/bridge', {method,headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},...(body === undefined?{}:{body:JSON.stringify(body)})});
  try {
    await local.register({email:'bridge@example.test',password:'bridge synthetic password long'});
    const pair=await local.startPairing();const bound=await local.bind({code:pair.code,scope:{workspaces:[root],capabilities:['workspace:read']}});const device=bound.device!;
    const state=JSON.parse(await readFile(join(root,'local/identity/device.json'),'utf8'));
    const challenge=await(await fetch(cloud.url+'/v1/device/challenge',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({deviceId:device.id})})).json();
    const auth=await(await fetch(cloud.url+'/v1/device/authenticate',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({deviceId:device.id,challenge:challenge.challenge,signature:signProof(state.privateKey,'authenticate',device.id,challenge.challenge)})})).json();
    const proof=(upstream='https://sample-device.trycloudflare.com',life=120000)=>{const nonce=secret(),expiresAt=Date.now()+life;return{upstream,nonce,expiresAt,signature:signProof(state.privateKey,'connection-bridge',device.id,device.version,upstream,nonce,expiresAt)}};
    assert.equal((await call('POST',proof())).status,401);
    const first=proof();assert.equal((await call('POST',{...first,signature:'invalid'},auth.token)).status,403);
    const registered=await call('POST',first,auth.token);assert.equal(registered.status,200);assert.equal((await registered.json()).publicUrl,cloud.url+'/capyra/devices/'+device.id+'/bridge');
    assert.equal((await call('POST',first,auth.token)).status,403);
    assert.equal((await call('POST',proof('https://127.0.0.1'),auth.token)).status,400);
    const url=cloud.url+'/devices/'+device.id+'/bridge';
    assert.equal((await fetch(url+'/api/state')).status,404);
    const response=await fetch(url+'/mcp?literal=a%2Bb',{method:'POST',headers:{'content-type':'application/json',cookie:'capyra_account=must-not-forward',authorization:'Bearer oauth-example','x-forwarded-host':'evil.test'},body:'{ "literal": 1 }'});
    assert.match(response.headers.get('content-security-policy')!,/sandbox allow-scripts allow-forms allow-top-navigation/);assert.equal(await response.text(),'data: first\n\ndata: second\n\n');
    assert.equal(observed.at(-1)!.path,'/mcp?literal=a%2Bb');assert.equal(observed.at(-1)!.body,'{ "literal": 1 }');assert.equal(observed.at(-1)!.headers.cookie,undefined);assert.equal(observed.at(-1)!.headers['x-forwarded-host'],undefined);
    assert.equal((await fetch(cloud.url+'/.well-known/oauth-authorization-server/capyra/devices/'+device.id+'/bridge')).status,200);
    assert.equal((await fetch(cloud.url+'/.well-known/oauth-authorization-server/capyra/devices/'+device.id+'/bridge/')).status,200);assert.equal(observed.at(-1)!.path,'/.well-known/oauth-authorization-server');
    assert.equal((await fetch(cloud.url+'/.well-known/oauth-protected-resource/capyra/devices/'+device.id+'/bridge/mcp/')).status,200);assert.equal(observed.at(-1)!.path,'/.well-known/oauth-protected-resource/mcp');
    assert.equal((await fetch(url+'/mcp',{method:'POST',headers:{'content-type':'application/json'},body:'x'.repeat(1024*1024+1)})).status,413);
    const poll=await fetch(url+'/oauth/pending/'+('opaque_proof_'.padEnd(43,'x')),{headers:{origin:'null'}});assert.equal(poll.status,200);assert.equal(poll.headers.get('access-control-allow-origin'),'null');assert.equal(observed.at(-1)!.headers.origin,undefined);
    assert.equal((await fetch(url+'/mcp',{headers:{origin:'null'}})).status,403);
    privateDns=true;assert.equal((await fetch(url+'/mcp')).status,502);privateDns=false;
    dnsMissing=true;assert.equal((await fetch(url+'/health')).status,200);publicDnsMissing=true;assert.equal((await fetch(url+'/health')).status,502);dnsMissing=false;publicDnsMissing=false;
    redirect=true;assert.equal((await fetch(url+'/authorize',{redirect:'manual'})).status,502);redirect=false;
    const short=proof(undefined,50);assert.equal((await call('POST',short,auth.token)).status,200);await new Promise(r=>setTimeout(r,80));assert.equal((await fetch(url+'/mcp')).status,410);
    const removeNonce=secret(),removeExpires=Date.now()+120000;
    const removeBody={nonce:removeNonce,expiresAt:removeExpires,signature:signProof(state.privateKey,'connection-bridge-remove',device.id,device.version,removeNonce,removeExpires)};
    assert.equal((await call('DELETE',removeBody,auth.token)).status,200);
    assert.equal((await call('GET',undefined,auth.token)).status,404);
    assert.equal((await call('DELETE',removeBody,auth.token)).status,403);
    assert.equal((await call('POST',proof(),auth.token)).status,200);hold=true;
    const stream=await fetch(url+'/mcp');const reader=stream.body!.getReader();assert.equal((await reader.read()).done,false);
    await local.revokeDevice(device.id);await assert.rejects(reader.read());assert.equal((await fetch(url+'/mcp')).status,410);assert.equal((await call('GET',undefined,auth.token)).status,401);
  } finally { incoming?.destroy();local.close();await cloud.close();await rm(root,{recursive:true,force:true}); }
});
