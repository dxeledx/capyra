const encoder = new TextEncoder();
const MAX_REQUEST = 128 * 1024, MAX_RESPONSE = 1024 * 1024;
const json = (data, status = 200, extra = {}) => new Response(JSON.stringify(data), {status, headers: {'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff',...extra}});
const stmt = (env, sql, ...args) => env.DB.prepare(sql).bind(...args);
const bytes = value => Uint8Array.from(atob(value.replace(/-/g,'+').replace(/_/g,'/')), c=>c.charCodeAt(0));
const base64 = data => { let result=''; for(let i=0;i<data.length;i+=8192) result+=String.fromCharCode(...data.subarray(i,i+8192)); return btoa(result); };
const hash = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',value))).map(v=>v.toString(16).padStart(2,'0')).join('');
const fail = (status,message) => { throw Object.assign(new Error(message),{status}); };
async function body(request,limit) {
  if(Number(request.headers.get('content-length'))>limit) fail(413,'请求内容过大');
  if(!request.body) return new Uint8Array();
  const reader=request.body.getReader(); const parts=[]; let size=0;
  while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>limit){await reader.cancel();fail(413,'请求内容过大');}parts.push(value);}
  const result=new Uint8Array(size);let at=0;for(const part of parts){result.set(part,at);at+=part.length;}return result;
}
function parse(raw){try{return JSON.parse(new TextDecoder().decode(raw));}catch{fail(400,'无效 JSON');}}
function sameToken(a,b){if(typeof a!=='string'||typeof b!=='string'||a.length!==b.length)return false;let diff=0;for(let i=0;i<a.length;i++)diff|=a.charCodeAt(i)^b.charCodeAt(i);return diff===0;}
async function signedDevice(request,env,id,raw){
  const device=await stmt(env,'SELECT * FROM devices WHERE id=? AND revoked=0',id).first();
  if(!device)fail(401,'设备未登记或已撤销');
  const time=request.headers.get('x-capyra-time')??'', nonce=request.headers.get('x-capyra-nonce')??'', signature=request.headers.get('x-capyra-signature')??'';
  if(!/^\d{13}$/.test(time)||Math.abs(Date.now()-Number(time))>60000||! /^[a-zA-Z0-9_-]{16,80}$/.test(nonce))fail(401,'设备签名已过期');
  let valid=false;
  try{const key=await crypto.subtle.importKey('spki',bytes(device.public_key),{name:'Ed25519'},false,['verify']);
    valid=await crypto.subtle.verify('Ed25519',key,bytes(signature),encoder.encode(`${request.method}\n${new URL(request.url).pathname}\n${time}\n${nonce}\n${await hash(raw)}`));
  }catch{}
  if(!valid)fail(401,'设备签名无效');
  // 签名绑定方法、路径和正文；原子插入随机数，防止跨请求重放。
  const consumed=await stmt(env,'INSERT OR IGNORE INTO nonces(id,expires_at) VALUES(?,?)',`${id}:${nonce}`,Date.now()+120000).run();
  if(!consumed.meta.changes)fail(409,'请求已使用');
  return device;
}
const requestHeaders=['authorization','content-type','accept','origin','mcp-session-id','mcp-protocol-version','mcp-method','mcp-name','last-event-id'];
const responseHeaders=['content-type','location','www-authenticate','mcp-session-id','mcp-protocol-version','allow','retry-after','content-security-policy','referrer-policy','access-control-allow-origin','access-control-allow-headers','access-control-expose-headers','access-control-allow-methods','vary'];
const permittedPath = p => ['/mcp','/health','/authorize','/token','/register','/revoke','/.well-known/oauth-authorization-server','/.well-known/oauth-protected-resource','/.well-known/oauth-protected-resource/mcp'].includes(p)||/^\/oauth\/pending\/[A-Za-z0-9_-]{43}$/.test(p);
function route(url){
  const match=url.pathname.match(/^\/devices\/([a-f0-9-]{36})(\/.*)?$/);
  if(match)return {id:match[1],path:match[2]??'/'};
  // OAuth discovery 在域名根路径携带资源路径；转交本机的同类元数据路由。
  const discovery=url.pathname.match(/^\/\.well-known\/(oauth-authorization-server|oauth-protected-resource)\/devices\/([a-f0-9-]{36})(\/mcp)?$/);
  if(discovery)return {id:discovery[2],path:`/.well-known/${discovery[1]}${discovery[1]==='oauth-protected-resource'?'/mcp':''}`};
}
async function cleanup(env){await env.DB.batch([stmt(env,'DELETE FROM requests WHERE expires_at<?',Date.now()),stmt(env,'DELETE FROM nonces WHERE expires_at<?',Date.now())]);}
async function relay(request,env,target,url,ctx){
  if(!permittedPath(target.path)||!['GET','POST','DELETE','OPTIONS','HEAD'].includes(request.method))return json({error:'Not found'},404);
  if(target.path==='/mcp'&&request.method==='GET')return json({error:'Use MCP Streamable HTTP POST; standalone event streams are not enabled.'},405,{allow:'POST, DELETE, OPTIONS'});
  const device=await stmt(env,'SELECT seen_at,revoked FROM devices WHERE id=?',target.id).first();
  if(!device||device.revoked)return json({error:'Device not found'},404);
  if(Date.now()-device.seen_at>20000)return json({error:'device_offline',message:'请启动本机 Capyra 并保持连接。'},503,{'retry-after':'5'});
  const raw=await body(request,MAX_REQUEST); const headers={};for(const key of requestHeaders){const v=request.headers.get(key);if(v)headers[key]=v;}
  const id=crypto.randomUUID(),now=Date.now();
  const payload=JSON.stringify({id,method:request.method,path:target.path+url.search,headers,body:base64(raw)});
  // 每台设备的未完成请求有上限，条件插入在数据库中原子完成。
  const added=await stmt(env,"INSERT INTO requests(id,device_id,payload,state,created_at,expires_at) SELECT ?,?,?,'queued',?,? WHERE (SELECT count(*) FROM requests WHERE device_id=? AND expires_at>? AND state!='done')<24",id,target.id,payload,now,now+120000,target.id,now).run();
  if(!added.meta.changes)return json({error:'device_busy'},429,{'retry-after':'3'});
  try{
    while(Date.now()-now<100000&&!request.signal.aborted){
      const result=await stmt(env,'SELECT response FROM requests WHERE id=? AND device_id=?',id,target.id).first();
      if(result?.response){const data=JSON.parse(result.response);const outgoing=new Headers({'cache-control':'no-store','x-content-type-options':'nosniff'});
        for(const key of responseHeaders){if(typeof data.headers?.[key]==='string')outgoing.set(key,data.headers[key]);}
        // OAuth 页面不能与其他设备页面共享脚本权限；本机随机 pending URL 允许 opaque origin 轮询。
        if((outgoing.get('content-type')??'').includes('text/html'))outgoing.set('content-security-policy',"sandbox allow-scripts allow-forms allow-top-navigation; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src "+url.origin);
        return new Response([204,205,304].includes(data.status)||request.method==='HEAD'?null:bytes(data.body),{status:data.status,headers:outgoing});
      }
      await new Promise(resolve=>setTimeout(resolve,3000));
    }
    return json({error:'request_timeout',message:'请求未及时返回，请先在本机查看任务状态，避免重复执行。'},504);
  }finally{
    // 返回或客户端断开即删除临时正文；意外终止的残留由后续设备心跳按到期时间清理。
    ctx.waitUntil(stmt(env,'DELETE FROM requests WHERE id=? AND device_id=?',id,target.id).run());
  }
}
async function handle(request,env,ctx){
  const url=new URL(request.url);
  if(url.pathname==='/'&&request.method==='GET')return new Response(page,{headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store','content-security-policy':"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",'x-content-type-options':'nosniff'}});
  if(url.pathname==='/health'&&request.method==='GET')return json({service:'capyra-sites',ok:true});
  if(!env.DB)return json({error:'storage_unavailable'},503);
  if(url.pathname==='/api/devices'&&request.method==='POST'){
    const data=parse(await body(request,8192));
    if(!env.ENROLLMENT_TOKEN||!sameToken(data.token,env.ENROLLMENT_TOKEN))fail(403,'需要有效的设备接入码');
    if(typeof data.publicKey!=='string'||data.publicKey.length>256||typeof data.name!=='string'||data.name.length>120)fail(400,'设备信息无效');
    try{await crypto.subtle.importKey('spki',bytes(data.publicKey),{name:'Ed25519'},false,['verify']);}catch{fail(400,'设备公钥无效');}
    // 注册重试按公钥复用设备，避免响应丢失产生多个入口；私钥始终留在本机。
    const existing=await stmt(env,'SELECT id,revoked FROM devices WHERE public_key=?',data.publicKey).first();
    if(existing?.revoked)fail(403,'该设备已撤销');
    const id=existing?.id??crypto.randomUUID();
    if(!existing)await stmt(env,'INSERT INTO devices(id,public_key,name,created_at,seen_at) VALUES(?,?,?,?,?)',id,data.publicKey,data.name,Date.now(),0).run();
    return json({deviceId:id,publicUrl:`${url.origin}/devices/${id}`});
  }
  const api=url.pathname.match(/^\/api\/devices\/([a-f0-9-]{36})\/(poll|replies|revoke)$/);
  if(api&&request.method==='POST'){
    const raw=await body(request,api[2]==='replies'?MAX_RESPONSE*1.4:8192);const device=await signedDevice(request,env,api[1],raw);const data=parse(raw);const now=Date.now();
    if(api[2]==='poll'){
      // 不重新投递已领取请求：断线后不会重复执行文件写入或命令。
      await stmt(env,'UPDATE devices SET seen_at=? WHERE id=?',now,device.id).run();
      const capacity=Number.isInteger(data.capacity)&&data.capacity>=0&&data.capacity<=8?data.capacity:8;
      const claims=await stmt(env,"UPDATE requests SET state='claimed' WHERE id IN (SELECT id FROM requests WHERE device_id=? AND state='queued' AND expires_at>? ORDER BY created_at LIMIT ?) RETURNING payload",device.id,now,capacity).all();
      ctx.waitUntil(cleanup(env));
      return json({requests:claims.results.map(row=>JSON.parse(row.payload))});
    }
    if(api[2]==='revoke'){
      await env.DB.batch([stmt(env,'UPDATE devices SET revoked=1 WHERE id=?',device.id),stmt(env,'DELETE FROM requests WHERE device_id=?',device.id)]);return json({ok:true});
    }
    if(typeof data.id!=='string'||!Number.isInteger(data.status)||data.status<200||data.status>599||typeof data.body!=='string'||!data.headers||typeof data.headers!=='object')fail(400,'响应无效');
    try{if(bytes(data.body).length>MAX_RESPONSE)fail(413,'响应内容过大');}catch(error){if(error.status)throw error;fail(400,'响应编码无效');}
    const safeHeaders={};for(const key of responseHeaders){const value=data.headers[key];if(typeof value==='string'&&value.length<16000&&!/[\r\n]/.test(value))safeHeaders[key]=value;}
    const response=JSON.stringify({status:data.status,headers:safeHeaders,body:data.body});
    if(encoder.encode(response).length>1900000)fail(413,'响应内容过大');
    // 响应幂等且不可覆盖，设备只能提交自己的请求。
    const saved=await stmt(env,"UPDATE requests SET response=?,state='done',payload='' WHERE id=? AND device_id=? AND state='claimed' AND expires_at>?",response,data.id,device.id,now).run();
    if(!saved.meta.changes){const prior=await stmt(env,"SELECT id FROM requests WHERE id=? AND device_id=? AND state='done'",data.id,device.id).first();if(!prior)return json({error:'request_expired'},410);}
    return json({ok:true});
  }
  const target=route(url);if(target)return relay(request,env,target,url,ctx);
  return json({error:'Not found'},404);
}
export default {async fetch(request,env,ctx){try{return await handle(request,env,ctx);}catch(error){return json({error:error.status?error.message:'服务暂时不可用，请稍后重试'},error.status??503);}}};
const page=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Capyra · 连接你的工作区</title><style>:root{font-family:system-ui,-apple-system,sans-serif;color:#243b33;background:#f5f4ee}*{box-sizing:border-box}body{margin:0}main{max-width:980px;margin:auto;padding:48px 24px}header{display:flex;align-items:center;gap:12px;font-weight:700}header span{background:#dbe8db;border-radius:14px;padding:12px}h1{font-size:clamp(36px,7vw,64px);letter-spacing:-2px;line-height:1.15;margin:72px 0 24px}p{line-height:1.8;color:#596d62;max-width:650px}.cards{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin:48px 0}article{background:#fff;border:1px solid #e0e6dd;padding:24px;border-radius:22px}h2{font-size:20px}article b{color:#567f61;font-size:14px}.foot{border-top:1px solid #dbe0d5;padding-top:24px;font-size:14px}code{font-size:14px;background:#edf0e8;padding:3px 7px;border-radius:6px}@media(max-width:680px){.cards{grid-template-columns:1fr}h1{margin-top:48px}}</style><main><header><span>◒</span> Capyra Connect</header><h1>一个固定入口。<br>连接你自己的电脑。</h1><p>在 ChatGPT 中使用本机工作区。文件、Git 和命令由电脑上的 Capyra 执行，连接权限由你在本机管理。</p><section class="cards"><article><b>01 · 本机</b><h2>启动 Capyra</h2><p>打开本机工作台，在“连接”中选择 Sites 固定连接，填写接入码并启动。</p></article><article><b>02 · 客户端</b><h2>添加到 ChatGPT</h2><p>复制本机工作台生成的专属 MCP 地址，选择 OAuth，完成一次连接授权。</p></article><article><b>03 · 工作区</b><h2>按你的设置执行</h2><p>选择逐次确认或自动批准，随时在本机暂停访问、撤销授权或停止连接。</p></article></section><p class="foot">此页面是连接说明。设备是否在线、授权是否完成，以及是否收到实际调用，请在本机 Capyra 工作台查看。电脑需要保持运行并能够访问此服务。</p></main></html>`;
