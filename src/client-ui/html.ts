// HTML 只含通用界面。文件名、差异、规则均通过获准的 MCP 结果注入，并只使用 textContent。
// 宿主根据资源的 _meta.ui.csp 设置隔离策略；HTML 不叠加可能拦住宿主桥接脚本的 meta CSP。
export const cardHtml = String.raw`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Capyra 工作卡</title><style>
:root{color-scheme:light dark;--bg:#fbfaf6;--ink:#292c24;--muted:#697060;--line:#e2e5d9;--accent:#52683e;--soft:#eef2e8;--added:#24673c;--removed:#aa4441;--font:ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.55 var(--font)}main{padding:20px;max-width:1000px;margin:auto}header{display:flex;align-items:center;gap:10px;margin-bottom:18px}.mark{background:var(--accent);color:#fff;border-radius:12px;width:34px;height:34px;display:grid;place-items:center;font-weight:750}.brand{font-size:12px;letter-spacing:.13em;text-transform:uppercase;color:var(--muted)}h1{font-size:18px;line-height:1.35;margin:2px 0 0;font-weight:650}.badge{margin-left:auto;border:1px solid var(--line);border-radius:99px;padding:4px 9px;color:var(--muted);font-size:11px;white-space:nowrap}.empty{color:var(--muted);padding:14px 0}p{margin:8px 0}button,input{font:inherit}button{color:var(--ink);background:var(--bg);border:1px solid var(--line);border-radius:9px;padding:8px 12px;cursor:pointer}button:hover{background:var(--soft)}button:focus-visible,input:focus-visible,summary:focus-visible{outline:2px solid var(--accent);outline-offset:3px}button:disabled{opacity:.6;cursor:wait}.actions{display:flex;align-items:center;gap:10px;margin-top:16px;flex-wrap:wrap}.note{color:var(--muted);font-size:12px}.facts{display:grid;grid-template-columns:100px minmax(0,1fr);gap:8px 12px;margin:0}dt{color:var(--muted)}dd{margin:0;overflow-wrap:anywhere}.stats{display:flex;gap:16px;flex-wrap:wrap;border-block:1px solid var(--line);padding:12px 0;margin:14px 0}.plus{color:var(--added)}.minus{color:var(--removed)}input{background:var(--bg);color:var(--ink);border:1px solid var(--line);padding:9px 11px;border-radius:8px;width:100%;margin-bottom:12px}details{border:1px solid var(--line);border-radius:10px;margin:8px 0;overflow:hidden}summary{padding:10px 12px;cursor:pointer;font-weight:550;overflow-wrap:anywhere}summary span{float:right;font-size:12px;margin-left:12px;font-weight:400}pre{font:12px/1.7 ui-monospace,SFMono-Regular,Consolas,monospace;margin:0;overflow:auto;max-height:420px;border-top:1px solid var(--line);tab-size:4}pre .line{display:block;min-height:1.7em;padding:0 12px;width:max-content;min-width:100%}.line.plus{background:color-mix(in srgb,var(--added) 7%,transparent)}.line.minus{background:color-mix(in srgb,var(--removed) 7%,transparent)}.line.hunk{color:var(--accent);background:var(--soft)}ul{margin:0;padding:4px 18px 12px 30px}li{padding:3px 0;overflow-wrap:anywhere}#status{min-height:20px;margin-top:10px}#status:empty{display:none}@media(prefers-color-scheme:dark){:root{--bg:#22251f;--ink:#ecede8;--muted:#aab2a1;--line:#3e4536;--accent:#91ad76;--soft:#30372a;--added:#a0d5aa;--removed:#e7a3a0}.mark{color:#22251f}}:root[data-theme=dark]{--bg:#22251f;--ink:#ecede8;--muted:#aab2a1;--line:#3e4536;--accent:#91ad76;--soft:#30372a;--added:#a0d5aa;--removed:#e7a3a0}:root[data-theme=light]{--bg:#fbfaf6;--ink:#292c24;--muted:#697060;--line:#e2e5d9;--accent:#52683e;--soft:#eef2e8;--added:#24673c;--removed:#aa4441}@media(max-width:460px){main{padding:14px}.badge{display:none}.facts{grid-template-columns:70px minmax(0,1fr)}summary span{float:none;display:block;margin:3px 0 0}.stats{gap:12px}}
</style></head><body><main><header><div class="mark" aria-hidden="true">C</div><div><div class="brand">Capyra</div><h1 id="title">工作卡</h1></div><span class="badge" id="badge">来自你的电脑</span></header><section id="card" aria-live="polite"><p class="empty">等待已获准的工作区或审阅结果。</p></section><p id="status" class="note" role="status"></p></main>
<script>
(()=>{
  'use strict';
  const card=document.getElementById('card'),title=document.getElementById('title'),status=document.getElementById('status');
  const pending=new Map();let sequence=0,bridge=false,closed=false,revision=0,current=null;
  const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
  const text=value=>typeof value==='string'?value:'';
  function element(tag,value,className){const item=document.createElement(tag);if(value!==undefined)item.textContent=String(value);if(className)item.className=className;return item;}
  function notify(method,params){if(!closed&&window.parent!==window)window.parent.postMessage({jsonrpc:'2.0',method,params},'*');}
  function request(method,params,timeout=650000){
    if(closed||window.parent===window)return Promise.reject(new Error('此页面需要支持 MCP Apps 的客户端。'));
    const id='capyra-'+(++sequence);
    return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(new Error('请求已结束，请在客户端重新打开卡片。'));},timeout);pending.set(id,{resolve,reject,timer});window.parent.postMessage({jsonrpc:'2.0',id,method,params},'*');});
  }
  function hostContext(value){if(record(value)&&['light','dark'].includes(value.theme))document.documentElement.dataset.theme=value.theme;}
  function rawResult(value){
    if(!record(value))return null;
    if(record(value.structuredContent))return value.structuredContent;
    if(record(value.toolOutput))return value.toolOutput;
    return null;
  }
  function renderResult(result){
    const value=rawResult(result);revision++;status.textContent='';
    if(!value||!['workspace','review'].includes(value.kind)||value.version!==1){current=null;card.replaceChildren(element('p',result&&result.isError?'请求未完成，请查看本机确认状态。':'暂无可展示的已获准结果。','empty'));return;}
    current=value;card.replaceChildren();
    if(value.kind==='workspace')workspace(value);else review(value);
    notify('ui/notifications/size-changed',{height:document.documentElement.scrollHeight});
  }
  function facts(entries){const list=element('dl',undefined,'facts');for(const [key,value] of entries){list.append(element('dt',key),element('dd',value));}card.append(list);}
  function catalog(label,items,labelFor){if(!Array.isArray(items)||!items.length)return;const box=element('details'),list=element('ul');box.append(element('summary',label+' · '+items.length));for(const item of items.slice(0,200))if(record(item))list.append(element('li',labelFor(item)));box.append(list);card.append(box);}
  function workspace(value){
    title.textContent=text(value.name)||'工作区';
    const git=record(value.git)?value.git:{};
    facts([['目录',text(value.root)],['分支',text(git.branch)||(git.available?'分离 HEAD':'未启用 Git')],['版本',text(git.head).slice(0,12)||'—']]);
    const count=Array.isArray(git.entries)?git.entries.length:0;
    card.append(element('p',git.available?(count?count+' 个文件有变化':'工作目录干净'):'此目录可以使用文件与终端能力。','note'));
    if(git.available){const review=record(value.review)?value.review:{};card.append(element('p',review.available?'工作区审阅基线已准备。':'工作区审阅暂不可用，请查看本机诊断。','note'));}
    catalog('工作区规则',value.rules,item=>text(item.path));
    catalog('可用 Skills',value.skills,item=>text(item.name)+(item.description?' · '+text(item.description):''));
  }
  function review(value){
    title.textContent='变更审阅';
    const files=Array.isArray(value.files)?value.files.filter(record):null;
    const summary=record(value.summary)?value.summary:{};
    const stats=element('div',undefined,'stats');
    stats.append(element('span',(Number.isInteger(summary.files)?summary.files:files?files.length:0)+' 个文件'),element('span','+'+(Number.isInteger(summary.additions)?summary.additions:0),'plus'),element('span','−'+(Number.isInteger(summary.removals)?summary.removals:0),'minus'));card.append(stats);
    if(value.createdAt){const date=new Date(value.createdAt);const scope=value.scope==='workspace'?(value.since==='workspace_open'?'自打开工作区以来':'自上次展示以来'):(value.staged?'暂存区':'未暂存的已跟踪文件');card.append(element('p','审阅快照 · '+(Number.isFinite(date.getTime())?date.toLocaleString():text(value.createdAt))+' · '+scope,'note'));}
    if(value.baselineCreated)card.append(element('p','已为此工作区建立初始基线，后续变化会与它比较。','note'));
    if(Array.isArray(value.skipped)&&value.skipped.length){const reasons={large_file:'文件超过大小上限',unsupported_path:'路径类型不支持',unreadable:'文件不可读',excluded:'当前已排除内容比较'};catalog('未纳入内容比较的文件',value.skipped,item=>text(item.path)+' · '+(reasons[item.reason]||'内容不可用'));}
    if(value.truncated)card.append(element('p','差异达到显示上限，此快照保留了部分内容。','note'));
    if(files){
      if(!files.length)card.append(element('p','这份快照没有可显示的差异。','empty'));
      const filter=element('input');filter.type='search';filter.placeholder='查找文件';filter.setAttribute('aria-label','查找变更文件');
      const list=element('div');let shown=[];
      for(const file of files.slice(0,500)){
        const box=element('details'),heading=element('summary',text(file.path));
        heading.append(element('span',file.binary?'二进制变化':file.contentOmitted?'内容未显示':'+'+(file.additions||0)+'  −'+(file.removals||0),'note'));box.append(heading);
        // 延迟创建差异节点，收起的大文件不增加浏览器常驻 DOM 成本。
        box.addEventListener('toggle',()=>{if(box.open&&!box.querySelector('pre')){const pre=element('pre');pre.setAttribute('aria-label',text(file.path)+' 的差异');const lines=text(file.patch).split('\n');if(file.contentOmitted&&!file.patch)pre.append(element('span',file.binary?'此文件的二进制内容没有发送到客户端。':'此文件的内容未纳入本次显示，请查看快照范围说明。','line'));for(const line of lines.slice(0,10000))pre.append(element('span',line,'line '+(line.startsWith('+')?'plus':line.startsWith('-')?'minus':line.startsWith('@@')?'hunk':'')));if(lines.length>10000)pre.append(element('span','卡片显示前 10000 行，完整快照见工具文本结果。','line'));box.append(pre);}notify('ui/notifications/size-changed',{height:document.documentElement.scrollHeight});});
        shown.push({box,path:text(file.path).toLocaleLowerCase()});list.append(box);
      }
      if(files.length>3){filter.addEventListener('input',()=>{for(const item of shown)item.box.hidden=!item.path.includes(filter.value.toLocaleLowerCase());});card.append(filter);}card.append(list);if(files.length>500)card.append(element('p','卡片显示前 500 个文件，完整列表见工具文本结果。','note'));
    }else card.append(element('p','客户端保留了审阅引用。读取原始快照需要电脑主人确认。','empty'));
    if(/^[a-f0-9]{64}$/.test(text(value.workspaceId))&&/^[a-f0-9-]{36}$/.test(text(value.reviewRef))){
      const actions=element('div',undefined,'actions'),button=element('button',files?'重新读取此快照':'读取审阅快照');
      button.type='button';button.addEventListener('click',async()=>{
        const turn=revision;button.disabled=true;status.textContent='等待电脑主人确认此次读取…';
        try{
          const args={workspaceId:value.workspaceId,reviewRef:value.reviewRef};
          const response=bridge?await request('tools/call',{name:'client-ui__review',arguments:args}):window.openai&&typeof window.openai.callTool==='function'?await window.openai.callTool('client-ui__review',args):await request('tools/call',{name:'client-ui__review',arguments:args});
          if(turn===revision)renderResult(response);
        }catch(error){if(turn===revision)status.textContent='无法读取此快照，请检查本机审批、工作区和连接。';}
        finally{button.disabled=false;}
      });actions.append(button,element('span','每次读取都需本机确认','note'));card.append(actions);
    }
  }
  function globals(value){if(!record(value))return;hostContext(value);if(record(value.toolOutput))renderResult({structuredContent:value.toolOutput});}
  function onMessage(event){
    if(closed||event.source!==window.parent||!record(event.data)||event.data.jsonrpc!=='2.0')return;
    const message=event.data;
    if(message.id!==undefined&&pending.has(message.id)){const item=pending.get(message.id);clearTimeout(item.timer);pending.delete(message.id);if(message.error)item.reject(new Error('客户端请求失败'));else item.resolve(message.result);return;}
    if(message.method==='ui/notifications/tool-result')renderResult(message.params);
    if(message.method==='ui/notifications/host-context-changed')hostContext(message.params);
    if(message.method==='ui/notifications/tool-cancelled'){revision++;status.textContent='此次调用已取消。';}
    if(message.method==='ui/resource-teardown'&&message.id!==undefined){window.parent.postMessage({jsonrpc:'2.0',id:message.id,result:{}},'*');dispose();}
  }
  function onGlobals(event){globals(event.detail&&event.detail.globals||window.openai);}
  function dispose(){closed=true;window.removeEventListener('message',onMessage);window.removeEventListener('openai:set_globals',onGlobals);for(const item of pending.values()){clearTimeout(item.timer);item.reject(new Error('卡片已关闭'));}pending.clear();card.replaceChildren();current=null;}
  window.addEventListener('message',onMessage);window.addEventListener('openai:set_globals',onGlobals);window.addEventListener('pagehide',dispose,{once:true});
  globals(window.openai);
  if(window.parent!==window)request('ui/initialize',{appInfo:{name:'Capyra workspace cards',version:'1.0.0'},appCapabilities:{},protocolVersion:'2026-01-26'},10000).then(result=>{bridge=true;hostContext(result&&result.hostContext);notify('ui/notifications/initialized',{});}).catch(()=>{if(!current)status.textContent='客户端暂未提供卡片桥接；工具的文本结果仍可查看。';});
})();
</script></body></html>`;
