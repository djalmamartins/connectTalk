const socket = io();
let CURRENT_AGENT_ID = '';
let currentUser = null;
let activeQueueFilter = '';
let currentChatId = null;
let currentAttendance = null;
let liveMode = false;
let chats = [];
let agents = [];
let queues = [];
let activeFilter = 'all';
let reloadTimer = null;
let currentCrmContact = null;
const contactCache = new Map();
let condominiums = [];
let units = [];
const renderedMessageIds = new Set();
let supervisorLiveData = null;

function reconnectRealtimeIdentity(){
  try { if(socket.connected) socket.disconnect(); socket.connect(); } catch(error){ console.warn(error); }
}
function statusLabel(status='offline'){
  return status==='online'?'Online':status==='away'?'Ausente':'Offline';
}

const demoChats = [
  {id:'demo-joao',name:'João Silva',preview:'Bom dia! Gostaria de solicitar a 2ª via...',time:'10:30',status:'Na fila',unread:2,initials:'JS'},
  {id:'demo-maria',name:'Maria Oliveira',preview:'Meu interfone não está funcionando.',time:'10:18',status:'Em atendimento',unread:1,initials:'MO'}
];
const demoMessages = [
  {id:'d1',me:false,body:'Bom dia! Gostaria de solicitar a 2ª via do boleto do condomínio, por favor.',time:'10:30'},
  {id:'d2',me:true,body:'Bom dia! Claro, posso te ajudar.',time:'10:31'}
];

function esc(s='') { return String(s).replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c])); }
function initials(name='') { return name.split(/\s+/).slice(0,2).map(p=>p[0]).join('').toUpperCase() || 'WA'; }
function formatTime(ts) { return ts ? new Date(ts*1000).toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'}) : ''; }
function formatDate(value) { if(!value) return ''; return new Date(value).toLocaleString('pt-BR',{dateStyle:'short',timeStyle:'short'}); }
function formatMinutes(v){ if(v==null||!Number.isFinite(Number(v))) return '—'; v=Number(v); if(v<60)return `${v} min`; const h=Math.floor(v/60),m=v%60; return m?`${h}h ${m}m`:`${h}h`; }
function textToHtml(text='') { return esc(text).replace(/\n/g,'<br>'); }
function attendanceLabel(a) { if(!a) return 'Sem atendimento'; if(a.status==='closed') return 'Finalizado'; if(a.status==='waiting_customer') return 'Aguardando cliente'; if(a.status==='waiting_internal') return 'Aguardando interno'; if(a.status==='assigned') return a.agent?.name ? `Com ${a.agent.name}` : 'Em atendimento'; return 'Na fila'; }
function attendanceClass(a) { if(a?.status==='closed') return 'closed'; if(a?.status==='assigned') return 'assigned'; return 'waiting'; }
function showToast(message,type='success'){const t=document.getElementById('toast');if(!t)return;t.textContent=message;t.className=`toast ${type}`;clearTimeout(showToast.timer);showToast.timer=setTimeout(()=>t.classList.add('hidden'),3200);}

function fallbackPhoneFromChat(chatId=''){
  if(!chatId || chatId.endsWith('@lid') || chatId.endsWith('@g.us')) return '';
  return String(chatId.split('@')[0]||'').replace(/\D/g,'');
}
async function fetchContactCore(chatId=currentChatId){
  if(!chatId || chatId.startsWith('demo-')) return null;
  const r=await fetch('/api/contact-core/'+encodeURIComponent(chatId),{cache:'no-store'});
  const data=await r.json();
  if(!r.ok) throw new Error(data.error||'Falha ao carregar o contato.');
  contactCache.set(chatId,data);
  return data;
}
function applyContactCore(contact,{fallbackName='',fallbackPhone=''}={}){
  currentCrmContact=contact||null;
  const name=contact?.name||fallbackName||'Não identificado';
  const phone=contact?.phone||fallbackPhone||'';
  document.getElementById('infoName').textContent=name;
  document.getElementById('infoPhone').textContent=phone||'Não informado';
  document.getElementById('infoEmail').textContent=contact?.email||'Não informado';
  document.getElementById('infoDocument').textContent=contact?.document||'CPF/CNPJ não informado';
  document.getElementById('infoNotes').textContent=contact?.notes||'Sem observações internas';
  const u=contact?.unit;
  document.getElementById('infoUnit').textContent=u?`${u.condominiumName}${u.block?` · Bloco ${u.block}`:''}${u.number?` · Unidade ${u.number}`:''}${u.complement?` · ${u.complement}`:''}`:'Condomínio/unidade não identificados';
  const rel=document.getElementById('infoRelationship'); if(rel) rel.textContent=contact?.relationship||contact?.kind||'Vínculo não identificado';
  if(contact?.name){ document.getElementById('chatName').textContent=contact.name; document.getElementById('chatAvatar').textContent=initials(contact.name); }
  if(document.getElementById('chatPhone')) document.getElementById('chatPhone').textContent=phone||contact?.technicalId||'—';
}

function filteredChats() {
  let list=chats;
  if(activeQueueFilter) list=list.filter(c=>(c.attendance?.queueId||'geral')===activeQueueFilter);
  if(activeFilter==='mine') return list.filter(c=>c.attendance?.agentId===CURRENT_AGENT_ID && c.attendance?.status!=='closed');
  if(activeFilter==='queue') return list.filter(c=>c.attendance?.status==='waiting');
  if(activeFilter==='closed') return list.filter(c=>c.attendance?.status==='closed');
  return list;
}

function updateCounts() {
  const waiting = chats.filter(c=>c.attendance?.status==='waiting').length;
  document.getElementById('totalChats').textContent = chats.length;
  document.getElementById('mineCount').textContent = chats.filter(c=>c.attendance?.agentId===CURRENT_AGENT_ID && c.attendance?.status!=='closed').length;
  document.getElementById('queueCount').textContent = waiting;
  document.getElementById('closedCount').textContent = chats.filter(c=>c.attendance?.status==='closed').length;
  document.getElementById('kOpen').textContent = chats.filter(c=>c.attendance && c.attendance.status!=='closed').length;
  const sidebarQueue=document.getElementById('sidebarQueueCount');
  if(sidebarQueue){sidebarQueue.textContent=waiting;sidebarQueue.classList.toggle('hidden',waiting===0);}
}

function renderChats() {
  const list = filteredChats();
  const el = document.getElementById('chatList');
  el.innerHTML='';
  list.forEach((c,i)=>{
    const a=c.attendance;
    const row=document.createElement('div');
    row.className='chat-row'+((currentChatId===c.id||(!currentChatId&&i===0))?' active':'');
    row.dataset.id=c.id;
    row.innerHTML=`<div class="avatar">${esc(c.initials||initials(c.name))}</div><div><strong>${esc(c.name)}</strong><div class="preview">${esc(c.preview||c.lastMessage||'Sem mensagens recentes')}</div><div class="attendance-row-meta">${esc(a?.queue?.name||'Geral')} · ${esc(attendanceLabel(a))}</div></div><div class="chat-meta"><div>${esc(c.time||formatTime(c.timestamp))}</div><span class="status ${attendanceClass(a)}">${esc(!a?'Sem atendimento':a.status==='closed'?'Finalizado':a.status==='assigned'?'Em atendimento':'Na fila')}</span>${c.unread||c.unreadCount?`<div class="unread">${c.unread||c.unreadCount}</div>`:''}</div>`;
    row.onclick=()=>selectChat(c.id,c);
    el.appendChild(row);
  });
  updateCounts();
}

function renderMessages(messages) {
  renderedMessageIds.clear();
  const el=document.getElementById('messageArea');
  el.innerHTML=messages.map(m=>{ if(m.id)renderedMessageIds.add(m.id); return `<div class="msg ${m.me||m.fromMe?'me':''}"><div class="bubble">${textToHtml(m.body||'')}<time>${esc(m.time||formatTime(m.timestamp))}</time></div></div>`; }).join('');
  el.scrollTop=el.scrollHeight;
}
function appendMessage(m) {
  if(m.id&&renderedMessageIds.has(m.id))return;
  if(m.id)renderedMessageIds.add(m.id);
  const area=document.getElementById('messageArea');
  area.insertAdjacentHTML('beforeend',`<div class="msg ${m.fromMe?'me':''}"><div class="bubble">${textToHtml(m.body||'')}<time>${esc(formatTime(m.timestamp))}</time></div></div>`);
  area.scrollTop=area.scrollHeight;
}

function renderAttendance(a) {
  currentAttendance=a;
  const status=document.getElementById('attendanceStatus');
  status.textContent=attendanceLabel(a);
  status.className=`attendance-chip ${attendanceClass(a)}`;
  document.getElementById('claimBtn').style.display = a?.status==='assigned' && a.agentId===CURRENT_AGENT_ID ? 'none' : 'inline-flex';
  document.getElementById('closeAttendanceBtn').textContent = a?.status==='closed' ? 'Reabrir' : 'Finalizar';
  document.getElementById('queueSelect').value=a?.queueId||'geral';
  document.getElementById('agentSelect').value=a?.agentId||''; const stateSel=document.getElementById('attendanceStateSelect'); if(stateSel) stateSel.value=a?.status==='closed'?'assigned':(a?.status||'waiting');
  const qName=a?.queue?.name||queues.find(q=>q.id===(a?.queueId||'geral'))?.name||'Geral';
  const agentName=a?.agent?.name||agents.find(x=>x.id===a?.agentId)?.name||'Sem atendente';
  const stateName=attendanceLabel(a);
  const qLabel=document.getElementById('currentQueueName'); if(qLabel)qLabel.textContent=qName;
  const aLabel=document.getElementById('currentAgentName'); if(aLabel)aLabel.textContent=agentName;
  const sLabel=document.getElementById('currentStateName'); if(sLabel)sLabel.textContent=stateName;
  let sla='';
  if(a?.lastCustomerAt && !a?.firstResponseAt){ const mins=Math.max(0,Math.round((Date.now()-new Date(a.lastCustomerAt))/60000)); sla=` · Aguardando resposta há ${formatMinutes(mins)}`; }
  else if(a?.lastCustomerAt && a?.firstResponseAt){ const mins=Math.max(0,Math.round((new Date(a.firstResponseAt)-new Date(a.lastCustomerAt))/60000)); sla=` · 1ª resposta em ${formatMinutes(mins)}`; }
  document.getElementById('attendanceMeta').textContent = a ? `Criado ${formatDate(a.createdAt)} · Atualizado ${formatDate(a.updatedAt)}${sla}` : 'Sem atendimento.';
  const priority=document.getElementById('prioritySelect'); if(priority) priority.value=a?.priority||'normal';
  const tags=a?.tags||[]; const tagsInput=document.getElementById('tagsInput'); if(tagsInput) tagsInput.value=tags.join(', ');
  const tagsList=document.getElementById('tagsList'); if(tagsList) tagsList.innerHTML=tags.length?tags.map(t=>`<span>${esc(t)}</span>`).join(''):'<span class="tag-empty">Sem etiquetas</span>';
  const notes=document.getElementById('internalNotes'); if(notes){ const list=[...(a?.notes||[])].reverse(); notes.innerHTML=list.length?list.map(n=>`<div class="note-item"><strong>${esc(n.agentName||'Equipe')}</strong><span>${esc(formatDate(n.at))}</span><p>${textToHtml(n.text||'')}</p></div>`).join(''):'<p class="empty-history">Nenhuma nota interna.</p>'; }
  const hist=document.getElementById('attendanceHistory');
  const events=[...(a?.events||[])].reverse();
  hist.innerHTML=events.length?events.map(e=>`<div class="history-event"><i></i><div><strong>${esc(e.label||e.type)}</strong><span>${esc(formatDate(e.at))}</span></div></div>`).join(''):'<p class="empty-history">Nenhum evento registrado.</p>';
}

async function loadAttendance(chatId) {
  if(!liveMode||!chatId||chatId.startsWith('demo-')) { renderAttendance(null); return; }
  const r=await fetch('/api/attendance/'+encodeURIComponent(chatId));
  const data=await r.json();
  if(r.ok) renderAttendance(data);
}

async function selectChat(id,c) {
  currentChatId=id;
  document.querySelectorAll('.chat-row').forEach(r=>r.classList.toggle('active',r.dataset.id===id));
  const fallbackName=c?.name||'Contato';
  const fallbackPhone=id.startsWith('demo-')?'+55 11 98765-4321':fallbackPhoneFromChat(id);
  document.getElementById('chatName').textContent=fallbackName;
  document.getElementById('chatAvatar').textContent=initials(fallbackName);
  document.getElementById('chatPhone').textContent=fallbackPhone||id;
  applyContactCore(c?.crmContact||contactCache.get(id)||null,{fallbackName,fallbackPhone});
  if(!liveMode||id.startsWith('demo-')) { renderMessages(demoMessages); renderAttendance(null); return; }
  try {
    const [mr,,core]=await Promise.all([
      fetch('/api/messages/'+encodeURIComponent(id)),
      loadAttendance(id),
      fetchContactCore(id)
    ]);
    const data=await mr.json();
    if(mr.ok) renderMessages(data);
    if(id!==currentChatId) return;
    applyContactCore(core,{fallbackName,fallbackPhone});
  } catch(e){console.warn(e);}
}

// Compatibilidade: toda renderização passa pelo Contact Core canônico.
function renderCrmContact(person,fallbackName='',fallbackPhone=''){
  applyContactCore(person,{fallbackName,fallbackPhone});
}
async function loadCrmMeta(){
  if(!liveMode)return;
  try{ condominiums=await fetch('/api/condominiums',{cache:'no-store'}).then(r=>r.json()); document.getElementById('contactCondoInput').innerHTML='<option value="">Selecione</option>'+condominiums.map(c=>`<option value="${c.id}">${esc(c.name)}</option>`).join(''); }catch(e){console.warn(e);}
}
async function loadUnits(condoId){
  units=condoId?await fetch('/api/units?condominiumId='+encodeURIComponent(condoId),{cache:'no-store'}).then(r=>r.json()):[];
  document.getElementById('contactUnitInput').innerHTML='<option value="">Sem unidade</option>'+units.map(u=>`<option value="${u.id}">${esc((u.block?`Bloco ${u.block} · `:'')+'Unidade '+u.number)}</option>`).join('');
}
async function openContactModal(){
  if(!currentChatId||currentChatId.startsWith('demo-'))return;
  await loadCrmMeta();
  let p;
  try{ p=await fetchContactCore(currentChatId); }catch{ p=currentCrmContact||contactCache.get(currentChatId)||null; }
  if(currentChatId!==p?.chatId && p?.chatId) return;
  const fallbackPhone=fallbackPhoneFromChat(currentChatId);
  document.getElementById('contactNameInput').value=p?.name||document.getElementById('chatName').textContent||'';
  // Nunca preencher LID/JID técnico como telefone do morador.
  document.getElementById('contactPhoneInput').value=p?.phone||fallbackPhone||'';
  document.getElementById('contactEmailInput').value=p?.email||'';
  document.getElementById('contactDocumentInput').value=p?.document||'';
  document.getElementById('contactNotesInput').value=p?.notes||'';
  document.getElementById('contactKindInput').value=p?.kind||'morador';
  document.getElementById('contactCondoInput').value=p?.condominium?.id||'';
  await loadUnits(p?.condominium?.id||'');
  document.getElementById('contactUnitInput').value=p?.unit?.id||'';
  document.getElementById('contactRelationshipInput').value=p?.relationship||'morador';
  document.getElementById('contactFormError').textContent='';
  document.getElementById('contactModal').classList.remove('hidden');
}
async function saveCrmContact(){
  const btn=document.getElementById('saveContactBtn');
  const err=document.getElementById('contactFormError');
  const payload={
    id:currentCrmContact?.id||undefined,
    name:document.getElementById('contactNameInput').value.trim(),
    phone:document.getElementById('contactPhoneInput').value.trim(),
    email:document.getElementById('contactEmailInput').value.trim(),
    document:document.getElementById('contactDocumentInput').value.trim(),
    notes:document.getElementById('contactNotesInput').value.trim(),
    kind:document.getElementById('contactKindInput').value,
    unitId:document.getElementById('contactUnitInput').value||null,
    relationship:document.getElementById('contactRelationshipInput').value,
    chatId:currentChatId,
    jid:currentChatId
  };
  if(!payload.name){err.textContent='Informe o nome do contato.';return;}
  if(!payload.phone){err.textContent='Informe o telefone real do contato. O identificador técnico do WhatsApp não será usado como telefone.';return;}
  btn.disabled=true;btn.textContent='Salvando e verificando…';err.textContent='';
  try{
    const endpoint=currentCrmContact?.id?'/api/contacts/'+currentCrmContact.id:'/api/contacts';
    const r=await fetch(endpoint,{method:currentCrmContact?.id?'PUT':'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
    const data=await r.json();
    if(!r.ok)throw new Error(data.error||'Não foi possível salvar.');
    // Fonte da verdade: relê pelo chatId, exatamente como painel e modal farão.
    const verified=await fetchContactCore(currentChatId);
    const expectedUnit=payload.unitId?Number(payload.unitId):null;
    const savedUnit=verified?.unit?.id?Number(verified.unit.id):null;
    const checks=[
      ['nome',payload.name,verified.name||''],['telefone',payload.phone.replace(/\D/g,''),(verified.phone||'').replace(/\D/g,'')],
      ['e-mail',payload.email,(verified.email||'')],['CPF/CNPJ',payload.document,(verified.document||'')],
      ['tipo',payload.kind,(verified.kind||'')],['observações',payload.notes,(verified.notes||'')],
      ['vínculo',payload.relationship,(verified.relationship||'')]
    ];
    const failed=checks.filter(([,a,b])=>String(a)!==String(b)).map(([label])=>label);
    if(expectedUnit!==savedUnit)failed.push('unidade');
    if(failed.length)throw new Error('O Contact Core não confirmou estes campos: '+failed.join(', ')+'.');
    applyContactCore(verified,{fallbackName:payload.name,fallbackPhone:payload.phone});
    document.getElementById('contactModal').classList.add('hidden');
    showToast('Contato salvo e sincronizado em todas as telas.','success');
    await loadChats({preserveSelection:true});
    await reloadWorkspace(currentChatId);
  }catch(error){err.textContent=error.message||String(error);showToast(err.textContent,'error');}
  finally{btn.disabled=false;btn.textContent='Salvar identificação';}
}

async function createCondoInline(){
  const name=prompt('Nome do condomínio:'); if(!name?.trim())return;
  const r=await fetch('/api/condominiums',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:name.trim()})});
  const data=await r.json(); if(!r.ok)return alert(data.error||'Não foi possível cadastrar o condomínio.');
  await loadCrmMeta(); document.getElementById('contactCondoInput').value=data.id; await loadUnits(data.id);
}
async function createUnitInline(){
  const condominiumId=document.getElementById('contactCondoInput').value; if(!condominiumId)return alert('Selecione primeiro o condomínio.');
  const block=prompt('Bloco (pode deixar vazio):')??''; const number=prompt('Número da unidade:'); if(!number?.trim())return;
  const r=await fetch('/api/units',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({condominiumId,block:block.trim(),number:number.trim()})});
  const data=await r.json(); if(!r.ok)return alert(data.error||'Não foi possível cadastrar a unidade.');
  await loadUnits(condominiumId); document.getElementById('contactUnitInput').value=data.id;
}

async function loadMeta() {
  try {
    [agents,queues]=await Promise.all([fetch('/api/agents').then(r=>r.json()),fetch('/api/queues').then(r=>r.json())]);
    document.getElementById('agentSelect').innerHTML='<option value="">Sem atendente / voltar para fila</option>'+agents.map(a=>{const available=a.status==='online'&&a.connected!==false;return `<option value="${esc(a.id)}" ${available?'':'disabled'}>${esc(a.name)} · ${esc(statusLabel(a.status))}</option>`;}).join('');
    document.getElementById('queueSelect').innerHTML=queues.map(q=>`<option value="${esc(q.id)}">${esc(q.name)}</option>`).join('');
    const qf=document.getElementById('queueFilter'); if(qf){const keep=qf.value;qf.innerHTML='<option value="">☷ Todas as filas</option>'+queues.map(q=>`<option value="${esc(q.id)}">${esc(q.name)}</option>`).join('');qf.value=keep;}
    const me=agents.find(a=>a.id===CURRENT_AGENT_ID); if(me&&document.getElementById('agentStatusSelect')) document.getElementById('agentStatusSelect').value=me.availability||me.status||'online';
  } catch(e){console.warn(e);}
}

async function loadDashboard(){
  if(!liveMode)return;
  try{const d=await fetch('/api/dashboard').then(r=>r.json());
    document.getElementById('kOpen').textContent=d.open??0;
    document.getElementById('kWaiting').textContent=d.waiting??0;
    document.getElementById('kAnswered').textContent=d.answeredToday??0;
    document.getElementById('kAvgResponse').textContent=formatMinutes(d.avgFirstResponseMinutes);
    document.getElementById('kClosedToday').textContent=d.closedToday??0;
  }catch(e){console.warn(e);}
}

async function loadChats({preserveSelection=true}={}) {
  if(!liveMode){chats=demoChats;renderChats();if(!currentChatId)selectChat(chats[0].id,chats[0]);return;}
  try {
    const r=await fetch('/api/chats'); const data=await r.json(); if(!r.ok)throw new Error(data.error||'Falha ao carregar chats');
    chats=data.map(c=>({...c,preview:c.lastMessage,time:formatTime(c.timestamp),initials:initials(c.name)}));
    renderChats();
    const visible=filteredChats();
    const currentStillExists = !!currentChatId && chats.some(c=>c.id===currentChatId);

    // v0.9.3: transferir para outro atendente pode retirar a conversa do filtro
    // "Minhas". Isso NÃO deve trocar a conversa aberta nem limpar seu painel.
    if(!preserveSelection || !currentChatId || !currentStillExists) {
      if(visible.length) selectChat(visible[0].id,visible[0]);
    }
  }catch(e){console.warn(e);}
}
function scheduleChatsReload(){clearTimeout(reloadTimer);reloadTimer=setTimeout(()=>{loadChats({preserveSelection:true});loadDashboard();},350);}

async function reloadWorkspace(chatId=currentChatId) {
  if(!liveMode||!chatId||chatId.startsWith('demo-')) return;
  try {
    const [wr,core]=await Promise.all([
      fetch('/api/workspace/'+encodeURIComponent(chatId),{cache:'no-store'}),
      fetchContactCore(chatId)
    ]);
    const data=await wr.json();
    if(!wr.ok) throw new Error(data.error||'Falha ao recarregar atendimento.');
    if(chatId!==currentChatId) return;
    if(data.attendance) renderAttendance(data.attendance);
    const fallbackName=data.chat?.name||document.getElementById('chatName').textContent||'Contato';
    applyContactCore(core,{fallbackName,fallbackPhone:fallbackPhoneFromChat(chatId)});
  } catch(error) {
    console.warn('Falha ao reidratar workspace:',error);
  }
}

function setOverlay(show){document.getElementById('qrOverlay').classList.toggle('hidden',!show);}
function setState(s){
  const text=document.getElementById('availabilityText'),qr=document.getElementById('qrImage'),pill=document.getElementById('qrStatus');
  if(s.status==='ready'){liveMode=true;text.textContent='Disponível';pill.textContent=s.profile?.pushname?`Conectado: ${s.profile.pushname}`:'WhatsApp conectado';pill.className='status-pill green';qr.removeAttribute('src');qr.style.display='none';setOverlay(false);loadMeta().then(()=>{loadChats({preserveSelection:false});loadDashboard();});}
  else if(s.status==='qr'&&s.qr){liveMode=false;text.textContent='Escanear QR';qr.style.display='block';qr.src=s.qr;pill.textContent='QR Code pronto para leitura';pill.className='status-pill amber';setOverlay(true);}
  else if(s.status==='pairing'){liveMode=false;text.textContent='Gerando QR';qr.removeAttribute('src');qr.style.display='none';pill.textContent=s.lastError||'Gerando um novo QR Code automaticamente…';pill.className='status-pill amber';setOverlay(true);}
  else if(s.status==='error'){liveMode=false;text.textContent='Erro';qr.removeAttribute('src');qr.style.display='none';pill.textContent=s.lastError||'Falha na conexão';pill.className='status-pill red';setOverlay(true);}
  else{liveMode=false;text.textContent='Conectar';qr.removeAttribute('src');qr.style.display='none';pill.textContent=s.status==='disconnected'?'WhatsApp desconectado':(s.lastError||'Inicializando conexão com WhatsApp…');pill.className='status-pill amber';if(s.status==='starting')setOverlay(true);}
}

let pendingTransferredChatId = null;

function transferEligibleAgent(agent, queueId=''){
  if(!agent || agent.id===CURRENT_AGENT_ID) return false;
  if(agent.connected===false || agent.status!=='online') return false;
  const capacity=Number(agent.maxActive||agent.capacity||5);
  const active=Number(agent.active ?? chats.filter(c=>c.attendance?.agentId===agent.id && c.attendance?.status!=='closed').length);
  if(active>=capacity) return false;
  if(queueId && Array.isArray(agent.queueIds) && agent.role==='agent' && !agent.queueIds.includes(queueId)) return false;
  return true;
}

function refreshTransferAgentOptions(){
  const select=document.getElementById('transferAgentSelect');
  const queueId=document.getElementById('transferQueueSelect')?.value || currentAttendance?.queueId || 'geral';
  if(!select)return;
  const rows=agents.filter(a=>a.id!==CURRENT_AGENT_ID).map(a=>{
    const capacity=Number(a.maxActive||a.capacity||5), active=Number(a.active ?? chats.filter(c=>c.attendance?.agentId===a.id && c.attendance?.status!=='closed').length);
    const eligible=transferEligibleAgent(a,queueId);
    const status=eligible?`Online · ${active}/${capacity}`:(a.status!=='online'||a.connected===false?'Offline/ausente':active>=capacity?`Lotado · ${active}/${capacity}`:'Sem acesso à fila');
    return `<option value="${esc(a.id)}" ${eligible?'':'disabled'}>${esc(a.name)} — ${esc(status)}</option>`;
  });
  select.innerHTML='<option value="">Selecione um atendente</option>'+rows.join('');
}

function openTransferModal(){
  if(!currentChatId || !currentAttendance) return showToast('Selecione um atendimento antes de transferir.','error');
  if(currentAttendance.status==='closed') return showToast('Reabra o atendimento antes de transferir.','error');
  const modal=document.getElementById('transferModal');
  const q=document.getElementById('transferQueueSelect');
  q.innerHTML=queues.map(item=>`<option value="${esc(item.id)}">${esc(item.name)}</option>`).join('');
  q.value=currentAttendance.queueId||'geral';
  document.querySelector('input[name="transferMode"][value="queue"]').checked=true;
  document.getElementById('transferAgentSelect').disabled=true;
  document.getElementById('transferReason').value='';
  document.getElementById('transferReasonCount').textContent='0';
  document.getElementById('transferKeepHistory').checked=true;
  document.getElementById('transferError').textContent='';
  refreshTransferAgentOptions();
  modal.classList.remove('hidden');
}

function closeTransferModal(){document.getElementById('transferModal')?.classList.add('hidden');}

document.querySelectorAll('input[name="transferMode"]').forEach(r=>r.addEventListener('change',()=>{
  const toAgent=document.querySelector('input[name="transferMode"]:checked')?.value==='agent';
  document.getElementById('transferAgentSelect').disabled=!toAgent;
  if(toAgent) refreshTransferAgentOptions();
}));
document.getElementById('transferQueueSelect')?.addEventListener('change',refreshTransferAgentOptions);
document.getElementById('transferReason')?.addEventListener('input',e=>document.getElementById('transferReasonCount').textContent=String(e.target.value.length));
document.getElementById('closeTransferModal')?.addEventListener('click',closeTransferModal);
document.getElementById('cancelTransferBtn')?.addEventListener('click',closeTransferModal);
document.getElementById('transferModal')?.addEventListener('click',e=>{if(e.target.id==='transferModal')closeTransferModal();});
document.getElementById('confirmTransferBtn')?.addEventListener('click',async()=>{
  const mode=document.querySelector('input[name="transferMode"]:checked')?.value||'queue';
  const queueId=document.getElementById('transferQueueSelect').value||currentAttendance?.queueId||'geral';
  const agentId=mode==='agent'?(document.getElementById('transferAgentSelect').value||null):null;
  const reason=document.getElementById('transferReason').value.trim();
  const err=document.getElementById('transferError'); err.textContent='';
  if(mode==='agent'&&!agentId){err.textContent='Selecione um atendente disponível.';return;}
  const btn=document.getElementById('confirmTransferBtn');btn.disabled=true;btn.textContent='Transferindo...';
  try{
    await attendanceAction('transfer',{agentId,queueId,reason,keepHistory:document.getElementById('transferKeepHistory').checked});
    closeTransferModal();
    showToast(mode==='agent'?'Atendimento transferido e atendente notificado.':'Atendimento enviado para a fila.');
  }catch(error){err.textContent=error.message||String(error);}
  finally{btn.disabled=false;btn.innerHTML='➤&nbsp;&nbsp; Transferir atendimento';}
});

function showTransferNotice(payload){
  if(!payload || payload.toAgentId!==CURRENT_AGENT_ID) return;
  pendingTransferredChatId=payload.chatId||null;
  const notice=document.getElementById('transferNotice');
  const txt=document.getElementById('transferNoticeText');
  txt.textContent=`${payload.fromAgentName||'A equipe'} enviou a conversa de ${payload.contactName||'um contato'} para você${payload.queueName?` · ${payload.queueName}`:''}.${payload.reason?` Motivo: ${payload.reason}`:''}`;
  notice.classList.remove('hidden');
  try{if('Notification' in window && Notification.permission==='granted')new Notification('ConnectTalk · Atendimento transferido',{body:txt.textContent});}catch{}
  clearTimeout(showTransferNotice.timer);showTransferNotice.timer=setTimeout(()=>notice.classList.add('hidden'),12000);
}

document.getElementById('closeTransferNotice')?.addEventListener('click',()=>document.getElementById('transferNotice').classList.add('hidden'));
document.getElementById('dismissTransferredChat')?.addEventListener('click',()=>document.getElementById('transferNotice').classList.add('hidden'));
document.getElementById('openTransferredChat')?.addEventListener('click',async()=>{
  const chatId=pendingTransferredChatId;document.getElementById('transferNotice').classList.add('hidden');
  if(!chatId)return;
  await loadChats({preserveSelection:true});
  const chat=chats.find(c=>c.id===chatId);
  if(chat)selectChat(chatId,chat);else{currentChatId=chatId;await reloadWorkspace(chatId);}
});

async function attendanceAction(action, body={}) {
  if(!currentChatId||currentChatId.startsWith('demo-')) return;
  const actionChatId=currentChatId;
  const r=await fetch(`/api/attendance/${encodeURIComponent(actionChatId)}/${action}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const data=await r.json();
  if(!r.ok){const error=new Error(data.error||'Não foi possível atualizar o atendimento.');showToast(error.message,'error');throw error;}

  // Transferência v0.9.3 devolve snapshot completo; demais ações continuam
  // compatíveis com a resposta antiga do atendimento.
  const attendance=data?.attendance||data;
  if(actionChatId===currentChatId && attendance) renderAttendance(attendance);
  if(action==='transfer' && actionChatId===currentChatId) {
    showToast('Atendimento transferido. Revalidando o Contact Core…');
  }

  // Primeiro reidrata a conversa atual; depois atualiza a lista em background.
  await reloadWorkspace(actionChatId);
  scheduleChatsReload();
}

document.getElementById('claimBtn').onclick=()=>attendanceAction('claim',{agentId:CURRENT_AGENT_ID});
document.getElementById('transferBtn').onclick=openTransferModal;
document.getElementById('closeAttendanceBtn').onclick=()=>attendanceAction(currentAttendance?.status==='closed'?'reopen':'close');
document.getElementById('prioritySelect').onchange=e=>attendanceAction('priority',{priority:e.target.value});
document.getElementById('saveTagsBtn').onclick=()=>{const tags=document.getElementById('tagsInput').value.split(',').map(v=>v.trim()).filter(Boolean);attendanceAction('tags',{tags});};
document.getElementById('addNoteBtn').onclick=async()=>{const input=document.getElementById('internalNoteInput');const text=input.value.trim();if(!text)return;await attendanceAction('note',{text,agentId:CURRENT_AGENT_ID});input.value='';};
document.getElementById('agentStatusSelect').onchange=async e=>{const status=e.target.value;try{const r=await fetch(`/api/agents/${CURRENT_AGENT_ID}/status`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({status})});if(!r.ok)throw new Error();document.getElementById('agentStatusDot').className=`online-dot ${status}`;await loadMeta();}catch{alert('Não foi possível alterar seu status.');}};
document.querySelectorAll('#attendanceTabs button').forEach(btn=>btn.onclick=()=>{document.querySelectorAll('#attendanceTabs button').forEach(b=>b.classList.remove('selected'));btn.classList.add('selected');activeFilter=btn.dataset.filter;renderChats();const visible=filteredChats();if(visible.length)selectChat(visible[0].id,visible[0]);});

socket.on('wa:state',state=>{if(currentUser)setState(state);});
socket.on('wa:chats',list=>{if(!liveMode||!Array.isArray(list))return;chats=list.map(c=>({...c,preview:c.lastMessage,time:formatTime(c.timestamp),initials:initials(c.name)}));renderChats();if(!currentChatId&&filteredChats().length)selectChat(filteredChats()[0].id,filteredChats()[0]);});
socket.on('wa:message',m=>{if(!liveMode)return;if(m.chatId===currentChatId)appendMessage(m);scheduleChatsReload();if(m.chatId===currentChatId)loadAttendance(currentChatId);});
socket.on('attendance:update',a=>{if(a?.chatId===currentChatId)renderAttendance(a);scheduleChatsReload();});
socket.on('transfer:received',payload=>{showTransferNotice(payload);scheduleChatsReload();});
socket.on('agents:update',list=>{if(!Array.isArray(list))return;agents=list;const me=agents.find(a=>a.id===CURRENT_AGENT_ID);if(me){document.getElementById('agentStatusSelect').value=me.availability||me.status;document.getElementById('agentStatusDot').className=`online-dot ${me.status}`;}loadMeta();});
socket.on('queues:update',list=>{if(!Array.isArray(list))return;queues=list;loadMeta();renderChats();});
socket.on('supervisor:update',data=>{const modal=document.getElementById('supervisorModal');if(['supervisor','admin'].includes(currentUser?.role)&&modal&&!modal.classList.contains('hidden'))renderSupervisorData(data);});
setInterval(()=>{if(socket.connected&&CURRENT_AGENT_ID)socket.emit('presence:heartbeat');},10000);

document.getElementById('connectBtn').onclick=async()=>{setOverlay(true);try{const st=await fetch('/api/status').then(r=>r.json());if(st.status==='error'||st.status==='disconnected')await fetch('/api/reconnect',{method:'POST'});}catch(e){console.warn(e);}};
document.getElementById('closeQr').onclick=()=>setOverlay(false);
document.getElementById('logoutBtn').onclick=async()=>{
  try{await fetch('/api/auth/logout',{method:'POST'});}catch{}
  try{socket.disconnect();}catch{}
  currentUser=null;CURRENT_AGENT_ID='';liveMode=false;currentChatId=null;chats=[];renderChats();
  document.getElementById('loginOverlay').classList.remove('hidden');
};
document.getElementById('chatSearch').oninput=e=>{const q=e.target.value.toLowerCase();const base=filteredChats();const filtered=base.filter(c=>(c.name+' '+(c.preview||c.lastMessage||'')).toLowerCase().includes(q));const old=chats;chats=filtered;renderChats();chats=old;};

async function send(){
  const input=document.getElementById('messageInput'),message=input.value.trim();if(!message)return;
  if(!liveMode||!currentChatId||currentChatId.startsWith('demo-')){appendMessage({id:`demo-${Date.now()}`,fromMe:true,body:message,timestamp:Math.floor(Date.now()/1000)});input.value='';return;}
  const r=await fetch('/api/send',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chatId:currentChatId,message,agentId:CURRENT_AGENT_ID})});const data=await r.json();if(!r.ok)return alert(data.error||'Falha ao enviar');input.value='';
}
document.getElementById('sendBtn').onclick=send;
document.getElementById('messageInput').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send();}});

// inicialização ocorre em bootstrapAuth() na v0.11


document.getElementById('identifyContactBtn')?.addEventListener('click',openContactModal);
document.getElementById('editContactBtn')?.addEventListener('click',openContactModal);
document.getElementById('closeContactModal')?.addEventListener('click',()=>document.getElementById('contactModal').classList.add('hidden'));
document.getElementById('contactCondoInput')?.addEventListener('change',e=>loadUnits(e.target.value));
document.getElementById('saveContactBtn')?.addEventListener('click',saveCrmContact);

document.getElementById('newCondoBtn')?.addEventListener('click',createCondoInline);
document.getElementById('newUnitBtn')?.addEventListener('click',createUnitInline);


// v0.9.3 — versão visível, diretório de contatos, mensagens rápidas e transferência segura
async function loadAppInfo(){
  try{
    const info=await fetch('/api/app-info',{cache:'no-store'}).then(r=>r.json());
    const label=`v${info.version||'0.14.0'}`;
    document.getElementById('appVersion').textContent=label;
    document.getElementById('layoutVersion').textContent=label;
  }catch{}
}

async function openContactsDirectory(){
  const modal=document.getElementById('contactsModal');
  modal.classList.remove('hidden');
  await renderContactsDirectory();
  setTimeout(()=>document.getElementById('contactsSearchInput')?.focus(),30);
}
async function renderContactsDirectory(){
  const box=document.getElementById('contactsDirectory');
  const q=(document.getElementById('contactsSearchInput')?.value||'').trim().toLowerCase();
  box.innerHTML='<div class="directory-empty">Carregando contatos…</div>';
  try{
    const list=await fetch('/api/contacts',{cache:'no-store'}).then(r=>r.json());
    const filtered=list.filter(p=>{
      const u=p.unit||{};
      return [p.name,p.phone,p.email,p.document,p.kind,u.condominiumName,u.block,u.number].join(' ').toLowerCase().includes(q);
    });
    document.getElementById('contactsCount').textContent=`${filtered.length} contato${filtered.length===1?'':'s'}`;
    box.innerHTML=filtered.length?filtered.map(p=>{
      const u=p.unit||{};
      const place=u.condominiumName?`${u.condominiumName}${u.block?` · Bloco ${u.block}`:''}${u.number?` · Unidade ${u.number}`:''}`:'Sem unidade vinculada';
      return `<div class="directory-row" data-contact-id="${p.id}"><div class="avatar">${esc(initials(p.name))}</div><div class="directory-main"><strong>${esc(p.name)}</strong><span>${esc(p.phone||'Sem telefone')} · ${esc(p.email||'Sem e-mail')}</span><small>${esc(place)}</small></div><div class="directory-actions"><span class="kind-pill">${esc(p.kind||'morador')}</span><button class="edit-directory-contact" data-id="${p.id}">Editar</button></div></div>`;
    }).join(''):'<div class="directory-empty">Nenhum contato encontrado.</div>';
    box.querySelectorAll('.edit-directory-contact').forEach(btn=>btn.onclick=async()=>{
      const person=await fetch('/api/contact-core-person/'+btn.dataset.id,{cache:'no-store'}).then(r=>r.json());
      currentCrmContact=person;
      if(person.technicalId){
        const candidate=chats.find(c=>c.id===person.technicalId);
        if(candidate){await selectChat(candidate.id,candidate);}
        else currentChatId=person.technicalId;
      }
      document.getElementById('contactsModal').classList.add('hidden');
      await openContactModal();
    });
  }catch(error){box.innerHTML=`<div class="directory-empty error-text">${esc(error.message||String(error))}</div>`;}
}
function insertQuickReply(text){
  const input=document.getElementById('messageInput');
  input.value=text||'';
  input.focus();
  input.setSelectionRange(input.value.length,input.value.length);
  document.getElementById('quickRepliesModal')?.classList.add('hidden');
}

document.getElementById('contactsNav')?.addEventListener('click',e=>{e.preventDefault();openContactsDirectory();});
document.getElementById('closeContactsModal')?.addEventListener('click',()=>document.getElementById('contactsModal').classList.add('hidden'));
document.getElementById('contactsSearchInput')?.addEventListener('input',()=>renderContactsDirectory());
document.getElementById('quickRepliesNav')?.addEventListener('click',e=>{e.preventDefault();document.getElementById('quickRepliesModal').classList.remove('hidden');});
document.getElementById('closeQuickRepliesModal')?.addEventListener('click',()=>document.getElementById('quickRepliesModal').classList.add('hidden'));
document.querySelectorAll('#quickRepliesList button,.quick-insert').forEach(btn=>btn.addEventListener('click',()=>insertQuickReply(btn.dataset.text||'')));
document.getElementById('copyPhoneBtn')?.addEventListener('click',async()=>{const phone=document.getElementById('infoPhone').textContent.trim();try{await navigator.clipboard.writeText(phone);showToast('Telefone copiado.');}catch{showToast('Não foi possível copiar o telefone.','error');}});

document.getElementById('messageInput')?.addEventListener('input',e=>{
  const map={
    '/boleto':'Olá! Vou verificar a 2ª via do boleto para você e já retorno.',
    '/recebido':'Recebemos sua solicitação e ela já foi encaminhada ao setor responsável.',
    '/horario':'Nosso atendimento funciona de segunda a sexta-feira, das 8h às 17h.',
    '/finalizar':'Seu atendimento foi concluído. Se precisar de algo mais, estamos à disposição.'
  };
  const key=e.target.value.trim().toLowerCase();
  if(map[key]){e.target.value=map[key];e.target.setSelectionRange(e.target.value.length,e.target.value.length);}
});
loadAppInfo();


// v0.13 — presença real, supervisão ao vivo e roteamento seguro.
function applyCurrentUser(user){
  currentUser=user; CURRENT_AGENT_ID=user?.id||'';
  const name=user?.name||'Usuário';
  const initialsText=initials(name);
  document.getElementById('currentUserName').textContent=name;
  document.getElementById('currentUserInitials').textContent=initialsText;
  document.getElementById('agentStatusDot').className=`online-dot ${user?.status||'online'}`;
  document.getElementById('teamNav').style.display=user?.role==='admin'?'flex':'none'; const sn=document.getElementById('supervisorNav'); if(sn) sn.style.display=['supervisor','admin'].includes(user?.role)?'flex':'none';
}
async function bootstrapAuth(){
  await loadAppInfo();
  try{
    const r=await fetch('/api/me',{cache:'no-store'}); const data=await r.json();
    if(!r.ok) throw new Error('login');
    applyCurrentUser(data.user);
    document.getElementById('loginOverlay').classList.add('hidden');
    await loadMeta();
    const st=await fetch('/api/status',{cache:'no-store'}).then(r=>r.json()); setState(st);
    if(st.status==='ready'){liveMode=true;await loadChats({preserveSelection:false});await loadDashboard();}
  }catch{
    document.getElementById('loginOverlay').classList.remove('hidden');
  }
}

document.getElementById('loginForm')?.addEventListener('submit',async e=>{
  e.preventDefault(); const err=document.getElementById('loginError'); err.textContent='';
  const email=document.getElementById('loginEmail').value.trim(),password=document.getElementById('loginPassword').value;
  try{
    const r=await fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,password})});
    const data=await r.json(); if(!r.ok)throw new Error(data.error||'Falha no login.');
    applyCurrentUser(data.user); document.getElementById('loginOverlay').classList.add('hidden');
    reconnectRealtimeIdentity();
    await new Promise(r=>setTimeout(r,120));
    await loadMeta(); const st=await fetch('/api/status',{cache:'no-store'}).then(r=>r.json()); setState(st);
    if(st.status==='ready'){liveMode=true;await loadChats({preserveSelection:false});await loadDashboard();}
    showToast(`Bem-vindo, ${data.user.name}.`);
  }catch(error){err.textContent=error.message||String(error);}
});

document.getElementById('queueFilter')?.addEventListener('change',e=>{activeQueueFilter=e.target.value||'';renderChats();});

async function renderTeamAdmin(){
  if(currentUser?.role!=='admin')return;
  const [users,qs]=await Promise.all([fetch('/api/admin/users',{cache:'no-store'}).then(r=>r.json()),fetch('/api/admin/queues',{cache:'no-store'}).then(r=>r.json())]);
  document.getElementById('teamUsers').innerHTML=users.map(u=>`<div class="admin-row"><div><strong>${esc(u.name)}</strong><small>${esc(u.email)} · ${esc(u.status)} · limite ${u.maxActive||5}</small></div><input class="capacity-input" data-id="${esc(u.id)}" type="number" min="1" max="50" value="${u.maxActive||5}" style="width:55px;height:30px"><select class="role-select" data-id="${esc(u.id)}"><option value="agent" ${u.role==='agent'?'selected':''}>Atendente</option><option value="supervisor" ${u.role==='supervisor'?'selected':''}>Supervisor</option><option value="admin" ${u.role==='admin'?'selected':''}>Administrador</option></select>${u.id===CURRENT_AGENT_ID?'':'<button class="deactivate-user" data-id="'+esc(u.id)+'">Desativar</button>'}<div style="flex-basis:100%;font-size:10px;color:#667085">Filas: ${qs.map(q=>`<label style="margin-right:8px"><input type="checkbox" class="user-queue-check" data-user="${esc(u.id)}" value="${esc(q.id)}" ${(u.queueIds||[]).includes(q.id)?'checked':''}> ${esc(q.name)}</label>`).join('')}</div></div>`).join('');
  document.getElementById('teamQueues').innerHTML=qs.map(q=>`<div class="admin-row"><div><strong>${esc(q.name)}</strong><small>${esc(q.id)} · SLA ${q.sla_minutes||15} min · ${Number(q.auto_assign||0)?'automática':'manual'}</small></div><input class="queue-sla" data-id="${esc(q.id)}" type="number" min="1" max="1440" value="${q.sla_minutes||15}" style="width:60px;height:30px"><label style="font-size:10px"><input class="queue-auto" data-id="${esc(q.id)}" type="checkbox" ${Number(q.auto_assign||0)?'checked':''}> Auto</label></div>`).join('');
  document.querySelectorAll('.role-select').forEach(sel=>sel.onchange=async()=>{const r=await fetch(`/api/admin/users/${encodeURIComponent(sel.dataset.id)}/role`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({role:sel.value})});const d=await r.json();if(!r.ok)return showToast(d.error||'Erro','error');showToast('Perfil atualizado.');await renderTeamAdmin();await loadMeta();});
  document.querySelectorAll('.user-queue-check').forEach(ch=>ch.onchange=async()=>{const uid=ch.dataset.user;const ids=[...document.querySelectorAll(`.user-queue-check[data-user="${uid}"]:checked`)].map(x=>x.value);const r=await fetch(`/api/admin/users/${encodeURIComponent(uid)}/queues`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({queueIds:ids})});const d=await r.json();if(!r.ok)return showToast(d.error||'Erro','error');showToast('Permissões de fila atualizadas.');}); document.querySelectorAll('.capacity-input').forEach(inp=>inp.onchange=async()=>{const r=await fetch(`/api/admin/users/${encodeURIComponent(inp.dataset.id)}/capacity`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({maxActive:Number(inp.value)})});const d=await r.json();if(!r.ok)return showToast(d.error||'Erro','error');showToast('Capacidade atualizada.');}); document.querySelectorAll('.queue-sla,.queue-auto').forEach(el=>el.onchange=async()=>{const id=el.dataset.id;const sla=document.querySelector(`.queue-sla[data-id="${id}"]`);const auto=document.querySelector(`.queue-auto[data-id="${id}"]`);const r=await fetch(`/api/admin/queues/${encodeURIComponent(id)}/operations`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({slaMinutes:Number(sla.value),autoAssign:auto.checked})});const d=await r.json();if(!r.ok)return showToast(d.error||'Erro','error');showToast('Operação da fila atualizada.');});
  document.querySelectorAll('.deactivate-user').forEach(btn=>btn.onclick=async()=>{if(!confirm('Desativar este usuário?'))return;const r=await fetch(`/api/admin/users/${encodeURIComponent(btn.dataset.id)}`,{method:'DELETE'});const d=await r.json();if(!r.ok)return showToast(d.error||'Erro','error');showToast('Usuário desativado.');await renderTeamAdmin();await loadMeta();});
}


function renderSupervisorData(data){
  supervisorLiveData=data;
  const t=data?.totals||{};
  const totalBreaches=(data?.queues||[]).reduce((n,q)=>n+Number(q.slaBreached||0),0);
  document.getElementById('supervisorKpis').innerHTML=[
    ['Abertos',t.open||0],['Na fila',t.waiting||0],['Em atendimento',t.assigned||0],['Aguardando cliente',t.waitingCustomer||0],['SLA vencido',totalBreaches]
  ].map(([label,value])=>`<article><small>${esc(label)}</small><strong>${Number(value)||0}</strong></article>`).join('');
  document.getElementById('supervisorAgents').innerHTML=(data?.agents||[]).map(a=>{
    const active=Number(a.active||0),capacity=Math.max(1,Number(a.capacity||a.maxActive||5));
    const pct=Math.min(100,Math.round(active/capacity*100));
    const live=a.connected===true;
    const label=live?statusLabel(a.status):'Offline';
    const seen=a.lastSeenAt?` · visto ${formatDate(a.lastSeenAt)}`:'';
    return `<div class="ops-row"><div><strong>${esc(a.name)}</strong><small>${live?'●':'○'} ${esc(label)} · ${esc(a.role||'agent')}${esc(seen)}</small></div><div class="load-meter" title="${active}/${capacity}"><i style="width:${pct}%"></i></div><strong>${active}/${capacity}</strong></div>`;
  }).join('')||'<p class="empty-state">Nenhum agente encontrado.</p>';
  document.getElementById('supervisorQueues').innerHTML=(data?.queues||[]).map(q=>`<div class="ops-row"><div><strong>${esc(q.name)}</strong><small>${Number(q.auto_assign||0)?'Distribuição automática':'Distribuição manual'} · SLA ${Number(q.sla_minutes||15)} min</small></div><small>${Number(q.waiting||0)} fila / ${Number(q.open||0)} abertos</small><strong class="${Number(q.slaBreached||0)>0?'sla-breach':''}">${Number(q.slaBreached||0)} SLA</strong></div>`).join('')||'<p class="empty-state">Nenhuma fila encontrada.</p>';
}

async function renderSupervisor(){
  if(!['supervisor','admin'].includes(currentUser?.role)) return;
  const r=await fetch('/api/supervisor',{cache:'no-store'});
  const data=await r.json();
  if(!r.ok) throw new Error(data.error||'Não foi possível carregar a supervisão.');
  renderSupervisorData(data);
}

document.getElementById('supervisorNav')?.addEventListener('click',async e=>{
  e.preventDefault();
  if(!['supervisor','admin'].includes(currentUser?.role)) return showToast('Acesso restrito à supervisão.','error');
  const modal=document.getElementById('supervisorModal');
  modal.classList.remove('hidden');
  try{await renderSupervisor();}catch(error){modal.classList.add('hidden');showToast(error.message||String(error),'error');}
});
document.getElementById('closeSupervisorModal')?.addEventListener('click',()=>document.getElementById('supervisorModal').classList.add('hidden'));
document.getElementById('supervisorModal')?.addEventListener('click',e=>{if(e.target.id==='supervisorModal')e.currentTarget.classList.add('hidden');});

document.getElementById('teamNav')?.addEventListener('click',async e=>{e.preventDefault();if(currentUser?.role!=='admin')return;document.getElementById('teamModal').classList.remove('hidden');await renderTeamAdmin();});
document.getElementById('closeTeamModal')?.addEventListener('click',()=>document.getElementById('teamModal').classList.add('hidden'));
document.getElementById('newUserForm')?.addEventListener('submit',async e=>{e.preventDefault();const body={name:document.getElementById('newUserName').value.trim(),email:document.getElementById('newUserEmail').value.trim(),password:document.getElementById('newUserPassword').value,role:document.getElementById('newUserRole').value};const r=await fetch('/api/admin/users',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const d=await r.json();if(!r.ok)return showToast(d.error||'Erro ao criar usuário.','error');e.target.reset();showToast('Usuário criado.');await renderTeamAdmin();await loadMeta();});
document.getElementById('newQueueForm')?.addEventListener('submit',async e=>{e.preventDefault();const body={name:document.getElementById('newQueueName').value.trim()};const r=await fetch('/api/admin/queues',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const d=await r.json();if(!r.ok)return showToast(d.error||'Erro ao criar fila.','error');e.target.reset();showToast('Fila criada.');await renderTeamAdmin();await loadMeta();});

bootstrapAuth();
