'use strict';
const base=location.pathname.replace(/\/approve\/?$/,'');
const key='capyra-mobile-csrf:'+base;
let csrf=sessionStorage.getItem(key)||'',signedIn=false,loading=false,loggingIn=false,last='',expiresAt=0;
const $=id=>document.getElementById(id);
function message(text,error=false){$('message').textContent=text;$('message').classList.toggle('error',error);}
function remember(value){csrf=value;value?sessionStorage.setItem(key,value):sessionStorage.removeItem(key);}
async function api(path,body){
  // 超时覆盖响应头和 JSON 响应体，避免轮询永久占住 loading。
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),8000);
  try{
    const response=await fetch(base+'/v1'+path,{signal:controller.signal,method:body===undefined?'GET':'POST',credentials:'same-origin',cache:'no-store',headers:body===undefined?{}:{'content-type':'application/json','x-csrf-token':csrf},...(body===undefined?{}:{body:JSON.stringify(body)})});
    const data=await response.json();
    if(!response.ok){if(response.status===401){remember('');signedIn=false;view();}const error=new Error(data.error||'请求暂时无法完成');error.status=response.status;throw error;}
    return data;
  }catch(error){
    if(controller.signal.aborted)throw new Error(body===undefined?'连接超时，页面会自动重试，也可以点击刷新。':'连接超时，尚未确认操作结果；请刷新请求列表后再核对。');
    if(error instanceof TypeError)throw new Error('网络连接暂不可用，页面会自动重试；操作结果以刷新后的请求状态为准。');
    if(error instanceof SyntaxError)throw new Error('暂未收到完整响应，页面会自动重试。');
    throw error;
  }finally{clearTimeout(timer);}
}
function view(){$('login').hidden=signedIn;$('account').hidden=!signedIn;if(!signedIn){$('requests').replaceChildren();last='';}}
function textElement(tag,text){const element=document.createElement(tag);element.textContent=text;return element;}
function render(requests){const serialized=JSON.stringify(requests);if(serialized===last)return;last=serialized;$('requests').replaceChildren();if(!requests.length){$('requests').append(textElement('p','目前没有等待确认的请求。'));return;}
for(const request of requests){const card=document.createElement('article');card.className='request';card.append(textElement('h2',request.description));const info=document.createElement('dl');for(const [label,value] of [['设备',request.deviceName],['工作区',request.workspace],['请求类型',request.kind==='task'?'执行任务':'读取或连接'],['到期时间',new Date(request.expiresAt).toLocaleTimeString()],['请求编号',request.id],['核验摘要',request.digest]]){info.append(textElement('dt',label),textElement('dd',value));}card.append(info,textElement('h3','完整请求详情'),textElement('pre',JSON.stringify(request.details,null,2)));
const label=document.createElement('label'),checkbox=document.createElement('input');checkbox.type='checkbox';label.append(checkbox,document.createTextNode('允许将结果返回 ChatGPT 共享对话'));card.append(label,textElement('small','默认仅本机保存结果。每个请求都需要单独确认。'));
const actions=document.createElement('div');actions.className='actions';for(const [approve,title,style] of [[true,'批准这一次','primary'],[false,'拒绝','danger']]){const button=textElement('button',title);button.className=style;button.type='button';button.onclick=async()=>{let confirmed=false;for(const b of actions.querySelectorAll('button'))b.disabled=true;try{await api('/devices/'+encodeURIComponent(request.deviceId)+'/approvals/decide',{id:request.id,kind:request.kind,digest:request.digest,approve,visibility:checkbox.checked?'client':'local'});confirmed=true;message(approve?'已确认这一次请求，等待电脑接收决定。':'已拒绝这一次请求。');last='';await poll();}catch(error){message(error.message,true);last='';await poll();}finally{if(!confirmed)for(const b of actions.querySelectorAll('button'))b.disabled=Date.now()>=request.expiresAt;}};actions.append(button);}card.append(actions);$('requests').append(card);}}
async function poll(){if(!signedIn||loading)return;loading=true;try{if(expiresAt<Date.now()+5*60000){const renewed=await api('/session/refresh',{});remember(renewed.csrfToken);expiresAt=Date.parse(renewed.expiresAt);}const data=await api('/approvals');render(data.requests);}catch(error){message(error.message,true);}finally{loading=false;}}
$('login-form').onsubmit=async event=>{event.preventDefault();if(loggingIn)return;loggingIn=true;const submit=$('login-form').querySelector('button');submit.disabled=true;const password=$('password').value;$('password').value='';try{const data=await api('/login',{email:$('email').value,password});remember(data.csrfToken);expiresAt=Date.parse(data.expiresAt);signedIn=true;$('who').textContent=data.user.email;view();message('已登录，正在获取等待确认的请求。');await poll();}catch(error){message(error.message,true);}finally{loggingIn=false;submit.disabled=false;}};
$('logout').onclick=async()=>{try{await api('/logout',{});remember('');signedIn=false;view();message('已退出。');}catch(error){message(error.message,true);}};
$('refresh').onclick=()=>{last='';void poll();};
let restoring=false;
async function restoreSession(){if(!csrf||signedIn||restoring||loggingIn)return;restoring=true;try{const data=await api('/session');expiresAt=Date.parse(data.expiresAt);signedIn=true;$('who').textContent=data.user.email;view();await poll();}catch(error){message(error.message,true);view();}finally{restoring=false;}}
void restoreSession();
setInterval(()=>{if(document.visibilityState==='visible'){void restoreSession();void poll();}},3000);
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'){void restoreSession();void poll();}});
