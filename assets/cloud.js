// Project RELIQUARY shared online storage (Firebase Firestore + Authentication, loaded from Google's CDN).
// Used by index.html and starmap.html. With no settings in cloud-config.js it stays switched off and both
// pages keep saving in the browser only.
//   site/{name}        public read, admin write. Each holds a JSON string; big values are split across
//                      site/{name}~1, ~2 ... (written together in one batch) to stay under Firestore's 1 MB limit.
//   chat/{auto id}     public read, admin write (live for every visitor).
//   sessions/{browser} public read; each browser logged into a command writes a heartbeat {command, at}
//                      (at = server time) about once a minute. A command's online count is its number of fresh records.
//   board/{post}       public read; message board topics and replies (posted by members and the administrator).
//   users/{uid}, usernames/{name}, banned/{uid}: member accounts (username + PIN sign-up).
//   messages/{auto id}  private messages between members; only the sender and recipient can read them.
//   characters/{uid}_{1-3}  public read; forum characters, up to three per signed-in user (owner edits/deletes).
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
  watchMemberProfile();
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
 try{await auth.setPersistence(window.firebase.auth.Auth.Persistence.SESSION);}catch(e){}
 try{await auth.signInWithEmailAndPassword(adminEmail,password);}catch(e){throw Error(friendly(e));}
 if(!isAdmin()){await auth.signOut();throw Error('That account is not the administrator.');}
 return true;
}
async function signOut(){if(auth){dropOnline();await auth.signOut();}}
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
 if(!/^(eisdon|gallia|secara|histannia|harron)-[1-9]$/.test(cmd))throw Error('Unknown fleet.');await ready();
 try{await db.collection('fleets').doc(cmd).set({ships:Math.round(f.ships),at:String(f.at||'').slice(0,40),to:String(f.to||'').slice(0,40),depart:Math.round(+f.depart||0),arrive:Math.round(+f.arrive||0),route:Array.isArray(f.route)?f.route.slice(0,40).map(x=>String(x).slice(0,40)):[]});}
 catch(e){throw Error(/permission-denied/.test(e&&e.code||'')?'The shared database refused the fleet order. Publish the latest firestore.rules in Firebase.':friendly(e));}
}
// Member accounts (site sign-up with a username and PIN). Each member is a Firebase Authentication user with a made-up
// address (u.<name>@reliquary.example.com) and the PIN as password, plus users/{uid} = {name, display, created} and
// usernames/{lower name} = {uid}. The display name (shown on posts and in Online now) can be changed by the member. Members stay signed in on that browser until they sign out. The administrator can
// delete an account: the profile and name record are removed and banned/{uid} stops that login being used again.
const NAME_RE=/^[A-Za-z0-9_-]{3,20}$/,PIN_RE=/^\d{6,12}$/,DISPLAY_RE=/^[A-Za-z0-9 _.'-]{2,30}$/;
const memberEmail=n=>`u.${n.toLowerCase()}@reliquary.example.com`;
const mem={cbs:[],cur:undefined,stop:null};
function fireMember(){mem.cbs.forEach(cb=>{try{cb(mem.cur||null);}catch(e){console.error(e);}});}
function onMember(cb){mem.cbs.push(cb);if(mem.cur!==undefined)cb(mem.cur||null);}
function memberFriendly(e){const c=e&&e.code||'';if(/wrong-password|invalid-credential|invalid-login-credentials|user-not-found/.test(c))return 'Incorrect username or PIN.';if(/email-already-in-use/.test(c))return 'That username is taken.';if(/weak-password/.test(c))return 'The PIN must be 6 to 12 digits.';return friendly(e);}
function watchMemberProfile(){
 auth.onAuthStateChanged(async u=>{
  if(mem.stop){mem.stop();mem.stop=null;}
  if(on.uid&&(!u||u.uid!==on.uid))dropOnline();
  if(!u||isAdmin()||!/@reliquary\.example\.com$/.test(u.email||'')){mem.cur=null;fireMember();return;}
  mem.stop=db.collection('users').doc(u.uid).onSnapshot(async s=>{
   if(s.exists){const d=s.data();mem.cur={uid:u.uid,name:String(d.name||''),display:String(d.display||d.name||'')};fireMember();syncOnline();return;}
   if(mem.cur){mem.cur=null;fireMember();await auth.signOut();return;} // the account was deleted while signed in
  },()=>{});
 });
}
async function memberSignUp(name,pin){
 name=String(name||'').trim();pin=String(pin||'').trim();
 if(!NAME_RE.test(name))throw Error('Usernames are 3 to 20 letters, numbers, - or _.');
 if(!PIN_RE.test(pin))throw Error('The PIN must be 6 to 12 digits.');
 await ready();const key=name.toLowerCase();
 if((await db.collection('usernames').doc(key).get()).exists)throw Error('That username is taken.');
 try{await auth.setPersistence(window.firebase.auth.Auth.Persistence.LOCAL);}catch(e){}
 let cred;try{cred=await auth.createUserWithEmailAndPassword(memberEmail(name),pin);}catch(e){throw Error(memberFriendly(e));}
 const uid=cred.user.uid,b=db.batch(),at=window.firebase.firestore.FieldValue.serverTimestamp();
 b.set(db.collection('usernames').doc(key),{uid});b.set(db.collection('users').doc(uid),{name,display:name,created:at});
 try{await b.commit();}catch(e){try{await cred.user.delete();}catch(x){await auth.signOut();}throw Error(/permission-denied/.test(e&&e.code||'')?'That username is taken, or the database rules need publishing.':friendly(e));}
 return {uid,name,display:name};
}
async function memberSignIn(name,pin){
 name=String(name||'').trim();pin=String(pin||'').trim();
 if(!NAME_RE.test(name)||!PIN_RE.test(pin))throw Error('Incorrect username or PIN.');
 await ready();
 try{await auth.setPersistence(window.firebase.auth.Auth.Persistence.LOCAL);}catch(e){}
 let cred;try{cred=await auth.signInWithEmailAndPassword(memberEmail(name),pin);}catch(e){throw Error(memberFriendly(e));}
 const uid=cred.user.uid,prof=await db.collection('users').doc(uid).get();
 if(!prof.exists){
  const ban=await db.collection('banned').doc(uid).get().catch(()=>null);await auth.signOut();
  throw Error(ban&&ban.exists?'This account has been removed by an administrator.':'This account is not set up. Create it again or ask an administrator.');
 }
 const d=prof.data();return {uid,name:String(d.name||name),display:String(d.display||d.name||name)};
}
async function setDisplayName(display){
 display=String(display||'').trim().replace(/\s+/g,' ');
 if(!DISPLAY_RE.test(display))throw Error('Display names are 2 to 30 letters, numbers, spaces, or . _ \' -');
 await ready();const u=auth.currentUser;if(!u||!mem.cur)throw Error('Sign in first.');
 try{await db.collection('users').doc(u.uid).update({display});}catch(e){throw Error(friendly(e));}
 return display;
}
// Online members: online/{uid} = {name: display name, at}. A signed-in member's open page sends a heartbeat about
// once a minute; a member counts as online while it is fresh. Signing out or closing the page removes it.
const ONLINE_FRESH=150000,on={uid:null,timer:0,data:[],skew:0};
function writeOnline(){if(!mem.cur||!auth.currentUser)return;on.uid=mem.cur.uid;db.collection('online').doc(on.uid).set({name:mem.cur.display,at:window.firebase.firestore.FieldValue.serverTimestamp()}).catch(()=>{});}
function syncOnline(){if(!mem.cur)return;writeOnline();if(!on.timer){on.timer=setInterval(writeOnline,60000);addEventListener('pagehide',()=>{if(on.uid)db.collection('online').doc(on.uid).delete().catch(()=>{});});addEventListener('pageshow',e=>{if(e.persisted)writeOnline();});}}
function dropOnline(){const id=on.uid;on.uid=null;clearInterval(on.timer);on.timer=0;if(id&&db)db.collection('online').doc(id).delete().catch(()=>{});}
function watchOnline(cb,onError){
 let stop=()=>{},closed=false,iv=0;const emit=()=>{const now=Date.now()+on.skew;cb(on.data.filter(x=>now-x.at<ONLINE_FRESH).sort((a,b)=>a.name.localeCompare(b.name)));};
 ready().then(()=>{if(closed)return;stop=db.collection('online').onSnapshot(s=>{const o=[];s.forEach(d=>{const v=d.data({serverTimestamps:'estimate'}),at=v.at&&v.at.toMillis?v.at.toMillis():0;o.push({uid:d.id,name:String(v.name||''),at});if(d.id===on.uid&&!d.metadata.hasPendingWrites&&at)on.skew=Math.max(-864e5,Math.min(864e5,at-Date.now()));});on.data=o;emit();},e=>onError&&onError(friendly(e)));iv=setInterval(emit,30000);}).catch(e=>onError&&onError(friendly(e)));
 return()=>{closed=true;stop();clearInterval(iv);};
}
// Administrator: list members, and delete one (optionally with their message board posts).
function watchMembers(cb,onError){
 let stop=()=>{},closed=false;
 ready().then(()=>{if(closed)return;stop=db.collection('users').onSnapshot(s=>{const o=[];s.forEach(d=>{const v=d.data({serverTimestamps:'estimate'});o.push({uid:d.id,name:String(v.name||''),display:String(v.display||v.name||''),created:v.created&&v.created.toMillis?v.created.toMillis():0});});cb(o.sort((a,b)=>a.name.localeCompare(b.name)));},e=>onError&&onError(friendly(e)));}).catch(e=>onError&&onError(friendly(e)));
 return()=>{closed=true;stop();};
}
async function deleteMember(uid,name,withPosts){
 await ready();if(!isAdmin())throw Error('Sign in as administrator.');
 try{
  const b=db.batch(),at=window.firebase.firestore.FieldValue.serverTimestamp();
  b.delete(db.collection('users').doc(uid));b.delete(db.collection('online').doc(uid));b.delete(db.collection('usernames').doc(String(name).toLowerCase()));b.set(db.collection('banned').doc(uid),{name:String(name).slice(0,20),at});
  for(let i=1;i<=CHAR_MAX;i++)b.delete(db.collection('characters').doc(uid+'_'+i)); // their characters go with the account
  await b.commit();
  if(withPosts){const s=await db.collection('board').where('uid','==',uid).get(),ids=[];s.forEach(d=>ids.push(d.id));await deleteBoardPosts(ids);}
 }catch(e){throw Error(friendly(e));}
}
// Message board: board/{id} = {uid, board, topic, title, text, from, player, char, faction, at}. board is the forum
// board id (old posts without one belong to General); char is the id of the character posted as ('' for none), and
// then from is the character's name and player the poster's display name. A topic has topic '' and a title; a reply
// has topic = the topic's id. Everyone can read; signed-in members (as their username) and the administrator can post;
// the database checks the author. Members can delete their own posts; the administrator can delete any.
function watchBoard(cb,onError){
 let stop=()=>{},closed=false;
 ready().then(()=>{if(closed)return;stop=db.collection('board').orderBy('at').limitToLast(1000).onSnapshot(s=>{const out=[];s.forEach(d=>{const m=d.data({serverTimestamps:'estimate'});if(m&&typeof m.text==='string')out.push({id:d.id,uid:String(m.uid||''),topic:String(m.topic||''),board:String(m.board||''),title:String(m.title||''),text:m.text,from:String(m.from||''),player:String(m.player||''),char:String(m.char||''),faction:String(m.faction||''),at:m.at&&m.at.toMillis?m.at.toMillis():0});});cb(out);},e=>onError&&onError(friendly(e)));}).catch(e=>onError&&onError(friendly(e)));
 return()=>{closed=true;stop();};
}
async function addBoardPost(m){
 await ready();
 try{const r=await db.collection('board').add({uid:auth.currentUser?auth.currentUser.uid:'',board:String(m.board||'general').slice(0,30),topic:String(m.topic||'').slice(0,40),title:String(m.title||'').slice(0,120),text:String(m.text).slice(0,2000),from:String(m.from).slice(0,130),player:String(m.player||'').slice(0,60),char:String(m.char||'').slice(0,40),faction:String(m.faction||'').slice(0,20),at:window.firebase.firestore.FieldValue.serverTimestamp()});return r.id;}
 catch(e){throw Error(/permission-denied/.test(e&&e.code||'')?'The shared database refused the post. Publish the latest firestore.rules in Firebase.':friendly(e));}
}
async function deleteBoardPosts(ids){
 await ready();
 try{for(let i=0;i<ids.length;i+=400){const b=db.batch();ids.slice(i,i+400).forEach(id=>b.delete(db.collection('board').doc(id)));await b.commit();}}catch(e){throw Error(friendly(e));}
}
// Forum characters: characters/{uid}_{slot} (slot 1 to CHAR_MAX) = {owner, player, name, names[1-4], dob, birthplace,
// gender, height, weight, nationality, race, occupation, affiliation, background, image, updated}. image is '' or a
// small JPEG data URL (resized in the browser) or an https link. Public read; the owner saves and deletes, the
// administrator can delete any. The fixed ids are what limits each user to CHAR_MAX characters.
const CHAR_MAX=10,CHAR_TEXT=['dob','birthplace','gender','height','weight','nationality','race','occupation','affiliation'];
function uid(){return auth&&auth.currentUser?auth.currentUser.uid:null;}
function watchCharacters(cb,onError){
 let stop=()=>{},closed=false;
 ready().then(()=>{if(closed)return;stop=db.collection('characters').onSnapshot(s=>{const o={};s.forEach(d=>{const v=d.data()||{},c={id:d.id,owner:String(v.owner||''),player:String(v.player||''),name:String(v.name||''),names:Array.isArray(v.names)?v.names.map(String):[],background:String(v.background||''),image:String(v.image||'')};CHAR_TEXT.forEach(k=>c[k]=String(v[k]||''));if(c.name)o[d.id]=c;});cb(o);},e=>onError&&onError(friendly(e)));}).catch(e=>onError&&onError(friendly(e)));
 return()=>{closed=true;stop();};
}
async function saveCharacter(id,c){
 await ready();const u=uid();if(!u)throw Error('Sign in to save characters.');
 const slot=+String(id).slice(u.length+1);if(!String(id).startsWith(u+'_')||!(slot>=1&&slot<=CHAR_MAX&&Number.isInteger(slot)))throw Error('You can have up to '+CHAR_MAX+' characters.');
 const names=(c.names||[]).map(n=>String(n||'').trim().slice(0,30)).filter(Boolean).slice(0,4);if(!names.length)throw Error('Enter a first name.');
 const d={owner:u,player:String(c.player||'').slice(0,60),name:names.join(' ').slice(0,130),names,background:String(c.background||'').slice(0,8000),image:String(c.image||''),updated:window.firebase.firestore.FieldValue.serverTimestamp()};
 CHAR_TEXT.forEach(k=>d[k]=String(c[k]||'').trim().slice(0,60));
 if(d.image.length>200000)throw Error('The image is too large.');
 try{await db.collection('characters').doc(id).set(d);}
 catch(e){throw Error(/permission-denied/.test(e&&e.code||'')?'The shared database refused the character. Publish the latest firestore.rules in Firebase.':friendly(e));}
}
async function deleteCharacter(id){await ready();try{await db.collection('characters').doc(id).delete();}catch(e){throw Error(friendly(e));}}
// Private messages: messages/{id} = {from, fromName, to, toName, text, at, read}. watchMessages follows the signed-in
// user's sent and received messages (re-subscribing when the sign-in changes) and calls cb with them, oldest first.
const DM_MAX=1000;
function watchMessages(cb,onError){
 let stops=[],closed=false,me=null;const box={in:[],out:[]},err={in:'',out:''};
 const emit=()=>cb([...box.in,...box.out].sort((a,b)=>a.at-b.at),err.in||err.out); // second argument: a problem reading messages ('' when fine)
 const conv=d=>{const v=d.data({serverTimestamps:'estimate'});return {id:d.id,from:String(v.from||''),fromName:String(v.fromName||''),to:String(v.to||''),toName:String(v.toName||''),text:String(v.text||''),read:!!v.read,edited:!!v.edited,fromHidden:!!v.fromHidden,toHidden:!!v.toHidden,at:v.at&&v.at.toMillis?v.at.toMillis():Date.now()};};
 const follow=()=>{const u=uid();if(u===me)return;me=u;stops.forEach(f=>f());stops=[];box.in=[];box.out=[];err.in=err.out='';emit();if(!u||closed)return;
  // Received (to = you) and sent (from = you) are two separate listeners. If one fails (for example before the rules
  // were published) it retries every 15 seconds on its own instead of staying stopped.
  const listen=(k,f)=>{if(closed||me!==u)return;let off=null;off=db.collection('messages').where(f,'==',u).onSnapshot(s=>{const o=[];s.forEach(d=>o.push(conv(d)));box[k]=o;err[k]='';emit();},
   e=>{err[k]=(k==='in'?'Received messages could not be loaded: ':'Sent messages could not be loaded: ')+friendly(e);emit();onError&&onError(err[k]);const t=setTimeout(()=>listen(k,f),15000);stops.push(()=>clearTimeout(t));});stops.push(()=>off&&off());};
  listen('in','to');listen('out','from');};
 ready().then(()=>{if(closed)return;auth.onAuthStateChanged(()=>follow());follow();}).catch(e=>onError&&onError(friendly(e)));
 return()=>{closed=true;stops.forEach(f=>f());};
}
async function sendMessage(to,toName,fromName,text){
 await ready();const u=uid();if(!u)throw Error('Sign in to send messages.');
 const t=String(text||'').trim().slice(0,DM_MAX);if(!t)throw Error('Enter a message.');
 try{await db.collection('messages').add({from:u,fromName:String(fromName).slice(0,60),to:String(to),toName:String(toName).slice(0,60),text:t,at:window.firebase.firestore.FieldValue.serverTimestamp(),read:false});}
 catch(e){throw Error(/permission-denied/.test(e&&e.code||'')?'The shared database refused the message. Publish the latest firestore.rules in Firebase.':friendly(e));}
}
async function editMessage(id,text){ // the sender changes their message
 await ready();const t=String(text||'').trim().slice(0,DM_MAX);if(!t)throw Error('Enter a message.');
 try{await db.collection('messages').doc(id).update({text:t,edited:true});}catch(e){throw Error(/permission-denied/.test(e&&e.code||'')?'The shared database refused the change. Publish the latest firestore.rules in Firebase.':friendly(e));}
}
async function deleteMessage(id){await ready();try{await db.collection('messages').doc(id).delete();}catch(e){throw Error(friendly(e));}} // the sender removes it for both
async function hideMessages(list){ // remove messages from your own inbox only: [{id, mine}]
 await ready();if(!list.length)return;
 try{for(let i=0;i<list.length;i+=400){const b=db.batch();list.slice(i,i+400).forEach(m=>b.update(db.collection('messages').doc(m.id),m.mine?{fromHidden:true}:{toHidden:true,read:true}));await b.commit();}}
 catch(e){throw Error(/permission-denied/.test(e&&e.code||'')?'The shared database refused the change. Publish the latest firestore.rules in Firebase.':friendly(e));}
}
async function markMessagesRead(ids){await ready();if(!ids.length)return;try{const b=db.batch();ids.slice(0,400).forEach(id=>b.update(db.collection('messages').doc(id),{read:true}));await b.commit();}catch(e){}}
// Commander presence. Several people on different computers can be logged into the same command at once, so each
// browser has its own presence record: sessions/{browser id} = {command, at} (command '' when logged out; at = server
// time). The browser id is kept in localStorage, so the main page and the starmap open in the same browser count as
// one person. trackPresence(getCommand, onChange) starts the heartbeat for whichever command this browser is logged
// into (getCommand() returns its key or null), watches everyone's records and calls onChange on updates.
// presenceStatus() returns {command: number of people online}. Call syncPresence() right after a login or logout.
const PRESENCE_FRESH=150000,PRESENCE_BEAT=60000,CMD_KEYS=['eisdon','gallia','secara','histannia','harron'];
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
window.ReliquaryCloud={enabled,adminEmail,ready,isAdmin,onAuth,signIn,signOut,watchDoc,saveDoc,watchChat,addChat,clearChat,trackPresence,syncPresence,presenceStatus,watchFleets,saveFleet,watchBoard,addBoardPost,deleteBoardPosts,CHAR_MAX,uid,watchCharacters,saveCharacter,deleteCharacter,DM_MAX,watchMessages,sendMessage,markMessagesRead,editMessage,deleteMessage,hideMessages,onMember,memberSignUp,memberSignIn,setDisplayName,watchOnline,watchMembers,deleteMember};
if(enabled)ready().catch(()=>{});
})();
