import express from 'express';
import http from 'http';
import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';
import QRCode from 'qrcode';
import pino from 'pino';
import { Boom } from '@hapi/boom';
import { Server } from 'socket.io';
import { createDatabase } from './db.js';
import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState
} from '@whiskeysockets/baileys';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = Number(process.env.PORT || 3000);
const APP_VERSION = '0.13.1';
const AUTO_ASSIGN_DELAY_MS = 30_000;
const APP_NAME = 'ConnectTalk';
const AUTH_DIR = path.join(__dirname, 'baileys_auth');
const DATA_DIR = path.join(__dirname, 'data');
const ATTENDANCE_FILE = path.join(DATA_DIR, 'attendances.json');
const logger = pino({ level: process.env.WA_LOG_LEVEL || 'silent' });
const contactDb = createDatabase(__dirname);
console.log(`Banco ConnectTalk: ${contactDb.dbPath}`);

const SESSION_COOKIE = 'ct_session';
function parseCookies(req) {
  const out = {};
  for (const chunk of String(req.headers.cookie || '').split(';')) {
    const i = chunk.indexOf('=');
    if (i > 0) out[decodeURIComponent(chunk.slice(0,i).trim())] = decodeURIComponent(chunk.slice(i+1).trim());
  }
  return out;
}
function requestSession(req) { return contactDb.getSession(parseCookies(req)[SESSION_COOKIE] || ''); }
function requireAuth(req,res,next) {
  const session = requestSession(req);
  if (!session?.user) return res.status(401).json({ error: 'Sessão expirada. Entre novamente.' });
  req.session = session; req.user = session.user; next();
}
function requireAdmin(req,res,next) {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Acesso restrito ao administrador.' });
  next();
}
function cookieFor(token,maxAge=86400){ return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`; }


app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

let sock = null;
let generation = 0;
let reconnectTimer = null;
let reconnectAttempts = 0;
let manualLogout = false;
let currentWaVersion = null;
let autoQrResetInProgress = false;
let qrWatchdogTimer = null;
let freshPairingAttempts = 0;

let waState = { status: 'starting', qr: null, profile: null, lastError: null, version: null };
const contacts = new Map();
const chats = new Map();
const messagesByChat = new Map();
const seenMessageIds = new Set();

let agents = contactDb.listUsers();
let queues = contactDb.listServiceQueues();
const userSockets = new Map();
const userDisconnectTimers = new Map();
const userLastSeenAt = new Map();

function connectedSocketCount(userId) { return userSockets.get(userId)?.size || 0; }
function isUserConnected(userId) { return connectedSocketCount(userId) > 0; }
function effectiveAgent(user) {
  if (!user) return null;
  return { ...user, connected: isUserConnected(user.id), socketCount: connectedSocketCount(user.id), lastSeenAt: userLastSeenAt.get(user.id) || null };
}
function emitSupervisorUpdate() {
  io.emit('supervisor:update', supervisorSnapshot());
}
function refreshTeamDirectory({ emit = false } = {}) {
  agents = contactDb.listUsers();
  queues = contactDb.listServiceQueues();
  if (emit) { io.emit('agents:update', agents.map(effectiveAgent)); io.emit('queues:update', queues); emitSupervisorUpdate(); }
}


let attendances = new Map();
let attendancePersistTimer = null;

async function loadAttendances() {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    const raw = await fs.readFile(ATTENDANCE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    attendances = new Map((parsed.attendances || []).map(item => [item.chatId, item]));
  } catch (error) {
    if (error?.code !== 'ENOENT') console.warn('Falha ao carregar atendimentos:', error?.message || error);
    attendances = new Map();
  }
}

function scheduleAttendancePersist() {
  clearTimeout(attendancePersistTimer);
  attendancePersistTimer = setTimeout(async () => {
    try {
      await fs.mkdir(DATA_DIR, { recursive: true });
      await fs.writeFile(ATTENDANCE_FILE, JSON.stringify({ attendances: [...attendances.values()] }, null, 2));
    } catch (error) {
      console.error('Falha ao salvar atendimentos:', error?.message || error);
    }
  }, 120);
}

function nowIso() { return new Date().toISOString(); }

function publicAttendance(item) {
  if (!item) return null;
  const agent = agents.find(a => a.id === item.agentId) || null;
  const queue = queues.find(q => q.id === item.queueId) || null;
  return { ...item, priority: item.priority || 'normal', tags: Array.isArray(item.tags) ? item.tags : [], notes: Array.isArray(item.notes) ? item.notes : [], agent, queue };
}

function ensureAttendance(chatId, source = 'message') {
  if (!isUsableJid(chatId)) return null;
  let item = attendances.get(chatId);
  if (!item) {
    const createdAt = nowIso();
    item = {
      id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      chatId,
      status: 'waiting',
      queueId: 'geral',
      agentId: null,
      createdAt,
      updatedAt: createdAt,
      closedAt: null,
      priority: 'normal',
      tags: [],
      notes: [],
      lastCustomerAt: source === 'message' ? createdAt : null,
      lastAgentAt: null,
      firstResponseAt: null,
      queuedAt: createdAt,
      autoAssignAt: new Date(Date.now() + AUTO_ASSIGN_DELAY_MS).toISOString(),
      events: [{ type: 'created', at: createdAt, label: source === 'message' ? 'Atendimento criado por nova mensagem' : 'Atendimento criado' }]
    };
    attendances.set(chatId, item);
    scheduleAttendancePersist();
  }
  return item;
}

function addAttendanceEvent(item, type, label, meta = {}) {
  const at = nowIso();
  item.events = Array.isArray(item.events) ? item.events : [];
  item.events.push({ type, at, label, ...meta });
  item.updatedAt = at;
  if (item.events.length > 200) item.events = item.events.slice(-200);
  scheduleAttendancePersist();
  io.emit('attendance:update', publicAttendance(item));
  io.emit('wa:chats', serializeChats());
  emitSupervisorUpdate();
  return item;
}

function agentById(id) { return contactDb.getUser(id); }
function queueById(id) { return contactDb.getServiceQueue(id); }

function activeCountForAgent(agentId) { return [...attendances.values()].filter(a => a.agentId === agentId && !['closed'].includes(a.status)).length; }
function onlineAuthorizedUsers(queueId, roles) {
  refreshTeamDirectory();
  return agents.filter(a => a.active !== false && a.status === 'online' && isUserConnected(a.id) && roles.includes(a.role) && contactDb.userQueueIds(a.id).includes(queueId));
}
function underCapacity(list) {
  return list.filter(a => activeCountForAgent(a.id) < Number(a.maxActive || 5));
}
function pickLeastLoaded(list) {
  return [...list].sort((a,b) => activeCountForAgent(a.id)-activeCountForAgent(b.id) || a.name.localeCompare(b.name))[0] || null;
}
function markWaitingForAutoAssign(item, { resetTimer = false } = {}) {
  if (!item || item.status === 'closed' || item.agentId) return item;
  const now = Date.now();
  if (resetTimer || !item.queuedAt) item.queuedAt = new Date(now).toISOString();
  if (resetTimer || !item.autoAssignAt) item.autoAssignAt = new Date(now + AUTO_ASSIGN_DELAY_MS).toISOString();
  scheduleAttendancePersist();
  return item;
}
function autoAssignAttendance(item, reason='Distribuição automática', { force = false } = {}) {
  if (!item || item.agentId || item.status !== 'waiting' || item.status === 'closed') return item;
  const queue = queueById(item.queueId || 'geral');
  if (!queue || !Number(queue.auto_assign || 0)) return item;
  markWaitingForAutoAssign(item);
  const dueAt = item.autoAssignAt ? new Date(item.autoAssignAt).getTime() : 0;
  if (!force && dueAt > Date.now()) return item;

  const regularOnline = onlineAuthorizedUsers(queue.id, ['agent']);
  const regularAvailable = underCapacity(regularOnline);
  let target = pickLeastLoaded(regularAvailable);
  let escalated = false;

  // Se não houver atendente operacional disponível (inclusive por sobrecarga),
  // sobe para Supervisor/Admin online autorizado na fila.
  if (!target) {
    const leadersOnline = onlineAuthorizedUsers(queue.id, ['supervisor','admin']);
    target = pickLeastLoaded(underCapacity(leadersOnline));
    escalated = Boolean(target);
  }

  if (!target) return item;
  item.agentId = target.id;
  item.status = 'assigned';
  item.closedAt = null;
  item.autoAssignAt = null;
  addAttendanceEvent(item, escalated ? 'auto_escalated' : 'auto_assigned', `${reason}: ${target.name}${escalated ? ' (escalado para supervisão)' : ''}`, {agentId:target.id,queueId:queue.id,escalated});
  return item;
}
function supervisorSnapshot() {
  refreshTeamDirectory();
  const open=[...attendances.values()].filter(a=>a.status!=='closed');
  const waiting=open.filter(a=>a.status==='waiting');
  const now=Date.now();
  return {
    generatedAt: nowIso(),
    totals:{open:open.length,waiting:waiting.length,assigned:open.filter(a=>a.status==='assigned').length,waitingCustomer:open.filter(a=>a.status==='waiting_customer').length,waitingInternal:open.filter(a=>a.status==='waiting_internal').length},
    agents:agents.map(a=>({ ...effectiveAgent(a), queueIds:contactDb.userQueueIds(a.id), active:activeCountForAgent(a.id), capacity:Number(a.maxActive||5) })),
    queues:queues.map(q=>{const items=open.filter(a=>a.queueId===q.id);const sla=Number(q.sla_minutes||15);return {...q,open:items.length,waiting:items.filter(a=>a.status==='waiting').length,slaBreached:items.filter(a=>a.lastCustomerAt&&!a.firstResponseAt&&(now-new Date(a.lastCustomerAt).getTime())>sla*60000).length};})
  };
}

function emitState() { io.emit('wa:state', waState); }
function setState(patch) { waState = { ...waState, ...patch }; emitState(); }

function num(value) {
  if (value == null) return 0;
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value?.toNumber === 'function') return value.toNumber();
  if (typeof value?.low === 'number') return value.low;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function isUsableJid(jid = '') {
  if (!jid || jid === 'status@broadcast' || jid.endsWith('@broadcast') || jid.includes('@newsletter')) return false;
  return jid.includes('@s.whatsapp.net') || jid.includes('@g.us') || jid.includes('@lid');
}

function jidFallbackName(jid = '') {
  if (jid.endsWith('@g.us')) return 'Grupo do WhatsApp';
  const raw = jid.split('@')[0] || jid;
  return raw.replace(/\D/g, '') || raw || 'Contato';
}

function contactName(jid = '') {
  const c = contacts.get(jid);
  return c?.name || c?.notify || c?.verifiedName || c?.pushName || jidFallbackName(jid);
}

function unwrapMessageContent(message) {
  let m = message || {};
  for (let i = 0; i < 6; i += 1) {
    if (m?.ephemeralMessage?.message) m = m.ephemeralMessage.message;
    else if (m?.viewOnceMessage?.message) m = m.viewOnceMessage.message;
    else if (m?.viewOnceMessageV2?.message) m = m.viewOnceMessageV2.message;
    else if (m?.viewOnceMessageV2Extension?.message) m = m.viewOnceMessageV2Extension.message;
    else if (m?.documentWithCaptionMessage?.message) m = m.documentWithCaptionMessage.message;
    else break;
  }
  return m || {};
}

function extractText(message) {
  const m = unwrapMessageContent(message);
  if (typeof m.conversation === 'string') return m.conversation;
  if (typeof m.extendedTextMessage?.text === 'string') return m.extendedTextMessage.text;
  if (m.imageMessage) return m.imageMessage.caption || '📷 Imagem';
  if (m.videoMessage) return m.videoMessage.caption || '🎥 Vídeo';
  if (m.audioMessage) return '🎵 Áudio';
  if (m.documentMessage) return `📄 ${m.documentMessage.fileName || 'Documento'}`;
  if (m.stickerMessage) return '🖼️ Figurinha';
  if (m.contactMessage) return `👤 ${m.contactMessage.displayName || 'Contato'}`;
  if (m.contactsArrayMessage) return '👥 Contatos';
  if (m.locationMessage || m.liveLocationMessage) return '📍 Localização';
  if (m.pollCreationMessage || m.pollCreationMessageV2 || m.pollCreationMessageV3) return '📊 Enquete';
  if (m.reactionMessage?.text) return `Reação ${m.reactionMessage.text}`;
  return '';
}

function messageType(message) {
  return Object.keys(unwrapMessageContent(message) || {})[0] || 'unknown';
}

function normalizeMessage(msg) {
  const jid = msg?.key?.remoteJid || '';
  if (!isUsableJid(jid) || !msg?.key?.id || !msg?.message) return null;
  const timestamp = num(msg.messageTimestamp) || Math.floor(Date.now() / 1000);
  const body = extractText(msg.message);
  const type = messageType(msg.message);
  return { id: msg.key.id, chatId: jid, fromMe: !!msg.key.fromMe, body, timestamp, type, hasMedia: /image|video|audio|document|sticker/i.test(type) };
}

function ensureChat(jid, patch = {}) {
  if (!isUsableJid(jid)) return null;
  const old = chats.get(jid) || { id: jid, name: contactName(jid), unreadCount: 0, timestamp: 0, isGroup: jid.endsWith('@g.us'), lastMessage: '' };
  const next = { ...old, ...patch, id: jid, name: patch.name || old.name || contactName(jid), isGroup: jid.endsWith('@g.us') };
  chats.set(jid, next);
  return next;
}

function cacheMessage(normalized, { emit = true } = {}) {
  if (!normalized) return;
  const list = messagesByChat.get(normalized.chatId) || [];
  const isNew = !seenMessageIds.has(normalized.id);
  if (isNew) {
    seenMessageIds.add(normalized.id);
    list.push(normalized);
    list.sort((a, b) => a.timestamp - b.timestamp);
    if (list.length > 300) list.splice(0, list.length - 300);
    messagesByChat.set(normalized.chatId, list);
  }
  const previous = chats.get(normalized.chatId);
  ensureChat(normalized.chatId, {
    timestamp: Math.max(previous?.timestamp || 0, normalized.timestamp || 0),
    lastMessage: normalized.body || previous?.lastMessage || 'Mensagem',
    unreadCount: normalized.fromMe ? (previous?.unreadCount || 0) : isNew ? (previous?.unreadCount || 0) + 1 : (previous?.unreadCount || 0)
  });
  if (isNew) {
    const attendance = ensureAttendance(normalized.chatId, normalized.fromMe ? 'outgoing' : 'message');
    if (attendance) {
      const iso = new Date((normalized.timestamp || Math.floor(Date.now()/1000)) * 1000).toISOString();
      if (normalized.fromMe) {
        attendance.lastAgentAt = iso;
        if (!attendance.firstResponseAt && attendance.lastCustomerAt) {
          attendance.firstResponseAt = iso;
          addAttendanceEvent(attendance, 'first_response', 'Primeira resposta enviada ao cliente');
        } else {
          scheduleAttendancePersist();
        }
      } else {
        attendance.lastCustomerAt = iso;
        if (attendance.status === 'closed') {
          attendance.status = 'waiting';
          attendance.agentId = null;
          attendance.closedAt = null;
          attendance.queuedAt = iso;
          attendance.autoAssignAt = new Date(Date.now() + AUTO_ASSIGN_DELAY_MS).toISOString();
          addAttendanceEvent(attendance, 'reopened_auto', 'Atendimento reaberto por nova mensagem');
        } else {
          scheduleAttendancePersist();
        }
        markWaitingForAutoAssign(attendance, { resetTimer: attendance.status === 'waiting' && !attendance.agentId && !attendance.autoAssignAt });
      }
    }
  }
  if (emit && isNew) {
    io.emit('wa:message', normalized);
    io.emit('wa:chats', serializeChats());
  }
}

function serializeChats() {
  return [...chats.values()]
    .filter(c => isUsableJid(c.id))
    .map(c => { const crmContact = contactDb.toContactCore(contactDb.identifyChat(c.id), c.id); return { ...c, name: crmContact?.name || c.name || contactName(c.id), unreadCount: Number(c.unreadCount || 0), timestamp: num(c.timestamp), attendance: publicAttendance(attendances.get(c.id)), crmContact }; })
    .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
    .slice(0, 150);
}

function ingestContacts(items = []) {
  for (const c of items || []) {
    const id = c?.id || c?.jid;
    if (!id) continue;
    contacts.set(id, { ...(contacts.get(id) || {}), ...c });
    if (chats.has(id)) ensureChat(id, { name: contactName(id) });
  }
}

function ingestChats(items = []) {
  for (const c of items || []) {
    const id = c?.id;
    if (!isUsableJid(id)) continue;
    ensureChat(id, {
      name: c.name || contactName(id),
      unreadCount: Number(c.unreadCount || 0),
      timestamp: num(c.conversationTimestamp || c.lastMessageRecvTimestamp || c.timestamp)
    });
  }
}

function ingestMessages(items = [], emit = false) {
  for (const m of items || []) cacheMessage(normalizeMessage(m), { emit });
}

function disconnectStatusCode(error) {
  if (!error) return 0;
  try {
    const boom = error instanceof Boom ? error : new Boom(error);
    return Number(boom?.output?.statusCode || 0);
  } catch { return 0; }
}

function stringifyError(error) {
  if (!error) return 'Erro desconhecido';
  const parts = [];
  if (error.message) parts.push(error.message);
  if (error.data) { try { parts.push(JSON.stringify(error.data)); } catch {} }
  if (error.output) { try { parts.push(JSON.stringify(error.output)); } catch {} }
  return parts.join(' | ') || String(error);
}

async function fetchLiveWaVersion() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch('https://web.whatsapp.com/sw.js', {
      signal: controller.signal,
      headers: {
        'sec-fetch-site': 'none',
        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
      }
    });
    if (!response.ok) throw new Error(`WhatsApp Web respondeu HTTP ${response.status}`);
    const text = await response.text();
    const match = text.match(/\\?"client_revision\\?"\s*:\s*(\d+)/);
    if (!match?.[1]) throw new Error('client_revision não encontrado em sw.js');
    return { version: [2, 3000, Number(match[1])], source: 'web.whatsapp.com/sw.js' };
  } finally {
    clearTimeout(timeout);
  }
}

async function resolveWaVersion() {
  try {
    const live = await fetchLiveWaVersion();
    console.log(`WA Web version (ao vivo): ${live.version.join('.')} [${live.source}]`);
    return live;
  } catch (error) {
    console.warn(`Não consegui ler versão ao vivo: ${error?.message || error}`);
  }
  try {
    const result = await fetchLatestBaileysVersion();
    if (Array.isArray(result?.version) && result.version.length === 3) {
      console.log(`WA Web version (fallback Baileys): ${result.version.join('.')}`);
      return { version: result.version, source: 'fetchLatestBaileysVersion' };
    }
  } catch (error) {
    console.warn(`Fallback Baileys falhou: ${error?.message || error}`);
  }
  const fallback = [2, 3000, 1042626022];
  console.warn(`Usando versão de último recurso: ${fallback.join('.')}`);
  return { version: fallback, source: 'hardcoded-fallback' };
}

function clearReconnectTimer() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
}

function clearQrWatchdog() {
  if (qrWatchdogTimer) clearTimeout(qrWatchdogTimer);
  qrWatchdogTimer = null;
}

async function resetSessionAndGenerateQr(reason = 'Sessão inválida', delay = 800) {
  if (autoQrResetInProgress) {
    console.log('Novo pareamento já está em andamento.');
    return;
  }

  autoQrResetInProgress = true;
  clearReconnectTimer();
  clearQrWatchdog();
  reconnectAttempts = 0;

  // Invalida listeners do socket anterior antes de encerrá-lo.
  generation += 1;

  const oldSock = sock;
  sock = null;
  try { oldSock?.end?.(new Error('reset for new QR')); } catch {}

  setState({
    status: 'pairing',
    qr: null,
    profile: null,
    lastError: `${reason}. Gerando um novo QR Code automaticamente…`
  });

  try {
    await fs.rm(AUTH_DIR, { recursive: true, force: true });
    console.log('🧹 Sessão antiga removida.');
  } catch (error) {
    console.error('Falha ao remover a sessão antiga:', error?.message || error);
  }

  setTimeout(() => {
    autoQrResetInProgress = false;
    startWhatsApp().catch(handleFatalStartError);
  }, delay);
}

function scheduleReconnect() {
  clearReconnectTimer();
  reconnectAttempts += 1;
  const delay = Math.min(3000 * reconnectAttempts, 15000);
  console.log(`Nova tentativa em ${Math.round(delay / 1000)}s...`);
  reconnectTimer = setTimeout(() => startWhatsApp().catch(handleFatalStartError), delay);
}

function handleFatalStartError(error) {
  const errorText = stringifyError(error);
  console.error('Erro ao iniciar WhatsApp:', errorText);
  setState({ status: 'error', qr: null, profile: null, lastError: errorText });
}

async function startWhatsApp() {
  const myGeneration = ++generation;
  manualLogout = false;
  clearReconnectTimer();
  setState({ status: 'starting', qr: null, lastError: null });

  console.log('Carregando sessão Baileys...');
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const needsFreshPairing = !state?.creds?.registered;
  if (needsFreshPairing) {
    setState({ status: 'pairing', qr: null, profile: null, lastError: 'Preparando novo QR Code…' });
    console.log('Sessão não registrada: aguardando emissão de novo QR Code...');
  }
  const resolved = await resolveWaVersion();
  currentWaVersion = resolved;
  setState({ version: { value: resolved.version, source: resolved.source } });
  console.log('Criando conexão WhatsApp...');

  const localSock = makeWASocket({
    auth: state,
    logger,
    version: resolved.version,
    browser: ['Chrome', 'Chrome', '131.0.0'],
    markOnlineOnConnect: false,
    syncFullHistory: true,
    generateHighQualityLinkPreview: false,
    connectTimeoutMs: 60000,
    keepAliveIntervalMs: 25000,
    retryRequestDelayMs: 250,
    getMessage: async key => {
      const list = messagesByChat.get(key.remoteJid || '') || [];
      const found = list.find(m => m.id === key.id);
      return found ? { conversation: found.body || '' } : undefined;
    }
  });

  sock = localSock;
  localSock.ev.on('creds.update', saveCreds);

  clearQrWatchdog();
  if (needsFreshPairing) {
    const watchdogGeneration = myGeneration;
    qrWatchdogTimer = setTimeout(() => {
      if (watchdogGeneration !== generation) return;
      if (waState.status === 'qr' || waState.status === 'ready') return;

      freshPairingAttempts += 1;
      console.warn(`QR não foi emitido em tempo hábil (tentativa ${freshPairingAttempts}). Reiniciando pareamento...`);

      if (freshPairingAttempts <= 2) {
        resetSessionAndGenerateQr('O WhatsApp não emitiu o QR Code', 1200).catch(handleFatalStartError);
      } else {
        setState({
          status: 'error',
          qr: null,
          profile: null,
          lastError: 'Não foi possível gerar o QR Code após 3 tentativas. Use “Conectar” para tentar novamente.'
        });
      }
    }, 18000);
  }

  localSock.ev.on('connection.update', async update => {
    if (myGeneration !== generation) return;
    const { connection, lastDisconnect, qr } = update;
    console.log('connection.update:', { connection: connection || null, hasQR: !!qr, hasLastDisconnect: !!lastDisconnect });

    if (qr) {
      clearQrWatchdog();
      freshPairingAttempts = 0;
      try {
        const dataUrl = await QRCode.toDataURL(qr, { width: 420, margin: 2, errorCorrectionLevel: 'M' });
        setState({ status: 'qr', qr: dataUrl, profile: null, lastError: null });
        console.log('✅ QR CODE GERADO — abra http://localhost:3000');
      } catch (error) {
        setState({ status: 'error', qr: null, lastError: `Falha ao gerar QR: ${error?.message || error}` });
      }
    }

    if (connection === 'connecting' && waState.status !== 'qr') {
      setState({ status: 'starting', qr: null, lastError: null });
    }

    if (connection === 'open') {
      clearQrWatchdog();
      reconnectAttempts = 0;
      freshPairingAttempts = 0;
      const user = localSock.user || {};
      setState({
        status: 'ready', qr: null,
        profile: { pushname: user.name || user.verifiedName || 'WhatsApp conectado', wid: user.id || '' },
        lastError: null
      });
      console.log(`✅ WHATSAPP CONECTADO${user.name ? `: ${user.name}` : ''}`);
      io.emit('wa:chats', serializeChats());
    }

    if (connection === 'close') {
      const error = lastDisconnect?.error;
      const code = disconnectStatusCode(error);
      const errorText = stringifyError(error);
      const serverLoggedOut = code === DisconnectReason.loggedOut;
      console.error(`❌ WHATSAPP DESCONECTADO — código ${code || 'desconhecido'} — ${errorText}`);

      clearQrWatchdog();

      // Logout solicitado pelo usuário é intencional: não gerar QR sozinho.
      if (manualLogout) {
        setState({ status: 'disconnected', qr: null, profile: null, lastError: null });
        return;
      }

      // 401/403/LoggedOut = sessão deixou de ser válida no WhatsApp.
      // v0.8.1: apaga as credenciais imediatamente e inicia novo pareamento.
      if (serverLoggedOut || code === 401 || code === 403) {
        console.warn('🔄 Sessão inválida/desconectada. Novo QR será gerado automaticamente.');
        await resetSessionAndGenerateQr(`Sessão WhatsApp encerrada (código ${code || 'logout'})`);
        return;
      }

      // 405 normalmente é cliente/protocolo rejeitado. Não criar loop agressivo.
      if (code === 405) {
        setState({
          status: 'error', qr: null, profile: null,
          lastError: `WhatsApp rejeitou a versão do cliente (405). Versão usada: ${resolved.version.join('.')} (${resolved.source}). Clique em Conectar para tentar novamente.`
        });
        return;
      }

      // 428 em nova sessão também costuma ser rejeição antes do pareamento; limitar tentativas.
      if (reconnectAttempts >= 4) {
        setState({ status: 'error', qr: null, profile: null, lastError: `Falha após ${reconnectAttempts} tentativas. Código ${code || 'desconhecido'}: ${errorText}` });
        return;
      }

      setState({ status: 'starting', qr: null, profile: null, lastError: `Reconectando… código ${code || 'desconhecido'}` });
      scheduleReconnect();
    }
  });

  localSock.ev.on('messaging-history.set', ({ chats: historyChats = [], contacts: historyContacts = [], messages = [] }) => {
    if (myGeneration !== generation) return;
    ingestContacts(historyContacts);
    ingestChats(historyChats);
    ingestMessages(messages, false);
    io.emit('wa:chats', serializeChats());
    console.log(`Histórico sincronizado: ${historyChats.length} chats / ${messages.length} mensagens.`);
  });

  localSock.ev.on('contacts.upsert', items => { if (myGeneration === generation) { ingestContacts(items); io.emit('wa:chats', serializeChats()); } });
  localSock.ev.on('contacts.update', items => { if (myGeneration === generation) { ingestContacts(items); io.emit('wa:chats', serializeChats()); } });
  localSock.ev.on('chats.upsert', items => { if (myGeneration === generation) { ingestChats(items); io.emit('wa:chats', serializeChats()); } });
  localSock.ev.on('chats.update', items => { if (myGeneration === generation) { ingestChats(items); io.emit('wa:chats', serializeChats()); } });
  localSock.ev.on('messages.upsert', ({ messages = [], type }) => {
    if (myGeneration !== generation) return;
    console.log(`messages.upsert: ${messages.length} mensagem(ns), tipo=${type}`);
    ingestMessages(messages, true);
  });
}

app.post('/api/auth/login', (req, res) => {
  const email = String(req.body?.email || '').trim();
  const password = String(req.body?.password || '');
  const session = contactDb.createSession(email, password);
  if (!session) return res.status(401).json({ error: 'E-mail ou senha inválidos.' });
  refreshTeamDirectory({ emit: true });
  res.setHeader('Set-Cookie', cookieFor(session.token, 86400));
  res.json({ ok: true, user: session.user, expiresAt: session.expiresAt });
});
app.post('/api/auth/logout', (req, res) => {
  const token = parseCookies(req)[SESSION_COOKIE] || '';
  contactDb.destroySession(token);
  refreshTeamDirectory({ emit: true });
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  res.json({ ok: true });
});
app.get('/api/me', (req, res) => {
  const session = requestSession(req);
  if (!session?.user) return res.status(401).json({ error: 'Não autenticado.' });
  res.json({ user: session.user });
});

// Tudo abaixo exige login no ConnectTalk. O WhatsApp continua sendo uma conexão compartilhada da empresa.
app.use('/api', (req,res,next) => {
  if (req.path === '/app-info') return next();
  requireAuth(req,res,next);
});

app.get('/api/app-info', (req, res) => res.json({ name: APP_NAME, version: APP_VERSION, engine: 'Baileys 6.7.23' }));
app.get('/api/status', (req, res) => res.json(waState));
app.get('/api/debug', (req, res) => res.json({ ...waState, generation, reconnectAttempts, hasSocket: !!sock, contacts: contacts.size, chats: chats.size, cachedMessages: seenMessageIds.size, waVersion: currentWaVersion }));

app.get('/api/chats', (req, res) => {
  if (waState.status !== 'ready') return res.status(409).json({ error: 'WhatsApp ainda não está conectado.' });
  res.json(serializeChats());
});

app.get('/api/messages/:chatId', (req, res) => {
  if (waState.status !== 'ready') return res.status(409).json({ error: 'WhatsApp ainda não está conectado.' });
  const chatId = req.params.chatId;
  const data = [...(messagesByChat.get(chatId) || [])].sort((a, b) => a.timestamp - b.timestamp).slice(-150);
  const c = chats.get(chatId);
  if (c) { c.unreadCount = 0; chats.set(chatId, c); }
  res.json(data);
});

app.post('/api/send', async (req, res) => {
  if (waState.status !== 'ready' || !sock) return res.status(409).json({ error: 'WhatsApp ainda não está conectado.' });
  const chatId = String(req.body?.chatId || '');
  const message = String(req.body?.message || '').trim();
  const agentId = req.user.id;
  if (!isUsableJid(chatId) || !message) return res.status(400).json({ error: 'Conversa e mensagem são obrigatórias.' });
  const agent = agentById(agentId);
  if (!agent) return res.status(400).json({ error: 'Atendente inválido.' });
  if (!isUserConnected(agent.id) || agent.status === 'offline') return res.status(409).json({ error: 'Você está offline. Fique online para responder.' });
  const attendance = ensureAttendance(chatId, 'outgoing');
  if (attendance && attendance.status !== 'assigned') {
    attendance.status = 'assigned';
    attendance.agentId = agent.id;
    attendance.closedAt = null;
    addAttendanceEvent(attendance, 'claimed_auto', `${agent.name} assumiu automaticamente ao responder`, { agentId: agent.id });
  }
  try {
    const sent = await sock.sendMessage(chatId, { text: message });
    const normalized = normalizeMessage(sent);
    cacheMessage(normalized, { emit: true });
    res.json({ ok: true, id: sent?.key?.id || null, timestamp: normalized?.timestamp || Math.floor(Date.now() / 1000) });
    console.log(`✅ Mensagem enviada para ${chatId}`);
  } catch (error) {
    const errorText = stringifyError(error);
    console.error('Falha ao enviar mensagem:', errorText);
    res.status(500).json({ error: errorText });
  }
});


function responseMinutes(item) {
  if (!item?.lastCustomerAt) return null;
  const end = item.firstResponseAt || item.lastAgentAt;
  if (!end) return null;
  return Math.max(0, Math.round((new Date(end) - new Date(item.lastCustomerAt)) / 60000));
}

function dashboardStats() {
  const list = [...attendances.values()];
  const today = new Date().toISOString().slice(0, 10);
  const open = list.filter(a => a.status !== 'closed').length;
  const waiting = list.filter(a => a.status === 'waiting').length;
  const closedToday = list.filter(a => a.closedAt && String(a.closedAt).startsWith(today)).length;
  const answeredToday = list.filter(a => a.lastAgentAt && String(a.lastAgentAt).startsWith(today)).length;
  const samples = list.map(responseMinutes).filter(v => Number.isFinite(v));
  const avgFirstResponseMinutes = samples.length ? Math.round(samples.reduce((a,b)=>a+b,0)/samples.length) : null;
  return { open, waiting, closedToday, answeredToday, avgFirstResponseMinutes, total: list.length };
}


// CRM foundation: pessoas, condomínios e unidades
app.get('/api/contacts', (req, res) => res.json(contactDb.listPeople().map(p => contactDb.toContactCore(p, p.jid || ''))));
app.get('/api/contacts/:id', (req, res) => {
  const person = contactDb.getPerson(Number(req.params.id));
  if (!person) return res.status(404).json({ error: 'Contato não encontrado.' });
  res.json(contactDb.toContactCore(person, person.jid || ''));
});
app.post('/api/contacts', (req, res) => {
  try { const saved = contactDb.savePerson(req.body || {}); io.emit('wa:chats', serializeChats()); res.json(contactDb.toContactCore(saved, req.body?.chatId || saved.jid || '')); }
  catch (error) { res.status(400).json({ error: error?.message || String(error) }); }
});
app.put('/api/contacts/:id', (req, res) => {
  try { const saved = contactDb.savePerson({ ...(req.body || {}), id: Number(req.params.id) }); io.emit('wa:chats', serializeChats()); res.json(contactDb.toContactCore(saved, req.body?.chatId || saved.jid || '')); }
  catch (error) { res.status(400).json({ error: error?.message || String(error) }); }
});
app.get('/api/condominiums', (req, res) => res.json(contactDb.listCondominiums()));
app.post('/api/condominiums', (req, res) => { try { res.status(201).json(contactDb.createCondominium(req.body || {})); } catch (error) { res.status(400).json({ error: error?.message || String(error) }); } });
app.get('/api/units', (req, res) => res.json(contactDb.listUnits(req.query.condominiumId ? Number(req.query.condominiumId) : null)));
app.post('/api/units', (req, res) => { try { res.status(201).json(contactDb.createUnit(req.body || {})); } catch (error) { res.status(400).json({ error: error?.message || String(error) }); } });
app.get('/api/contact-by-chat/:chatId', (req, res) => {
  const person = contactDb.identifyChat(req.params.chatId);
  res.json(contactDb.toContactCore(person, req.params.chatId));
});

// v0.9.3 — Contact Core: uma única representação canônica do contato.
// Diretório, modal e painel lateral devem consumir a mesma estrutura.
app.get('/api/contact-core/:chatId', (req, res) => {
  const chatId = req.params.chatId;
  const person = contactDb.identifyChat(chatId);
  res.json(contactDb.toContactCore(person, chatId));
});
app.get('/api/contact-core-person/:id', (req, res) => {
  const person = contactDb.getPerson(Number(req.params.id));
  if (!person) return res.status(404).json({ error: 'Contato não encontrado.' });
  res.json(contactDb.toContactCore(person, person.jid || ''));
});
app.get('/api/contact-debug/:chatId', (req, res) => res.json(contactDb.debugPersonByJid(req.params.chatId)));
app.get('/api/integrity/:chatId', (req, res) => {
  const chatId=req.params.chatId;
  res.json({ chatId, contact: contactDb.identifyChat(chatId), attendance: publicAttendance(attendances.get(chatId) || null), chat: chats.get(chatId) || null });
});

app.get('/api/agents', (req, res) => { refreshTeamDirectory(); res.json(agents.map(effectiveAgent)); });
app.get('/api/queues', (req, res) => { refreshTeamDirectory(); res.json(queues); });
app.get('/api/dashboard', (req, res) => res.json(dashboardStats()));

app.patch('/api/agents/:id/status', (req, res) => {
  const targetId = String(req.params.id);
  if (targetId !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'Você só pode alterar seu próprio status.' });
  try {
    let agent = contactDb.setUserStatus(targetId, String(req.body?.status || ''));
    if (!isUserConnected(targetId)) agent = contactDb.setUserConnected(targetId, false);
    refreshTeamDirectory({ emit: true });
    res.json(effectiveAgent(agent));
  } catch (error) { res.status(400).json({ error: error?.message || String(error) }); }
});

app.get('/api/admin/users', requireAdmin, (req,res) => { refreshTeamDirectory(); res.json(agents.map(a=>({...effectiveAgent(a),queueIds:contactDb.userQueueIds(a.id)}))); });
app.post('/api/admin/users', requireAdmin, (req,res) => {
  try { const user=contactDb.createUser(req.body||{}); refreshTeamDirectory({ emit:true }); res.status(201).json(user); }
  catch(error){ res.status(400).json({error:error?.message||String(error)}); }
});
app.patch('/api/admin/users/:id/role', requireAdmin, (req,res) => {
  try { const user=contactDb.setUserRole(req.params.id,String(req.body?.role||'')); refreshTeamDirectory({ emit:true }); res.json(user); }
  catch(error){ res.status(400).json({error:error?.message||String(error)}); }
});
app.delete('/api/admin/users/:id', requireAdmin, (req,res) => {
  if (req.params.id === req.user.id) return res.status(400).json({error:'Não é possível desativar o próprio usuário.'});
  try { contactDb.deactivateUser(req.params.id); refreshTeamDirectory({ emit:true }); res.json({ok:true}); }
  catch(error){ res.status(400).json({error:error?.message||String(error)}); }
});
app.get('/api/admin/queues', requireAdmin, (req,res) => { refreshTeamDirectory(); res.json(queues); });
app.post('/api/admin/queues', requireAdmin, (req,res) => {
  try { const queue=contactDb.createServiceQueue(req.body||{}); refreshTeamDirectory({ emit:true }); res.status(201).json(queue); }
  catch(error){ res.status(400).json({error:error?.message||String(error)}); }
});


app.get('/api/departments', (req,res) => res.json(contactDb.listDepartments()));
app.get('/api/me/queues', (req,res) => res.json(contactDb.userQueueIds(req.user.id)));
app.get('/api/supervisor', (req,res) => {
  if (!['supervisor','admin'].includes(req.user.role)) return res.status(403).json({error:'Acesso restrito à supervisão.'});
  res.json(supervisorSnapshot());
});
app.patch('/api/admin/users/:id/capacity', requireAdmin, (req,res) => { try { const user=contactDb.setUserCapacity(req.params.id,req.body?.maxActive); refreshTeamDirectory({emit:true}); res.json(user); } catch(e){res.status(400).json({error:e.message});} });
app.put('/api/admin/users/:id/queues', requireAdmin, (req,res) => { try { const queueIds=contactDb.setUserQueues(req.params.id,Array.isArray(req.body?.queueIds)?req.body.queueIds:[]); refreshTeamDirectory({emit:true}); res.json({ok:true,queueIds}); } catch(e){res.status(400).json({error:e.message});} });
app.patch('/api/admin/queues/:id/operations', requireAdmin, (req,res) => { try { const q=contactDb.updateQueueOps(req.params.id,req.body||{}); refreshTeamDirectory({emit:true}); res.json(q); } catch(e){res.status(400).json({error:e.message});} });
app.post('/api/attendance/:chatId/state', (req,res) => {
  const item=ensureAttendance(req.params.chatId,'manual'); if(!item)return res.status(400).json({error:'Conversa inválida.'});
  const state=String(req.body?.status||''); const allowed=['waiting','assigned','waiting_customer','waiting_internal'];
  if(!allowed.includes(state))return res.status(400).json({error:'Estado inválido.'});
  item.status=state; if(state==='waiting'){item.agentId=null;markWaitingForAutoAssign(item,{resetTimer:true});}
  addAttendanceEvent(item,'state_changed',`${req.user.name} alterou o estado para ${state}`,{userId:req.user.id,status:state}); res.json(publicAttendance(item));
});
app.post('/api/attendance/:chatId/auto-assign', (req,res) => {
  if (!['supervisor','admin'].includes(req.user.role)) return res.status(403).json({error:'Acesso restrito à supervisão.'});
  const item=ensureAttendance(req.params.chatId,'manual'); if(!item)return res.status(400).json({error:'Conversa inválida.'});
  item.agentId=null; item.status='waiting'; markWaitingForAutoAssign(item,{resetTimer:true}); const q=queueById(item.queueId); if(q && !Number(q.auto_assign||0)){ const candidates=underCapacity(onlineAuthorizedUsers(item.queueId,['agent','supervisor','admin'])); const a=pickLeastLoaded(candidates); if(a){item.agentId=a.id;item.status='assigned';item.autoAssignAt=null;addAttendanceEvent(item,'auto_assigned',`Supervisor distribuiu para ${a.name}`,{agentId:a.id});} } else autoAssignAttendance(item,'Supervisor redistribuiu',{force:true});
  res.json(publicAttendance(item));
});

app.get('/api/attendances', (req, res) => {
  const status = String(req.query.status || '').trim();
  const agentId = String(req.query.agentId || '').trim();
  const queueId = String(req.query.queueId || '').trim();
  let list = [...attendances.values()];
  if (status) list = list.filter(a => a.status === status);
  if (agentId) list = list.filter(a => a.agentId === agentId);
  if (queueId) list = list.filter(a => a.queueId === queueId);
  list.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  res.json(list.map(publicAttendance));
});

app.get('/api/attendance/:chatId', (req, res) => {
  const chatId = req.params.chatId;
  const item = attendances.get(chatId) || ensureAttendance(chatId, 'manual');
  if (!item) return res.status(404).json({ error: 'Atendimento não encontrado.' });
  res.json(publicAttendance(item));
});

// v0.9.1: snapshot completo do workspace. Usado após ações como transferência
// para reidratar atendimento + contato sem reconstruir a tela com dados parciais.
app.get('/api/workspace/:chatId', (req, res) => {
  const chatId = req.params.chatId;
  if (!isUsableJid(chatId)) return res.status(400).json({ error: 'Conversa inválida.' });
  const item = attendances.get(chatId) || ensureAttendance(chatId, 'manual');
  const chat = chats.get(chatId) || null;
  const crmContact = contactDb.toContactCore(contactDb.identifyChat(chatId), chatId);
  res.json({
    chat: chat ? { ...chat, name: crmContact?.name || chat.name || contactName(chatId) } : { id: chatId, name: crmContact?.name || contactName(chatId) },
    attendance: publicAttendance(item),
    crmContact
  });
});

app.post('/api/attendance/:chatId/claim', (req, res) => {
  const chatId = req.params.chatId;
  const agentId = req.user.id;
  const agent = agentById(agentId);
  if (!agent) return res.status(400).json({ error: 'Atendente inválido.' });
  if (!isUserConnected(agent.id) || agent.status === 'offline') return res.status(409).json({ error: 'Você está offline. Fique online para assumir atendimentos.' });
  const item = ensureAttendance(chatId, 'manual');
  if (!item) return res.status(400).json({ error: 'Conversa inválida.' });
  if (!contactDb.userQueueIds(agent.id).includes(item.queueId) && agent.role === 'agent') return res.status(403).json({ error: 'Você não tem acesso a esta fila.' });
  if (activeCountForAgent(agent.id) >= Number(agent.maxActive || 5) && item.agentId !== agent.id) return res.status(409).json({ error: `Limite de ${agent.maxActive || 5} atendimentos simultâneos atingido.` });
  item.status = 'assigned';
  item.agentId = agent.id;
  item.closedAt = null;
  addAttendanceEvent(item, 'claimed', `${agent.name} assumiu o atendimento`, { agentId: agent.id });
  res.json(publicAttendance(item));
});

app.post('/api/attendance/:chatId/transfer', (req, res) => {
  const chatId = req.params.chatId;
  const item = ensureAttendance(chatId, 'manual');
  if (!item) return res.status(400).json({ error: 'Conversa inválida.' });

  const nextAgentId = req.body?.agentId ? String(req.body.agentId) : null;
  const nextQueueId = req.body?.queueId ? String(req.body.queueId) : item.queueId;
  const nextAgent = nextAgentId ? agentById(nextAgentId) : null;
  const nextQueue = queueById(nextQueueId);
  if (nextAgentId && !nextAgent) return res.status(400).json({ error: 'Atendente inválido.' });
  if (!nextQueue) return res.status(400).json({ error: 'Fila inválida.' });
  if (nextAgent && (!isUserConnected(nextAgent.id) || nextAgent.status !== 'online')) {
    return res.status(409).json({ error: `${nextAgent.name} está offline ou indisponível. Transfira para a fila ou escolha um atendente online.` });
  }
  if (nextAgent && !contactDb.userQueueIds(nextAgent.id).includes(nextQueue.id) && nextAgent.role === 'agent') return res.status(400).json({ error: 'O atendente não possui permissão para esta fila.' });
  if (nextAgent && nextAgent.id !== item.agentId && activeCountForAgent(nextAgent.id) >= Number(nextAgent.maxActive || 5)) return res.status(409).json({ error: `${nextAgent.name} atingiu o limite de atendimentos simultâneos.` });

  const oldAgentId = item.agentId || null;
  const oldQueueId = item.queueId || 'geral';
  const oldAgent = agentById(oldAgentId);
  const oldQueue = queueById(oldQueueId);
  const contactBefore = contactDb.identifyChat(chatId);
  const immutableBefore = JSON.stringify({
    priority: item.priority || 'normal',
    tags: Array.isArray(item.tags) ? item.tags : [],
    notes: Array.isArray(item.notes) ? item.notes : [],
    createdAt: item.createdAt,
    lastCustomerAt: item.lastCustomerAt,
    lastAgentAt: item.lastAgentAt,
    firstResponseAt: item.firstResponseAt
  });

  // REGRA DE INTEGRIDADE v0.9.3:
  // transferência altera SOMENTE roteamento/status. Tags, notas, prioridade,
  // SLA, eventos anteriores, contato, conversa e mensagens permanecem intactos.
  item.agentId = nextAgent?.id || null;
  item.queueId = nextQueue.id;
  item.status = nextAgent ? 'assigned' : 'waiting';
  item.closedAt = null;
  if (nextAgent) { item.autoAssignAt = null; } else { markWaitingForAutoAssign(item, { resetTimer: true }); }

  addAttendanceEvent(
    item,
    'transferred',
    `Transferido de ${oldAgent?.name || oldQueue?.name || 'fila'} para ${nextAgent?.name || nextQueue.name}`,
    {
      fromAgentId: oldAgentId,
      fromQueueId: oldQueueId,
      toAgentId: item.agentId,
      toQueueId: item.queueId
    }
  );

  // Reidentifica o contato sem modificar seu cadastro e devolve um snapshot
  // completo para o frontend validar que nada foi perdido.
  const immutableAfter = JSON.stringify({
    priority: item.priority || 'normal',
    tags: Array.isArray(item.tags) ? item.tags : [],
    notes: Array.isArray(item.notes) ? item.notes : [],
    createdAt: item.createdAt,
    lastCustomerAt: item.lastCustomerAt,
    lastAgentAt: item.lastAgentAt,
    firstResponseAt: item.firstResponseAt
  });
  if (immutableBefore !== immutableAfter) {
    console.error('INTEGRITY ERROR: transferência alterou campos imutáveis', { chatId });
    return res.status(500).json({ error: 'Falha de integridade na transferência. Nenhum dado foi confirmado.' });
  }
  if (contactBefore?.id) contactDb.linkChatToPerson(chatId, contactBefore.id);
  const chat = chats.get(chatId) || null;
  const crmContact = contactDb.toContactCore(contactDb.identifyChat(chatId) || contactBefore || null, chatId);
  res.json({
    ok: true,
    attendance: publicAttendance(item),
    crmContact,
    chat: chat ? { ...chat, name: crmContact?.name || chat.name || contactName(chatId) } : { id: chatId, name: crmContact?.name || contactName(chatId) }
  });
});

app.post('/api/attendance/:chatId/priority', (req, res) => {
  const item = ensureAttendance(req.params.chatId, 'manual');
  if (!item) return res.status(400).json({ error: 'Conversa inválida.' });
  const priority = String(req.body?.priority || 'normal');
  if (!['low', 'normal', 'high', 'urgent'].includes(priority)) return res.status(400).json({ error: 'Prioridade inválida.' });
  item.priority = priority;
  addAttendanceEvent(item, 'priority', `Prioridade alterada para ${priority}`, { priority });
  res.json(publicAttendance(item));
});

app.post('/api/attendance/:chatId/tags', (req, res) => {
  const item = ensureAttendance(req.params.chatId, 'manual');
  if (!item) return res.status(400).json({ error: 'Conversa inválida.' });
  const tags = Array.isArray(req.body?.tags) ? req.body.tags : [];
  item.tags = [...new Set(tags.map(t => String(t).trim()).filter(Boolean))].slice(0, 12);
  addAttendanceEvent(item, 'tags', item.tags.length ? `Etiquetas atualizadas: ${item.tags.join(', ')}` : 'Etiquetas removidas', { tags: item.tags });
  res.json(publicAttendance(item));
});

app.post('/api/attendance/:chatId/note', (req, res) => {
  const item = ensureAttendance(req.params.chatId, 'manual');
  if (!item) return res.status(400).json({ error: 'Conversa inválida.' });
  const text = String(req.body?.text || '').trim();
  const agent = agentById(req.user.id);
  if (!text) return res.status(400).json({ error: 'Digite uma nota interna.' });
  if (!agent) return res.status(400).json({ error: 'Atendente inválido.' });
  item.notes = Array.isArray(item.notes) ? item.notes : [];
  const note = { id: `note-${Date.now()}-${Math.random().toString(36).slice(2,7)}`, text, agentId: agent.id, agentName: agent.name, at: nowIso() };
  item.notes.push(note);
  if (item.notes.length > 100) item.notes = item.notes.slice(-100);
  addAttendanceEvent(item, 'note', `${agent.name} adicionou uma nota interna`, { noteId: note.id, agentId: agent.id });
  res.json(publicAttendance(item));
});

app.post('/api/attendance/:chatId/close', (req, res) => {
  const chatId = req.params.chatId;
  const item = attendances.get(chatId) || ensureAttendance(chatId, 'manual');
  if (!item) return res.status(400).json({ error: 'Conversa inválida.' });
  item.status = 'closed';
  item.closedAt = nowIso();
  addAttendanceEvent(item, 'closed', `Atendimento finalizado por ${req.user.name}`, { agentId: req.user.id });
  res.json(publicAttendance(item));
});

app.post('/api/attendance/:chatId/reopen', (req, res) => {
  const chatId = req.params.chatId;
  const item = attendances.get(chatId) || ensureAttendance(chatId, 'manual');
  if (!item) return res.status(400).json({ error: 'Conversa inválida.' });
  item.status = item.agentId ? 'assigned' : 'waiting';
  item.closedAt = null;
  addAttendanceEvent(item, 'reopened', `Atendimento reaberto por ${req.user.name}`, { agentId: req.user.id });
  res.json(publicAttendance(item));
});

app.post('/api/logout', async (req, res) => {
  manualLogout = true;
  generation += 1;
  reconnectAttempts = 0;
  clearReconnectTimer();
  clearQrWatchdog();
  try {
    if (sock) {
      try { await sock.logout(); } catch {}
      try { sock.end?.(new Error('logout')); } catch {}
    }
    sock = null;
    await fs.rm(AUTH_DIR, { recursive: true, force: true });
    contacts.clear(); chats.clear(); messagesByChat.clear(); seenMessageIds.clear();
    setState({ status: 'disconnected', qr: null, profile: null, lastError: null });
    res.json({ ok: true });
  } catch (error) { res.status(500).json({ error: stringifyError(error) }); }
});

app.post('/api/reset-session', async (req, res) => {
  try {
    contacts.clear(); chats.clear(); messagesByChat.clear(); seenMessageIds.clear();
    freshPairingAttempts = 0;
    await resetSessionAndGenerateQr('Sessão reiniciada manualmente', 300);
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: stringifyError(error) });
  }
});

app.post('/api/reconnect', async (req, res) => {
  try {
    generation += 1;
    reconnectAttempts = 0;
    clearReconnectTimer();
    try { sock?.end?.(new Error('manual reconnect')); } catch {}
    sock = null;
    setTimeout(() => startWhatsApp().catch(handleFatalStartError), 250);
    res.json({ ok: true });
  } catch (error) { res.status(500).json({ error: stringifyError(error) }); }
});

io.on('connection', socketClient => {
  socketClient.emit('wa:state', waState);

  const session = requestSession(socketClient.request);
  const user = session?.user || null;
  if (!user) return;

  const timer = userDisconnectTimers.get(user.id);
  if (timer) { clearTimeout(timer); userDisconnectTimers.delete(user.id); }
  if (!userSockets.has(user.id)) userSockets.set(user.id, new Set());
  userSockets.get(user.id).add(socketClient.id);
  userLastSeenAt.set(user.id, nowIso());
  contactDb.setUserConnected(user.id, true);
  refreshTeamDirectory({ emit: true });

  socketClient.emit('agents:update', agents.map(effectiveAgent));
  socketClient.emit('queues:update', queues);
  if (['supervisor','admin'].includes(user.role)) socketClient.emit('supervisor:update', supervisorSnapshot());
  if (waState.status === 'ready') socketClient.emit('wa:chats', serializeChats());

  socketClient.on('presence:heartbeat', () => {
    userLastSeenAt.set(user.id, nowIso());
  });

  socketClient.on('disconnect', () => {
    const set = userSockets.get(user.id);
    set?.delete(socketClient.id);
    if (set && !set.size) userSockets.delete(user.id);
    userLastSeenAt.set(user.id, nowIso());
    if (connectedSocketCount(user.id) > 0) return;
    const t=setTimeout(() => {
      if (connectedSocketCount(user.id) > 0) return;
      contactDb.setUserConnected(user.id, false);
      refreshTeamDirectory({ emit: true });
      userDisconnectTimers.delete(user.id);
    }, 3000);
    userDisconnectTimers.set(user.id,t);
  });
});

// Distribuição automática com janela de 30s. O sweep também resolve
// atendimentos que ficaram aguardando quando um atendente volta a ficar online.
setInterval(() => {
  for (const item of attendances.values()) {
    if (item?.status === 'waiting' && !item.agentId) autoAssignAttendance(item, 'Distribuição automática após 30s');
  }
}, 2000).unref?.();

// SLA e presença mudam com o tempo, mesmo sem cliques. Mantém a supervisão viva.
setInterval(() => emitSupervisorUpdate(), 5000).unref?.();

for (const user of contactDb.listUsers()) contactDb.setUserConnected(user.id, false);
refreshTeamDirectory();

server.listen(PORT, () => {
  console.log('');
  console.log('===================================');
  console.log(`CONNECTTALK v${APP_VERSION} — 30s Routing & Supervisor Escalation`);
  console.log('===================================');
  console.log(`http://localhost:${PORT}`);
  console.log('Motor: Baileys 6.7.23');
  console.log('Versão WA Web: dinâmica (sw.js → Baileys → fallback)');
  console.log('Inicializando WhatsApp...');
  console.log('');
});

await loadAttendances();
startWhatsApp().catch(handleFatalStartError);
