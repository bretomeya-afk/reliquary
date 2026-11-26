// Project RELIQUARY shared online storage (Firebase Firestore + Authentication, loaded from Google's CDN).
// Used by index.html and starmap.html. With no settings in cloud-config.js it stays switched off and both
// pages keep saving in the browser only.
//   site/{name}        public read, admin write. Each holds a JSON string; big values are split across
//                      site/{name}~1, ~2 ... (written together in one batch) to stay under Firestore's 1 MB limit.
//   chat/{auto id}     public read, admin write (live for every visitor).
//   sessions/{browser} public read; each browser logged into a command writes a heartbeat {command, at}
//                      (at = server time) about once a minute. A command's online count is its number of fresh records.
//   fleets/{fleet}     public read (ids like gallia-2); any browser can place or move a fleet, only the administrator changes its ship count.
(function(){
'use strict';
const SDK='https://www.gstatic.com/firebasejs/10.12.2/';
const cfg=window.RELIQUARY_CLOUD_CONFIG||{},fb=cfg.firebase||{};
const adminEmail=String(cfg.adminEmail||'').trim().toLowerCase();
const enabled=!!(fb.apiKey&&fb.projectId&&adminEmail);
const PART=250000; // characters per stored part (at most ~750 KB of UTF-8)
let readyP=null,auth=null,db=null,user=null,authKnown=false;
const authCbs=[],lastJson={},partsKnown={};
function loadScript(src){return new Promise((ok,no)=>{const s=document.createElement('script'),t=setTimeout(()=>no(Error('Could not load '+src)),15000);s.src=src;s.onload=()=>{clearTimeout(t);ok();};s.onerror=()=>{clearTimeout(t);no(Error('Could not load '+src));};document.head.appendChild(s);});}
function ready(){
 if(!enabled)return Promise.reject(Error('Shared storage is not set up.'));
 if(readyP)return readyP;
 readyP=(async()=>{
  if(!(window.firebase&&window.firebase.firestore&&window.firebase.auth))for(const f of ['firebase-app-compat.js','firebase-auth-compat.js','firebase-firestore-compat.js'])await loadScript(SDK+f);
  const F=window.firebase;
  if(!F.apps.length)F.initializeApp({apiKey:fb.apiKey,authDomain:fb.authDomain||fb.projectId+'.firebaseapp.com',projectId:fb.projectId,appId:fb.appId||undefined});
  auth=F.auth();db=F.firestore();
  try{await auth.setPersistence(F.auth.Auth.Persistence.SESSION);}catch(e){} // signed in for this tab, like the old admin login
  auth.onAuthStateChanged(u=>{user=u;authKnown=true;const a=isAdmin();authCbs.forEach(cb=>{try{cb(a);}catch(e){console.error(e);}});});
 })();
 readyP.catch(()=>{readyP=null;}); // a later sign-in or save tries again
 return readyP;
}
function isAdmin(){return !!(user&&user.email&&user.email.toLowerCase()===adminEmail);}
function onAuth(cb){authCbs.push(cb);if(authKnown)cb(isAdmin());}
function friendly(e){
 const c=e&&e.code||'';
 if(/wrong-password|invalid-credential|invalid-login-credentials|user-not-found|invalid-email|missing-password/.test(c))return 'Incorrect password.';
 if(/too-many-requests/.test(c))return 'Too many attempts. Wait a few minutes and try again.';
 if(/network|unavailable/.test(c)||/Could not load/.test(e&&e.message||''))return 'Could not reach the shared database. Check your connection and try again.';
 if(/permission-denied/.test(c))return 'The shared database refused the change. Sign in as administrator and check the database rules.';
 if(/operation-not-allowed/.test(c))return 'Email/Password sign-in is not switched on in Firebase Authentication.';
 return (e&&e.message)||'Shared storage error.';
}
async function signIn(password){
 await ready();
 try{await auth.signInWithEmailAndPassword(adminEmail,password);}catch(e){throw Error(friendly(e));}
 if(!isAdmin()){await auth.signOut();throw Error('That account is not the administrator.');}
 return true;
}
async function signOut(){if(auth)await auth.signOut();}
const doc=n=>db.collection('site').doc(n);
// Watch a shared value. cb(value) gets the parsed value, or null when nothing has been shared yet.
// Echoes of this browser's own saves are skipped.
function watchDoc(name,cb,onError){
 let stop=()=>{},closed=false,seq=0;
 ready().then(()=>{if(closed)return;stop=doc(name).onSnapshot(async s=>{
  if(s.metadata&&s.metadata.hasPendingWrites)return;
  const my=++seq;
  try{
   if(!s.exists){partsKnown[name]=0;if(lastJson[name]!==null){lastJson[name]=null;cb(null);}return;}
   const d=s.data(),parts=Math.max(1,d.parts|0);let json=String(d.json||'');
   for(let i=1;i<parts;i++){const p=await doc(name+'~'+i).get();if(!p.exists||p.data().rev!==d.rev)throw Error('Shared value is mid-update.');json+=String(p.data().json||'');}
   if(my!==seq)return;partsKnown[name]=parts;
   if(json===lastJson[name])return;
   const v=JSON.parse(json);lastJson[name]=json;cb(v);
  }catch(e){onError&&onError(friendly(e));}
 },e=>onError&&onError(friendly(e)));}).catch(e=>onError&&onError(friendly(e)));
 return()=>{closed=true;stop();};
}
async function saveDoc(name,value){
 await ready();
 if(!isAdmin())throw Error('Sign in as administrator to share changes.');
 const json=JSON.stringify(value);if(json===lastJson[name])return false;
 const F=window.firebase,rev=Date.now().toString(36)+Math.random().toString(36).slice(2,7),parts=Math.max(1,Math.ceil(json.length/PART));
 if(parts>40)throw Error('This is too large to share (over 10 million characters).');
 const b=db.batch();
 b.set(doc(name),{json:json.slice(0,PART),parts,rev,updatedAt:F.firestore.FieldValue.serverTimestamp()});
 for(let i=1;i<parts;i++)b.set(doc(name+'~'+i),{json:json.slice(i*PART,(i+1)*PART),rev});
 for(let i=parts;i<(partsKnown[name]||1);i++)b.delete(doc(name+'~'+i));
 const prev=lastJson[name];lastJson[name]=json; // set first so the database's echo of this save is skipped
 try{await b.commit();}catch(e){if(lastJson[name]===json)lastJson[name]=prev;throw Error(friendly(e));}
 partsKnown[name]=parts;return true;
}
// Chat (administrators only).
function watchChat(cb,onError){
 let stop=()=>{},closed=false;
 ready().then(()=>{if(closed)return;stop=db.collection('chat').orderBy('at').limitToLast(200).onSnapshot(s=>{
  const out=[];s.forEach(d=>{const m=d.data();if(m&&typeof m.text==='string')out.push({from:String(m.from||''),text:m.text,at:+m.at||0,faction:typeof m.faction==='string'?m.faction:''});});cb(out);
 },e=>onError&&onError(friendly(e)));}).catch(e=>onError&&onError(friendly(e)));
 return()=>{closed=true;stop();};
}
async function addChat(m){await ready();try{const doc={from:String(m.from).slice(0,80),text:String(m.text).slice(0,300),at:+m.at||Date.now()};if(m.faction)doc.faction=String(m.faction).slice(0,20);await db.collection('chat').add(doc);}catch(e){throw Error(friendly(e));}}
async function clearChat(){
 await ready();
 try{const s=await db.collection('chat').get(),refs=[];s.forEach(d=>refs.push(d.ref));
  for(let i=0;i<refs.length;i+=400){const b=db.batch();refs.slice(i,i+400).forEach(r=>b.delete(r));await b.commit();}
 }catch(e){throw Error(friendly(e));}
}
// Fleets (Command Module RTS): fleets/{command-n} = {ships, at, to, depart, arrive, route} (for example fleets/gallia-2). Anyone logged into a command can
// place and move its fleet; only the administrator can change the number of ships (enforced by firestore.rules).
function watchFleets(cb,onError){
 let stop=()=>{},closed=false;
 ready().then(()=>{if(closed)return;stop=db.collection('fleets').onSnapshot(s=>{const o={};s.forEach(d=>{o[d.id]=d.data();});cb(o);},e=>onError&&onError(friendly(e)));}).catch(e=>onError&&onError(friendly(e)));
 return()=>{closed=true;stop();};
}
async function saveFleet(cmd,f){
 if(!/^(eisdon|gallia|histannia|harron)-[1-9]$/.test(cmd))throw Error('Unknown fleet.');await ready();
 try{await db.collection('fleets').doc(cmd).set({ships:Math.round(f.ships),at:String(f.at||'').slice(0,40),to:String(f.to||'').slice(0,40),depart:Math.round(+f.depart||0),arrive:Math.round(+f.arrive||0),route:Array.isArray(f.route)?f.route.slice(0,40).map(x=>String(x).slice(0,40)):[]});}
 catch(e){throw Error(/permission-denied/.test(e&&e.code||'')?'The shared database refused the fleet order. Publish the latest firestore.rules in Firebase.':friendly(e));}
}
// Commander presence. Several people on different computers can be logged into the same command at once, so each
// browser has its own presence record: sessions/{browser id} = {command, at} (command '' when logged out; at = server
// time). The browser id is kept in localStorage, so the main page and the starmap open in the same browser count as
// one person. trackPresence(getCommand, onChange) starts the heartbeat for whichever command this browser is logged
// into (getCommand() returns its key or null), watches everyone's records and calls onChange on updates.
// presenceStatus() returns {command: number of people online}. Call syncPresence() right after a login or logout.
const PRESENCE_FRESH=150000,PRESENCE_BEAT=60000,CMD_KEYS=['eisdon','gallia','histannia','harron'];
function browserId(){const k='reliquary-presence-id';try{let v=localStorage.getItem(k);if(!/^[a-z0-9]{12}$/.test(v||'')){v=Array.from(crypto.getRandomValues(new Uint8Array(12)),x=>'abcdefghijklmnopqrstuvwxyz0123456789'[x%36]).join('');localStorage.setItem(k,v);}return v;}catch(e){return Math.random().toString(36).slice(2,14).padEnd(12,'0');}}
const pres={id:browserId(),cur:null,get:null,data:{},skew:0,cbs:[],started:false,bc:null};
function firePresence(){pres.cbs.forEach(cb=>{try{cb();}catch(e){console.error(e);}});}
function presenceStatus(){const now=Date.now()+pres.skew,o={};for(const k of CMD_KEYS)o[k]=0;for(const id in pres.data){const v=pres.data[id];if(CMD_KEYS.includes(v.command)&&now-v.at<PRESENCE_FRESH)o[v.command]++;}return o;}
async function writePresence(cmd){await ready();await db.collection('sessions').doc(pres.id).set({command:cmd||'',at:window.firebase.firestore.FieldValue.serverTimestamp()});}
function syncPresence(beat){
 if(!enabled||!pres.get)return;let c=null;try{c=pres.get()||null;}catch(e){}if(!CMD_KEYS.includes(c))c=null;
 if(c!==pres.cur){const was=pres.cur;pres.cur=c;if(c||was)writePresence(c).catch(()=>{});}
 else if(beat&&c)writePresence(c).catch(()=>{});
}
function trackPresence(getCmd,onChange){
 if(onChange)pres.cbs.push(onChange);pres.get=getCmd;
 if(!enabled||pres.started)return;pres.started=true;
 ready().then(()=>{
  db.collection('sessions').onSnapshot(s=>{const d={};s.forEach(x=>{const v=x.data({serverTimestamps:'estimate'}),at=v.at&&v.at.toMillis?v.at.toMillis():0;d[x.id]={command:v.command||'',at};
    if(x.id===pres.id&&!x.metadata.hasPendingWrites&&at)pres.skew=Math.max(-864e5,Math.min(864e5,at-Date.now()));}); // learn this computer's clock offset from its own record
   pres.data=d;firePresence();},()=>{});
  syncPresence();
 }).catch(()=>{});
 setInterval(()=>{syncPresence(true);firePresence();},PRESENCE_BEAT); // heartbeat, and let closed browsers drop to offline
 addEventListener('storage',e=>{if(e.key==='reliquary-commander'||e.key==='reliquary-command-alpha')syncPresence();});
 // Closing one tab marks this browser offline; any other open tab of the site in the same browser re-announces itself.
 try{pres.bc=new BroadcastChannel('reliquary-presence');pres.bc.onmessage=()=>setTimeout(()=>{pres.cur=null;syncPresence();},1500);}catch(e){}
 addEventListener('pagehide',()=>{if(pres.cur){writePresence(null).catch(()=>{});try{pres.bc&&pres.bc.postMessage('closing');}catch(e){}}});
 addEventListener('pageshow',e=>{if(e.persisted){pres.cur=null;syncPresence();}});
}
window.ReliquaryCloud={enabled,adminEmail,ready,isAdmin,onAuth,signIn,signOut,watchDoc,saveDoc,watchChat,addChat,clearChat,trackPresence,syncPresence,presenceStatus,watchFleets,saveFleet};
if(enabled)ready().catch(()=>{});
})();
