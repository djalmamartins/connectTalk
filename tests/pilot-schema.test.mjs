import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Teste isolado: SQLite somente em memoria; nunca abre data/connecttalk.sqlite.
const here = path.dirname(fileURLToPath(import.meta.url));
const db = new DatabaseSync(':memory:');
db.exec(`
 PRAGMA foreign_keys=ON;
 CREATE TABLE app_users(id TEXT PRIMARY KEY);
 CREATE TABLE service_queues(id TEXT PRIMARY KEY);
 CREATE TABLE people(id INTEGER PRIMARY KEY);
 INSERT INTO app_users VALUES ('agent-1');
 INSERT INTO service_queues VALUES ('geral');
 INSERT INTO people VALUES (1);
`);
db.exec(readFileSync(path.join(here, '..', 'database', 'pilot_schema_draft.sql'), 'utf8'));
db.exec(readFileSync(path.join(here, '..', 'database', 'pilot_schema_draft.sql'), 'utf8'));
assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
db.prepare('INSERT INTO ct_channel_accounts(id,provider,label) VALUES (?,?,?)').run('wa-1','whatsapp','Connect 1');
db.prepare('INSERT INTO ct_channel_accounts(id,provider,label) VALUES (?,?,?)').run('wa-2','whatsapp','Connect 2');
db.prepare('INSERT INTO ct_channel_queue_routes(account_id,queue_id) VALUES (?,?)').run('wa-1','geral');
db.prepare('INSERT INTO ct_conversations(id,account_id,provider_chat_id,person_id,queue_id,assigned_user_id) VALUES (?,?,?,?,?,?)')
 .run('ticket-1','wa-1','5511999999999',1,'geral','agent-1');
db.prepare('INSERT INTO ct_messages(id,conversation_id,sender_type,body,direction,delivery_state) VALUES (?,?,?,?,?,?)')
 .run('message-1','ticket-1','contact','Teste','in','received');
db.prepare('INSERT INTO ct_conversation_events(conversation_id,actor_user_id,event_type) VALUES (?,?,?)')
 .run('ticket-1','agent-1','assigned');
assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ct_messages').get().n, 1);
assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ct_conversation_events').get().n, 1);
assert.throws(() => db.prepare('INSERT INTO ct_messages(id,conversation_id,sender_type,direction) VALUES (?,?,?,?)')
 .run('bad','missing','contact','in'));
assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
console.log('OK: esquema aditivo, idempotencia, dois canais, vinculos e historico.');
db.close();
