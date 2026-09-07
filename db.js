import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { DatabaseSync } from 'node:sqlite';

function clean(value = '') { return String(value ?? '').trim(); }
function normalizePhone(value = '') { return String(value ?? '').replace(/\D/g, ''); }
function toId(value) {
  if (value === '' || value == null) return null;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export function createDatabase(baseDir) {
  const dataDir = path.join(baseDir, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const dbPath = path.join(dataDir, 'connecttalk.sqlite');
  const db = new DatabaseSync(dbPath);

  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS condominiums (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      document TEXT NOT NULL DEFAULT '',
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS units (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      condominium_id INTEGER NOT NULL,
      block TEXT NOT NULL DEFAULT '',
      number TEXT NOT NULL,
      complement TEXT NOT NULL DEFAULT '',
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(condominium_id) REFERENCES condominiums(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS people (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL DEFAULT '',
      document TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL DEFAULT 'morador',
      notes TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS contact_channels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      person_id INTEGER NOT NULL,
      channel TEXT NOT NULL DEFAULT 'whatsapp',
      address TEXT NOT NULL,
      jid TEXT NOT NULL DEFAULT '',
      is_primary INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(channel, address),
      FOREIGN KEY(person_id) REFERENCES people(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS person_units (
      person_id INTEGER NOT NULL,
      unit_id INTEGER NOT NULL,
      relationship TEXT NOT NULL DEFAULT 'morador',
      is_primary INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(person_id, unit_id),
      FOREIGN KEY(person_id) REFERENCES people(id) ON DELETE CASCADE,
      FOREIGN KEY(unit_id) REFERENCES units(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS audit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS conversation_contacts (
      chat_id TEXT PRIMARY KEY,
      person_id INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(person_id) REFERENCES people(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_channels_jid ON contact_channels(jid);
    CREATE INDEX IF NOT EXISTS idx_channels_person ON contact_channels(person_id);
    CREATE INDEX IF NOT EXISTS idx_people_name ON people(name);
    CREATE INDEX IF NOT EXISTS idx_units_condo ON units(condominium_id);
    CREATE INDEX IF NOT EXISTS idx_person_units_person ON person_units(person_id);
    CREATE INDEX IF NOT EXISTS idx_conversation_contacts_person ON conversation_contacts(person_id);

    CREATE TABLE IF NOT EXISTS app_users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'agent',
      status TEXT NOT NULL DEFAULT 'offline',
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS service_queues (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS user_queues (
      user_id TEXT NOT NULL,
      queue_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(user_id,queue_id),
      FOREIGN KEY(user_id) REFERENCES app_users(id) ON DELETE CASCADE,
      FOREIGN KEY(queue_id) REFERENCES service_queues(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS app_sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES app_users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_user ON app_sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_users_email ON app_users(email);

    CREATE TABLE IF NOT EXISTS departments (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS department_queues (
      department_id TEXT NOT NULL, queue_id TEXT NOT NULL,
      PRIMARY KEY(department_id,queue_id),
      FOREIGN KEY(department_id) REFERENCES departments(id) ON DELETE CASCADE,
      FOREIGN KEY(queue_id) REFERENCES service_queues(id) ON DELETE CASCADE
    );
  `);

  // Migrations for databases created by v0.7.
  const peopleCols = db.prepare(`PRAGMA table_info(people)`).all().map(c => c.name);
  if (!peopleCols.includes('notes')) db.exec(`ALTER TABLE people ADD COLUMN notes TEXT NOT NULL DEFAULT ''`);
  const condoCols = db.prepare(`PRAGMA table_info(condominiums)`).all().map(c => c.name);
  if (!condoCols.includes('updated_at')) db.exec(`ALTER TABLE condominiums ADD COLUMN updated_at TEXT NOT NULL DEFAULT ''`);
  const unitCols = db.prepare(`PRAGMA table_info(units)`).all().map(c => c.name);
  if (!unitCols.includes('active')) db.exec(`ALTER TABLE units ADD COLUMN active INTEGER NOT NULL DEFAULT 1`);
  if (!unitCols.includes('updated_at')) db.exec(`ALTER TABLE units ADD COLUMN updated_at TEXT NOT NULL DEFAULT ''`);
  const channelCols = db.prepare(`PRAGMA table_info(contact_channels)`).all().map(c => c.name);
  const userCols = db.prepare(`PRAGMA table_info(app_users)`).all().map(c => c.name);
  if (!userCols.includes('max_active')) db.exec(`ALTER TABLE app_users ADD COLUMN max_active INTEGER NOT NULL DEFAULT 5`);
  if (!userCols.includes('availability')) db.exec(`ALTER TABLE app_users ADD COLUMN availability TEXT NOT NULL DEFAULT 'online'`);
  const serviceQueueCols = db.prepare(`PRAGMA table_info(service_queues)`).all().map(c => c.name);
  if (!serviceQueueCols.includes('sla_minutes')) db.exec(`ALTER TABLE service_queues ADD COLUMN sla_minutes INTEGER NOT NULL DEFAULT 15`);
  if (!serviceQueueCols.includes('auto_assign')) db.exec(`ALTER TABLE service_queues ADD COLUMN auto_assign INTEGER NOT NULL DEFAULT 0`);
  if (!channelCols.includes('updated_at')) db.exec(`ALTER TABLE contact_channels ADD COLUMN updated_at TEXT NOT NULL DEFAULT ''`);
  const puCols = db.prepare(`PRAGMA table_info(person_units)`).all().map(c => c.name);
  if (!puCols.includes('created_at')) db.exec(`ALTER TABLE person_units ADD COLUMN created_at TEXT NOT NULL DEFAULT ''`);
  if (!puCols.includes('updated_at')) db.exec(`ALTER TABLE person_units ADD COLUMN updated_at TEXT NOT NULL DEFAULT ''`);

  const condoCount = Number(db.prepare('SELECT COUNT(*) AS total FROM condominiums').get().total || 0);
  if (!condoCount) {
    const condo = db.prepare('INSERT INTO condominiums(name) VALUES (?)').run('Residencial Connect Demo');
    const condoId = Number(condo.lastInsertRowid);
    db.prepare('INSERT INTO units(condominium_id, block, number) VALUES (?, ?, ?)').run(condoId, 'B', '203');
  }

  const q = {
    listCondos: db.prepare(`SELECT * FROM condominiums WHERE active=1 ORDER BY name COLLATE NOCASE`),
    getCondo: db.prepare(`SELECT * FROM condominiums WHERE id=?`),
    listUnitsAll: db.prepare(`SELECT u.*, c.name condominium_name FROM units u JOIN condominiums c ON c.id=u.condominium_id WHERE u.active=1 ORDER BY c.name COLLATE NOCASE,u.block COLLATE NOCASE,u.number COLLATE NOCASE`),
    listUnitsByCondo: db.prepare(`SELECT u.*, c.name condominium_name FROM units u JOIN condominiums c ON c.id=u.condominium_id WHERE u.active=1 AND u.condominium_id=? ORDER BY u.block COLLATE NOCASE,u.number COLLATE NOCASE`),
    getUnit: db.prepare(`SELECT u.*, c.name condominium_name FROM units u JOIN condominiums c ON c.id=u.condominium_id WHERE u.id=?`),
    getPersonBase: db.prepare(`SELECT * FROM people WHERE id=?`),
    personByJidBase: db.prepare(`SELECT p.* FROM people p JOIN contact_channels cc ON cc.person_id=p.id WHERE cc.channel='whatsapp' AND cc.jid=? ORDER BY cc.is_primary DESC LIMIT 1`),
    personByPhoneBase: db.prepare(`SELECT p.* FROM people p JOIN contact_channels cc ON cc.person_id=p.id WHERE cc.channel='whatsapp' AND cc.address=? ORDER BY cc.is_primary DESC LIMIT 1`),
    primaryChannel: db.prepare(`SELECT * FROM contact_channels WHERE person_id=? AND channel='whatsapp' ORDER BY is_primary DESC,id ASC LIMIT 1`),
    unitsForPerson: db.prepare(`SELECT pu.relationship,pu.is_primary,u.id unit_id,u.block,u.number,u.complement,c.id condominium_id,c.name condominium_name FROM person_units pu JOIN units u ON u.id=pu.unit_id JOIN condominiums c ON c.id=u.condominium_id WHERE pu.person_id=? ORDER BY pu.is_primary DESC,pu.created_at ASC`),
    listPeopleBase: db.prepare(`SELECT * FROM people ORDER BY name COLLATE NOCASE LIMIT 1000`),
    personByChatBase: db.prepare(`SELECT p.* FROM people p JOIN conversation_contacts cc ON cc.person_id=p.id WHERE cc.chat_id=? LIMIT 1`)
  };

  function enrich(base) {
    if (!base) return null;
    const channel = q.primaryChannel.get(base.id) || null;
    const linkedUnits = q.unitsForPerson.all(base.id) || [];
    const unit = linkedUnits[0] || null;
    return {
      ...base,
      phone: channel?.address || '',
      jid: channel?.jid || '',
      channelId: channel?.id || null,
      unit,
      units: linkedUnits
    };
  }


  // v0.9.3 — formato canônico. Nenhum componente da interface deve inventar
  // aliases próprios para nome/e-mail/unidade. JID/LID é identificador técnico;
  // telefone é um dado de cadastro separado.
  function toContactCore(person, chatId = '') {
    const p = person || null;
    const technicalId = clean(chatId || p?.jid || '');
    const technicalAddress = normalizePhone(technicalId.split('@')[0] || '');
    const storedPhone = normalizePhone(p?.phone || '');
    const isLid = technicalId.endsWith('@lid');
    const phoneLooksTechnical = !!(isLid && storedPhone && technicalAddress && storedPhone === technicalAddress);
    const u = p?.unit || null;
    return {
      id: p?.id || null,
      chatId: technicalId,
      technicalId,
      technicalKind: isLid ? 'lid' : technicalId.includes('@g.us') ? 'group' : technicalId ? 'jid' : '',
      name: p?.name || '',
      phone: phoneLooksTechnical ? '' : storedPhone,
      storedPhone,
      phoneLooksTechnical,
      email: p?.email || '',
      document: p?.document || '',
      kind: p?.kind || 'morador',
      notes: p?.notes || '',
      relationship: u?.relationship || p?.kind || 'morador',
      condominium: u ? { id: u.condominium_id, name: u.condominium_name } : null,
      unit: u ? {
        id: u.unit_id,
        condominiumId: u.condominium_id,
        condominiumName: u.condominium_name,
        block: u.block || '',
        number: u.number || '',
        complement: u.complement || '',
        relationship: u.relationship || p?.kind || 'morador'
      } : null,
      identified: !!p?.id,
      updatedAt: p?.updated_at || null
    };
  }

  function audit(entityType, entityId, eventType, payload = {}) {
    db.prepare(`INSERT INTO audit_events(entity_type,entity_id,event_type,payload) VALUES (?,?,?,?)`)
      .run(clean(entityType), String(entityId), clean(eventType), JSON.stringify(payload));
  }

  function linkChatToPerson(chatId, personId) {
    chatId = clean(chatId);
    personId = toId(personId);
    if (!chatId || !personId) return null;
    const person = q.getPersonBase.get(personId);
    if (!person) throw new Error('Contato não encontrado para vincular à conversa.');
    db.prepare(`INSERT INTO conversation_contacts(chat_id,person_id) VALUES (?,?)
      ON CONFLICT(chat_id) DO UPDATE SET person_id=excluded.person_id, updated_at=CURRENT_TIMESTAMP`)
      .run(chatId, personId);
    return enrich(person);
  }

  function identifyChat(chatId) {
    chatId = clean(chatId);
    if (!chatId) return null;
    const linked = q.personByChatBase.get(chatId);
    if (linked) return enrich(linked);
    const identified = identifyJid(chatId);
    if (identified?.id) {
      linkChatToPerson(chatId, identified.id);
      return identifyChat(chatId);
    }
    return null;
  }

  function savePerson(input = {}) {
    const id = toId(input.id);
    const name = clean(input.name);
    const phone = normalizePhone(input.phone);
    const email = clean(input.email).toLowerCase();
    const kind = clean(input.kind) || 'morador';
    const document = clean(input.document);
    const notes = clean(input.notes);
    const jid = clean(input.jid);
    const unitId = toId(input.unitId);
    const relationship = clean(input.relationship) || kind || 'morador';

    if (!name) throw new Error('Nome é obrigatório.');
    if (!phone) throw new Error('Telefone é obrigatório.');
    if (email && !/^\S+@\S+\.\S+$/.test(email)) throw new Error('E-mail inválido.');
    if (unitId && !q.getUnit.get(unitId)) throw new Error('Unidade selecionada não existe.');

    const byId = id ? q.getPersonBase.get(id) : null;
    const byPhone = q.personByPhoneBase.get(phone);
    const byJid = jid ? q.personByJidBase.get(jid) : null;
    const existing = byId || byJid || byPhone || null;

    db.exec('BEGIN IMMEDIATE');
    try {
      let personId;
      if (existing) {
        personId = Number(existing.id);
        db.prepare(`UPDATE people SET name=?,email=?,document=?,kind=?,notes=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
          .run(name, email, document, kind, notes, personId);
      } else {
        const r = db.prepare(`INSERT INTO people(name,email,document,kind,notes) VALUES (?,?,?,?,?)`)
          .run(name, email, document, kind, notes);
        personId = Number(r.lastInsertRowid);
      }

      // If the phone/JID already points to a different duplicate person, detach it first.
      const conflicting = db.prepare(`SELECT id,person_id FROM contact_channels WHERE channel='whatsapp' AND address=? LIMIT 1`).get(phone);
      if (conflicting && Number(conflicting.person_id) !== personId) {
        db.prepare(`DELETE FROM contact_channels WHERE id=?`).run(conflicting.id);
      }
      if (jid) {
        const jidConflict = db.prepare(`SELECT id,person_id FROM contact_channels WHERE channel='whatsapp' AND jid=? AND jid<>'' LIMIT 1`).get(jid);
        if (jidConflict && Number(jidConflict.person_id) !== personId) {
          db.prepare(`UPDATE contact_channels SET jid='' WHERE id=?`).run(jidConflict.id);
        }
      }

      const channel = q.primaryChannel.get(personId);
      if (channel) {
        db.prepare(`UPDATE contact_channels SET address=?,jid=?,is_primary=1,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
          .run(phone, jid || channel.jid || '', channel.id);
      } else {
        db.prepare(`INSERT INTO contact_channels(person_id,channel,address,jid,is_primary) VALUES (?,'whatsapp',?,?,1)`)
          .run(personId, phone, jid);
      }

      // v0.8: unit link is deliberately replaced atomically, fixing the v0.7 partial-save bug.
      db.prepare(`DELETE FROM person_units WHERE person_id=?`).run(personId);
      if (unitId) {
        db.prepare(`INSERT INTO person_units(person_id,unit_id,relationship,is_primary) VALUES (?,?,?,1)`)
          .run(personId, unitId, relationship);
      }

      const chatId = clean(input.chatId || jid);
      if (chatId) {
        db.prepare(`INSERT INTO conversation_contacts(chat_id,person_id) VALUES (?,?)
          ON CONFLICT(chat_id) DO UPDATE SET person_id=excluded.person_id, updated_at=CURRENT_TIMESTAMP`)
          .run(chatId, personId);
      }
      audit('person', personId, existing ? 'updated' : 'created', { name, phone, email, kind, unitId, relationship, jid, chatId });
      db.exec('COMMIT');
      return enrich(q.getPersonBase.get(personId));
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  function identifyJid(jid) {
    jid = clean(jid);
    if (!jid) return null;
    const direct = q.personByJidBase.get(jid);
    if (direct) return enrich(direct);
    const phone = normalizePhone(jid.split('@')[0]);
    if (!phone) return null;
    const byPhone = q.personByPhoneBase.get(phone);
    if (!byPhone) return null;
    db.prepare(`UPDATE contact_channels SET jid=?,updated_at=CURRENT_TIMESTAMP WHERE person_id=? AND channel='whatsapp'`)
      .run(jid, byPhone.id);
    return enrich(q.getPersonBase.get(byPhone.id));
  }

  function createCondominium(input = {}) {
    const name = clean(input.name);
    const document = clean(input.document);
    if (!name) throw new Error('Nome do condomínio é obrigatório.');
    const r = db.prepare(`INSERT INTO condominiums(name,document) VALUES (?,?)`).run(name, document);
    audit('condominium', r.lastInsertRowid, 'created', { name, document });
    return q.getCondo.get(Number(r.lastInsertRowid));
  }

  function createUnit(input = {}) {
    const condominiumId = toId(input.condominiumId);
    const block = clean(input.block);
    const number = clean(input.number);
    const complement = clean(input.complement);
    if (!condominiumId || !q.getCondo.get(condominiumId)) throw new Error('Condomínio inválido.');
    if (!number) throw new Error('Número da unidade é obrigatório.');
    const duplicate = db.prepare(`SELECT id FROM units WHERE condominium_id=? AND block=? AND number=? AND active=1 LIMIT 1`).get(condominiumId, block, number);
    if (duplicate) throw new Error('Esta unidade já está cadastrada.');
    const r = db.prepare(`INSERT INTO units(condominium_id,block,number,complement) VALUES (?,?,?,?)`).run(condominiumId, block, number, complement);
    audit('unit', r.lastInsertRowid, 'created', { condominiumId, block, number, complement });
    return q.getUnit.get(Number(r.lastInsertRowid));
  }


  // v0.10 — usuários, filas e sessões persistidos no SQLite.
  function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
    const derived = crypto.scryptSync(String(password), salt, 64).toString('hex');
    return `scrypt$${salt}$${derived}`;
  }

  function verifyPassword(password, stored = '') {
    const [scheme, salt, expected] = String(stored).split('$');
    if (scheme !== 'scrypt' || !salt || !expected) return false;
    const actual = crypto.scryptSync(String(password), salt, 64).toString('hex');
    try { return crypto.timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex')); }
    catch { return false; }
  }

  function publicUser(row) {
    if (!row) return null;
    return { id: row.id || row.user_id, name: row.name, email: row.email, role: row.role, status: row.status, availability: row.availability || row.status || 'online', active: !!row.active, maxActive: Number(row.max_active || 5) };
  }

  function seedAuth() {
    const queues = [
      ['geral','Geral'],['financeiro','Financeiro'],['manutencao','Manutenção'],['administrativo','Administrativo']
    ];
    const qIns = db.prepare(`INSERT OR IGNORE INTO service_queues(id,name,active) VALUES (?,?,1)`);
    for (const qv of queues) qIns.run(...qv);

    const users = [
      ['djalma','Djalma Martins','djalma@connect.local','admin'],
      ['ana','Ana Carolina','ana@connect.local','agent'],
      ['jack','Jack','jack@connect.local','agent'],
      ['rafael','Rafael','rafael@connect.local','supervisor']
    ];
    const uIns = db.prepare(`INSERT OR IGNORE INTO app_users(id,name,email,password_hash,role,status,active) VALUES (?,?,?,?,?,'offline',1)`);
    for (const [id,name,email,role] of users) uIns.run(id,name,email,hashPassword('demo1234'),role);
    const uqIns = db.prepare(`INSERT OR IGNORE INTO user_queues(user_id,queue_id) VALUES (?,?)`);
    for (const [id] of users) for (const [qid] of queues) uqIns.run(id,qid);
  }
  seedAuth();
  db.prepare(`INSERT OR IGNORE INTO departments(id,name,active) VALUES ('atendimento','Atendimento',1),('administrativo','Administrativo',1)`).run();
  for (const qid of ['geral','financeiro','manutencao']) db.prepare(`INSERT OR IGNORE INTO department_queues(department_id,queue_id) VALUES ('atendimento',?)`).run(qid);
  db.prepare(`INSERT OR IGNORE INTO department_queues(department_id,queue_id) VALUES ('administrativo','administrativo')`).run();

  const authQ = {
    userById: db.prepare(`SELECT * FROM app_users WHERE id=? AND active=1`),
    userByEmail: db.prepare(`SELECT * FROM app_users WHERE lower(email)=lower(?) AND active=1`),
    listUsers: db.prepare(`SELECT * FROM app_users WHERE active=1 ORDER BY name COLLATE NOCASE`),
    listQueues: db.prepare(`SELECT * FROM service_queues WHERE active=1 ORDER BY name COLLATE NOCASE`),
    queueById: db.prepare(`SELECT * FROM service_queues WHERE id=? AND active=1`),
    sessionByHash: db.prepare(`SELECT s.*,u.name,u.email,u.role,u.status,u.availability,u.active,u.max_active FROM app_sessions s JOIN app_users u ON u.id=s.user_id WHERE s.token_hash=? AND u.active=1`)
  };

  function createSession(email, password, ttlHours = 24) {
    const row = authQ.userByEmail.get(clean(email));
    if (!row || !verifyPassword(password, row.password_hash)) return null;
    const token = crypto.randomBytes(32).toString('base64url');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const expires = new Date(Date.now() + Number(ttlHours || 24) * 3600000).toISOString();
    db.prepare(`DELETE FROM app_sessions WHERE expires_at <= ?`).run(new Date().toISOString());
    db.prepare(`INSERT INTO app_sessions(token_hash,user_id,expires_at) VALUES (?,?,?)`).run(tokenHash,row.id,expires);
    db.prepare(`UPDATE app_users SET availability='online',status='online',updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(row.id);
    return { token, expiresAt: expires, user: publicUser(authQ.userById.get(row.id)) };
  }

  function getSession(token) {
    token = clean(token);
    if (!token) return null;
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const row = authQ.sessionByHash.get(tokenHash);
    if (!row) return null;
    if (new Date(row.expires_at).getTime() <= Date.now()) {
      db.prepare(`DELETE FROM app_sessions WHERE token_hash=?`).run(tokenHash);
      return null;
    }
    return { tokenHash, expiresAt: row.expires_at, user: publicUser(row) };
  }

  function destroySession(token) {
    token = clean(token);
    if (!token) return;
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const session = authQ.sessionByHash.get(tokenHash);
    db.prepare(`DELETE FROM app_sessions WHERE token_hash=?`).run(tokenHash);
    if (session?.user_id) {
      const activeSessions = Number(db.prepare(`SELECT COUNT(*) total FROM app_sessions WHERE user_id=? AND expires_at>?`).get(session.user_id,new Date().toISOString()).total || 0);
      if (!activeSessions) db.prepare(`UPDATE app_users SET status='offline',updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(session.user_id);
    }
  }

  function setUserStatus(id,status) {
    if (!['online','away','offline'].includes(status)) throw new Error('Status inválido.');
    const r = db.prepare(`UPDATE app_users SET availability=?,status=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND active=1`).run(status,status,clean(id));
    if (!r.changes) throw new Error('Usuário não encontrado.');
    return publicUser(authQ.userById.get(clean(id)));
  }

  // v0.13: status efetivo depende da conexão real do navegador. A preferência
  // manual (availability) é preservada para que "Ausente"/"Offline" não seja
  // confundido com queda de conexão.
  function setUserConnected(id, connected) {
    const uid=clean(id);
    const row=authQ.userById.get(uid);
    if(!row) return null;
    const availability=['online','away','offline'].includes(row.availability) ? row.availability : 'online';
    const effective=connected ? availability : 'offline';
    db.prepare(`UPDATE app_users SET status=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND active=1`).run(effective,uid);
    return publicUser(authQ.userById.get(uid));
  }

  function createUser(input={}) {
    const id = clean(input.id || clean(input.name).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'')).slice(0,40);
    const name=clean(input.name), email=clean(input.email).toLowerCase(), role=clean(input.role)||'agent', password=String(input.password||'');
    if (!id || !name || !email || !password) throw new Error('Nome, e-mail e senha são obrigatórios.');
    if (!['agent','supervisor','admin'].includes(role)) throw new Error('Perfil inválido.');
    if (password.length < 6) throw new Error('A senha deve ter ao menos 6 caracteres.');
    db.prepare(`INSERT INTO app_users(id,name,email,password_hash,role,status,active) VALUES (?,?,?,?,?,'offline',1)`).run(id,name,email,hashPassword(password),role);
    for (const qrow of authQ.listQueues.all()) db.prepare(`INSERT OR IGNORE INTO user_queues(user_id,queue_id) VALUES (?,?)`).run(id,qrow.id);
    return publicUser(authQ.userById.get(id));
  }

  function createQueue(input={}) {
    const name=clean(input.name);
    const id=clean(input.id || name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'')).slice(0,40);
    if (!id || !name) throw new Error('Nome da fila é obrigatório.');
    db.prepare(`INSERT INTO service_queues(id,name,active) VALUES (?,?,1)`).run(id,name);
    return authQ.queueById.get(id);
  }

  function setUserRole(id, role) {
    if (!['agent','supervisor','admin'].includes(role)) throw new Error('Perfil inválido.');
    const r=db.prepare(`UPDATE app_users SET role=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND active=1`).run(role,clean(id));
    if(!r.changes) throw new Error('Usuário não encontrado.');
    return publicUser(authQ.userById.get(clean(id)));
  }

  function deactivateUser(id) {
    const r=db.prepare(`UPDATE app_users SET active=0,status='offline',updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(clean(id));
    if(!r.changes) throw new Error('Usuário não encontrado.');
    db.prepare(`DELETE FROM app_sessions WHERE user_id=?`).run(clean(id));
    return true;
  }

  function listDepartments() {
    return db.prepare(`SELECT * FROM departments WHERE active=1 ORDER BY name`).all().map(d => ({...d, queues: db.prepare(`SELECT q.* FROM service_queues q JOIN department_queues dq ON dq.queue_id=q.id WHERE dq.department_id=? AND q.active=1 ORDER BY q.name`).all(d.id)}));
  }
  function userQueueIds(userId) { return db.prepare(`SELECT queue_id FROM user_queues WHERE user_id=?`).all(clean(userId)).map(r=>r.queue_id); }
  function setUserQueues(userId, queueIds=[]) {
    const uid=clean(userId); if(!authQ.userById.get(uid)) throw new Error('Usuário não encontrado.');
    const tx=db.transaction(()=>{ db.prepare(`DELETE FROM user_queues WHERE user_id=?`).run(uid); for(const qid of queueIds){ if(authQ.queueById.get(clean(qid))) db.prepare(`INSERT OR IGNORE INTO user_queues(user_id,queue_id) VALUES (?,?)`).run(uid,clean(qid)); }}); tx(); return userQueueIds(uid);
  }
  function setUserCapacity(userId, maxActive) { const n=Math.max(1,Math.min(50,Number(maxActive||5))); db.prepare(`UPDATE app_users SET max_active=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(n,clean(userId)); return publicUser(authQ.userById.get(clean(userId))); }
  function updateQueueOps(queueId,input={}) { const id=clean(queueId); if(!authQ.queueById.get(id)) throw new Error('Fila não encontrada.'); const sla=Math.max(1,Math.min(1440,Number(input.slaMinutes||15))); const auto=input.autoAssign?1:0; db.prepare(`UPDATE service_queues SET sla_minutes=?,auto_assign=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(sla,auto,id); return authQ.queueById.get(id); }

  return {
    dbPath,
    createSession,
    getSession,
    destroySession,
    listUsers: () => authQ.listUsers.all().map(publicUser),
    getUser: (id) => publicUser(authQ.userById.get(clean(id))),
    setUserStatus,
    setUserConnected,
    createUser,
    setUserRole,
    deactivateUser,
    listServiceQueues: () => authQ.listQueues.all(),
    getServiceQueue: (id) => authQ.queueById.get(clean(id)) || null,
    createServiceQueue: createQueue,
    listDepartments,
    userQueueIds,
    setUserQueues,
    setUserCapacity,
    updateQueueOps,
    listCondominiums: () => q.listCondos.all(),
    listUnits: (condoId = null) => condoId ? q.listUnitsByCondo.all(Number(condoId)) : q.listUnitsAll.all(),
    listPeople: () => q.listPeopleBase.all().map(enrich),
    getPerson: (id) => enrich(q.getPersonBase.get(Number(id))),
    findPersonByJid: (jid) => identifyJid(jid),
    findPersonByPhone: (phone) => enrich(q.personByPhoneBase.get(normalizePhone(phone))),
    savePerson,
    identifyJid,
    identifyChat,
    toContactCore,
    linkChatToPerson,
    createCondominium,
    createUnit,
    debugPersonByJid(jid) {
      const person = identifyChat(jid);
      const directLink = q.personByChatBase.get(clean(jid)) || null;
      return { jid, normalizedPhone: normalizePhone(String(jid).split('@')[0]), linkedPersonId: directLink?.id || null, person };
    }
  };
}
