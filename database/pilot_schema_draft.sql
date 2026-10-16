-- ConnectTalk / Connect administradora — esquema complementar para piloto.
-- RASCUNHO: NAO executar em producao antes de comparar com a base local v0.19.4.
-- Tabelas existentes no main v0.14: app_users, app_sessions, service_queues,
-- user_queues, people, contact_channels, conversation_contacts, audit_events.
-- Preserva tabelas existentes e nao altera dados.
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS ct_channel_accounts (
 id TEXT PRIMARY KEY,
 provider TEXT NOT NULL CHECK(provider IN ('whatsapp','telegram')),
 label TEXT NOT NULL,
 external_account_id TEXT,
 state TEXT NOT NULL DEFAULT 'disconnected'
   CHECK(state IN ('disconnected','connecting','connected','error','paused')),
 enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(provider,external_account_id)
);
CREATE TABLE IF NOT EXISTS ct_channel_queue_routes (
 account_id TEXT NOT NULL REFERENCES ct_channel_accounts(id) ON DELETE CASCADE,
 queue_id TEXT NOT NULL REFERENCES service_queues(id) ON DELETE CASCADE,
 PRIMARY KEY(account_id,queue_id)
);
CREATE TABLE IF NOT EXISTS ct_conversations (
 id TEXT PRIMARY KEY,
 account_id TEXT NOT NULL REFERENCES ct_channel_accounts(id),
 provider_chat_id TEXT NOT NULL,
 person_id INTEGER REFERENCES people(id) ON DELETE SET NULL,
 queue_id TEXT REFERENCES service_queues(id) ON DELETE SET NULL,
 assigned_user_id TEXT REFERENCES app_users(id) ON DELETE SET NULL,
 status TEXT NOT NULL DEFAULT 'queued'
   CHECK(status IN ('queued','active','closed')),
 opened_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 closed_at TEXT,
 UNIQUE(account_id,provider_chat_id,id)
);
CREATE INDEX IF NOT EXISTS idx_ct_conversations_queue_status ON ct_conversations(queue_id,status);
CREATE INDEX IF NOT EXISTS idx_ct_conversations_assignee_status ON ct_conversations(assigned_user_id,status);
CREATE INDEX IF NOT EXISTS idx_ct_conversations_person ON ct_conversations(person_id);
CREATE TABLE IF NOT EXISTS ct_messages (
 id TEXT PRIMARY KEY,
 conversation_id TEXT NOT NULL REFERENCES ct_conversations(id) ON DELETE CASCADE,
 provider_message_id TEXT,
 sender_type TEXT NOT NULL CHECK(sender_type IN ('contact','agent','system')),
 sender_user_id TEXT REFERENCES app_users(id) ON DELETE SET NULL,
 body TEXT NOT NULL DEFAULT '',
 direction TEXT NOT NULL CHECK(direction IN ('in','out','internal')),
 delivery_state TEXT NOT NULL DEFAULT 'pending'
   CHECK(delivery_state IN ('pending','sent','delivered','read','failed','received')),
 sent_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(conversation_id,provider_message_id)
);
CREATE INDEX IF NOT EXISTS idx_ct_messages_conversation_time ON ct_messages(conversation_id,sent_at);
CREATE TABLE IF NOT EXISTS ct_conversation_events (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 conversation_id TEXT NOT NULL REFERENCES ct_conversations(id) ON DELETE CASCADE,
 actor_user_id TEXT REFERENCES app_users(id) ON DELETE SET NULL,
 event_type TEXT NOT NULL,
 payload_json TEXT NOT NULL DEFAULT '{}',
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_ct_events_conversation_time ON ct_conversation_events(conversation_id,created_at);
-- Integração futura: migração dos atendimentos JSON existentes para ct_conversations
-- requer mapeamento e testes de idempotência, sem excluir dados de origem.
-- Tokens, QR, credenciais e segredos dos canais NÃO devem ser armazenados aqui em texto claro.
