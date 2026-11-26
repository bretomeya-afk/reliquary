// Project RELIQUARY member accounts: the Sign in / Account button and dialog, shared by index.html and board.html.
// Visitors create an account with a username and a PIN (6 to 12 digits); members can set a display name, which is
// shown on their posts and in "Online now". The administrator sees every account here and can delete them.
// Needs assets/cloud.js (shared online storage). Pages put a button with id="account-btn" in their top bar.
(function(){
'use strict';
const Cloud=window.ReliquaryCloud||{enabled:false},$=id=>document.getElementById(id);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const say=m=>{if(typeof window.toast==='function')window.toast(m);};
const WARNING='Use a username and PIN that you do not use anywhere else. Never reuse a bank card PIN, a phone PIN, or any password or username from another site or account.';
const isAdmin=()=>!!(Cloud.enabled&&Cloud.isAdmin&&Cloud.isAdmin());
let member=null,mode='signin',busy=false,error='',members=null,stopList=null;const cbs=[];
const css=`.acct-tabs{display:flex;gap:4px;margin:-6px 0 14px;border-bottom:1px solid rgba(152,220,255,.25)}
.acct-tabs button{padding:8px 12px;border:0;border-bottom:2px solid transparent;background:none;color:#97aab8;font:inherit;font-size:12px;cursor:pointer}
.acct-tabs button[aria-selected="true"]{color:#e5f4ff;border-bottom-color:#78bdff}
.acct-warning{margin:0 0 14px;padding:10px 12px;border:1px solid #c98a3a;border-left-width:4px;border-radius:4px;background:rgba(201,138,58,.12);color:#ffe2b8;font-size:12px;line-height:1.5}
.account-dialog .acct-note{margin:-6px 0 12px;color:#97aab8;font-size:12px}
.acct-list{list-style:none;margin:0 0 10px;padding:0;max-height:50vh;overflow:auto}
.acct-list li{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 0;border-top:1px solid rgba(152,220,255,.2)}
.acct-list li span{display:flex;flex-direction:column}.acct-list small{color:#97aab8;font-size:11px}
.account-dialog .btn.danger{border-color:#8a3a2c;color:#ffb4a2}
.acct-row{display:flex;gap:8px;align-items:flex-end}.acct-row .field{flex:1;margin-bottom:0}
.acct-me{margin:0 0 14px;font-size:13px}`;
const st=document.createElement('style');st.textContent=css;document.head.appendChild(st);
const dlg=document.createElement('dialog');dlg.id='account';dlg.className='admin-dialog account-dialog';dlg.setAttribute('aria-labelledby','account-title');document.body.appendChild(dlg);
function label(){return isAdmin()?'Accounts':member?member.display:'Sign in';}
function updateBtn(){const b=$('account-btn');if(b){b.textContent=label();b.title=member?`Signed in as ${member.name}`:'';}}
const joined=t=>t?'Joined '+new Intl.DateTimeFormat('en-US',{month:'short',day:'numeric',year:'numeric'}).format(new Date(t)):'';
function html(){
 const head=t=>`<div class="dialog-head"><h2 id="account-title">${t}</h2><button class="btn" type="button" data-acct-close aria-label="Close">✕</button></div>`;
 const err=`<p class="error" role="alert">${esc(error)}</p>`;
 if(!Cloud.enabled)return head('Accounts')+'<p class="import-help">Accounts need shared online storage, which is not set up for this site.</p>';
 if(isAdmin()){
  const list=members===null?'<p class="acct-note">Loading…</p>':members.length?`<ul class="acct-list">${members.map(m=>`<li><span><b>${esc(m.display)}</b><small>Username ${esc(m.name)}${m.created?' · '+joined(m.created):''}</small></span><button class="btn danger" type="button" data-acct-del="${esc(m.uid)}">Delete</button></li>`).join('')}</ul>`:'<p class="acct-note">No member accounts yet.</p>';
  return head('Member accounts')+`<p class="import-help">${members?members.length:0} account${members&&members.length===1?'':'s'}. A deleted account can no longer sign in or post.</p>`+list+err;
 }
 if(member)return head('Account')+`<p class="acct-me">Signed in as <b>${esc(member.name)}</b>.</p><form id="acct-display-form" autocomplete="off"><div class="acct-row"><label class="field">Display name<input id="acct-display" maxlength="30" required value="${esc(member.display)}"></label><button class="btn" type="submit"${busy?' disabled':''}>Save</button></div><p class="acct-note" style="margin-top:6px">Shown on your posts and in Online now. 2 to 30 letters, numbers, spaces, or . _ ' -</p></form>${err}<div class="form-actions"><span></span><div class="action-group"><button class="btn" type="button" data-acct-close>Close</button><button class="btn primary" type="button" data-acct-signout>Sign out</button></div></div>`;
 const up=mode==='signup';
 return head(up?'Create account':'Sign in')+
  `<div class="acct-tabs" role="tablist"><button type="button" role="tab" aria-selected="${!up}" data-acct-mode="signin">Sign in</button><button type="button" role="tab" aria-selected="${up}" data-acct-mode="signup">Create account</button></div>`+
  `<p class="acct-warning" role="note"><b>Important:</b> ${WARNING}</p>`+
  `<form id="account-form" autocomplete="off"><label class="field">Username<input id="acct-name" maxlength="20" required autocomplete="username" spellcheck="false" autocapitalize="off"></label>`+
  `<label class="field">PIN (6 to 12 digits)<input id="acct-pin" type="password" inputmode="numeric" pattern="[0-9]{6,12}" maxlength="12" required autocomplete="${up?'new-password':'current-password'}"></label>`+
  (up?`<label class="field">Confirm PIN<input id="acct-pin2" type="password" inputmode="numeric" pattern="[0-9]{6,12}" maxlength="12" required autocomplete="new-password"></label><p class="acct-note">Usernames are 3 to 20 letters, numbers, - or _. You can set a display name after signing up. A forgotten PIN cannot be recovered.</p>`:'')+
  `${err}<div class="form-actions"><span></span><div class="action-group"><button class="btn" type="button" data-acct-close>Cancel</button><button class="btn primary" type="submit"${busy?' disabled':''}>${up?'Create account':'Sign in'}</button></div></div></form>`;
}
function redraw(){if(!dlg.open)return;const keep=document.activeElement?.id,v={};for(const id of ['acct-name','acct-pin','acct-pin2','acct-display'])if($(id))v[id]=$(id).value;dlg.innerHTML=html();for(const id in v)if($(id))$(id).value=v[id];if(keep&&$(keep))$(keep).focus();}
function open(m){
 error='';if(m)mode=m;dlg.innerHTML=html();if(!dlg.open)dlg.showModal();
 if(isAdmin()&&!stopList)stopList=Cloud.watchMembers(l=>{members=l;redraw();},msg=>{error=msg;redraw();});
 ($('acct-name')||$('acct-display')||dlg.querySelector('[data-acct-close]'))?.focus();
}
dlg.addEventListener('close',()=>{if(stopList){stopList();stopList=null;}members=null;});
dlg.addEventListener('click',async e=>{
 if(e.target.closest('[data-acct-close]')){dlg.close();return;}
 const t=e.target.closest('[data-acct-mode]');if(t){mode=t.dataset.acctMode;error='';dlg.innerHTML=html();$('acct-name')?.focus();return;}
 if(e.target.closest('[data-acct-signout]')){try{await Cloud.signOut();}catch(x){}dlg.close();say('Signed out.');return;}
 const del=e.target.closest('[data-acct-del]');if(del&&isAdmin()){
  const m=(members||[]).find(x=>x.uid===del.dataset.acctDel);if(!m)return;
  if(!confirm(`Delete the account "${m.display}" (username ${m.name})? It will no longer be able to sign in or post.`))return;
  const posts=confirm(`Also delete all of ${m.display}'s Message Board posts?\n\nOK deletes the posts. Cancel keeps them.`);
  try{await Cloud.deleteMember(m.uid,m.name,posts);say(`Account "${m.display}" deleted.`);}catch(x){error='Not deleted: '+x.message;redraw();}
 }
});
dlg.addEventListener('submit',async e=>{
 e.preventDefault();if(busy)return;error='';
 if(e.target.id==='acct-display-form'){busy=true;redraw();try{const d=await Cloud.setDisplayName($('acct-display').value);busy=false;say(`Display name set to ${d}.`);}catch(x){busy=false;error=x.message;}redraw();return;}
 if(e.target.id!=='account-form')return;
 const name=$('acct-name').value.trim(),pin=$('acct-pin').value.trim(),up=mode==='signup';
 if(up&&pin!==$('acct-pin2').value.trim()){error='The PINs do not match.';redraw();return;}
 busy=true;redraw();
 try{const m=up?await Cloud.memberSignUp(name,pin):await Cloud.memberSignIn(name,pin);busy=false;dlg.close();say(up?`Account created. Welcome, ${m.name}.`:`Signed in as ${m.display}.`);}
 catch(x){busy=false;error=x.message;redraw();}
});
function fire(){updateBtn();redraw();cbs.forEach(cb=>{try{cb(member);}catch(e){console.error(e);}});}
function start(){const b=$('account-btn');if(b)b.addEventListener('click',()=>open());updateBtn();}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start);else start();
if(Cloud.enabled){Cloud.onMember&&Cloud.onMember(m=>{member=m;fire();});Cloud.onAuth&&Cloud.onAuth(()=>{updateBtn();redraw();});}
window.ReliquaryAccounts={open,get member(){return member;},onChange(cb){cbs.push(cb);}};
})();
