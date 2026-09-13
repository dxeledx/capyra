import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MobileApprovals} from '../src/identity/mobile-approvals.js';
import {startIdentityCloud} from '../src/identity/cloud.js';
import {createIdentityService} from '../src/identity/client.js';
import {signProof} from '../src/identity/security.js';
const makeRequest=()=>({id:'task_1',kind:'task' as const,digest:'a'.repeat(64),description:'Read synthetic README',workspace:'/synthetic',details:{tool:'workspace__read',args:{path:'README.md'}},expiresAt:Date.now()+60000});
test('mobile approval snapshot freezes details, scopes owners, and delivers a decision once',()=>{
 const device={id:'dev-a',ownerId:'alice',name:'Mac',version:1};const store=new MobileApprovals(()=>[device]);const request=makeRequest();
 assert.deepEqual(store.sync(device,{requests:[request]}).decisions,[]);assert.equal(store.list('alice').requests.length,1);assert.equal(store.list('bob').requests.length,0);
 assert.throws(()=>store.sync(device,{requests:[{...request,details:{other:true}}]}),/changed/);
 const choice={id:request.id,kind:request.kind,digest:request.digest,approve:true,visibility:'local'};
 store.decide(device,choice);assert.throws(()=>store.decide(device,choice),/already decided/);assert.equal(store.list('alice').requests.length,0);
 assert.deepEqual(store.sync(device,{requests:[request]}),{deviceId:'dev-a',version:1,decisions:[choice]});assert.deepEqual(store.sync(device,{requests:[request]}).decisions,[]);
});
test('expired, removed, replaced-version and revoked requests cannot be approved; request sizes are bounded',()=>{
 const device={id:'dev-a',ownerId:'alice',name:'Mac',version:1,revokedAt:undefined as string|undefined};const store=new MobileApprovals(()=>[device]);const request=makeRequest();
 const choice={id:request.id,kind:request.kind,digest:request.digest,approve:true,visibility:'client'};
 assert.throws(()=>store.sync(device,{requests:[{...request,expiresAt:Date.now()-1}]}));assert.throws(()=>store.sync(device,{requests:[{...request,details:'x'.repeat(33000)}]}));assert.throws(()=>store.sync(device,{requests:Array(129).fill(request)}));
 store.sync(device,{requests:[request]});store.sync(device,{requests:[]});assert.throws(()=>store.decide(device,choice));assert.throws(()=>store.sync(device,{requests:[{...request,details:'changed'}]}));
 store.sync(device,{requests:[request]});device.version++;assert.throws(()=>store.decide(device,choice));store.sync(device,{requests:[request]});device.revokedAt=new Date().toISOString();assert.throws(()=>store.decide(device,choice));assert.equal(store.list('alice').requests.length,0);
});
test('mobile HTTP approval requires owner session and CSRF; prefixed cookies and static CSP are correct',async()=>{
 const root=await mkdtemp(join(tmpdir(),'capyra-mobile-'));const cloud=await startIdentityCloud({stateDir:join(root,'cloud'),publicBasePath:'/capyra'});const client=createIdentityService({stateDir:join(root,'client'),cloudUrl:cloud.url,pollIntervalMs:0});
 const post=(path:string,body:unknown,headers:Record<string,string>={})=>fetch(cloud.url+path,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)});
 try{
  await client.register({email:'mobile-owner@example.test',password:'synthetic mobile long password'});const pair=await client.startPairing();const device=(await client.bind({code:pair.code,scope:{workspaces:[root],capabilities:['workspace:read']}})).device!;
  const state=JSON.parse(await readFile(join(root,'client/identity/device.json'),'utf8'));const challenge=await(await post('/v1/device/challenge',{deviceId:device.id})).json();const auth=await(await post('/v1/device/authenticate',{deviceId:device.id,challenge:challenge.challenge,signature:signProof(state.privateKey,'authenticate',device.id,challenge.challenge)})).json();
  const request=makeRequest();const synced=await post('/v1/device/approvals/sync',{requests:[request]},{authorization:'Bearer '+auth.token});assert.equal(synced.status,200);assert.equal((await synced.json()).deviceId,device.id);
  assert.equal((await fetch(cloud.url+'/v1/approvals')).status,401);
  const login=await post('/v1/login',{email:'mobile-owner@example.test',password:'synthetic mobile long password'});assert.match(login.headers.getSetCookie()[0],/Path=\/capyra\/v1/);const cookie=login.headers.getSetCookie()[0].split(';')[0];const session=await login.json();
  const other=await post('/v1/register',{email:'mobile-other@example.test',password:'synthetic other long password'});const otherCookie=other.headers.getSetCookie()[0].split(';')[0],otherSession=await other.json();assert.equal((await(await fetch(cloud.url+'/v1/approvals',{headers:{cookie:otherCookie}})).json()).requests.length,0);
  const choice={id:request.id,kind:request.kind,digest:request.digest,approve:true,visibility:'local'},path='/v1/devices/'+device.id+'/approvals/decide';
  assert.equal((await post(path,choice,{cookie:otherCookie,origin:cloud.url,'x-csrf-token':otherSession.csrfToken})).status,404);
  assert.equal((await post(path,choice,{cookie,origin:cloud.url})).status,403);assert.equal((await post(path,choice,{cookie,origin:'https://evil.test','x-csrf-token':session.csrfToken})).status,403);
  assert.equal((await post(path,choice,{cookie,origin:cloud.url,'x-csrf-token':session.csrfToken})).status,200);assert.equal((await post(path,choice,{cookie,origin:cloud.url,'x-csrf-token':session.csrfToken})).status,409);
  const slash=await fetch(cloud.url+'/approve/',{redirect:'manual'});assert.equal(slash.status,308);assert.equal(slash.headers.get('location'),'/capyra/approve');
  const page=await fetch(cloud.url+'/approve');assert.equal(page.status,200);assert.match(page.headers.get('content-security-policy')!,/script-src 'self'/);assert.doesNotMatch(await page.text(),/<script[^>]*>[^<]+/);assert.equal((await fetch(cloud.url+'/approve-assets/app.js')).status,200);
 }finally{client.close();await cloud.close();await rm(root,{recursive:true,force:true});}
});
