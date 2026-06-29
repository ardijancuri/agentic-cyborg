BEGIN;

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS assistant_conversations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID,
  title VARCHAR(255) NOT NULL DEFAULT 'Business assistant chat',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS assistant_messages (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  conversation_id UUID NOT NULL REFERENCES assistant_conversations(id) ON DELETE CASCADE,
  role VARCHAR(32) NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool')),
  content TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS assistant_context_documents (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  scope VARCHAR(128) NOT NULL,
  title VARCHAR(255) NOT NULL,
  content TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_hash VARCHAR(128) NOT NULL,
  created_by UUID,
  refreshed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS assistant_draft_actions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  conversation_id UUID REFERENCES assistant_conversations(id) ON DELETE CASCADE,
  message_id UUID REFERENCES assistant_messages(id) ON DELETE CASCADE,
  type VARCHAR(64) NOT NULL,
  title VARCHAR(255) NOT NULL,
  reason TEXT NOT NULL,
  target_route VARCHAR(255),
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  confidence NUMERIC(4, 3) NOT NULL DEFAULT 0,
  requires_user_review BOOLEAN NOT NULL DEFAULT true,
  status VARCHAR(32) NOT NULL DEFAULT 'draft',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS assistant_tool_runs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  conversation_id UUID REFERENCES assistant_conversations(id) ON DELETE CASCADE,
  message_id UUID REFERENCES assistant_messages(id) ON DELETE SET NULL,
  tool_name VARCHAR(128) NOT NULL,
  arguments JSONB NOT NULL DEFAULT '{}'::jsonb,
  result_summary TEXT,
  status VARCHAR(32) NOT NULL DEFAULT 'completed',
  error TEXT,
  duration_ms INTEGER,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_assistant_context_documents_scope
ON assistant_context_documents(scope);

CREATE INDEX IF NOT EXISTS idx_assistant_conversations_user_updated
ON assistant_conversations(user_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_assistant_messages_conversation_created
ON assistant_messages(conversation_id, created_at ASC);

CREATE INDEX IF NOT EXISTS idx_assistant_draft_actions_conversation
ON assistant_draft_actions(conversation_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_assistant_tool_runs_conversation
ON assistant_tool_runs(conversation_id, created_at DESC);

COMMENT ON TABLE assistant_context_documents IS 'Markdown context snapshots generated from approved business data tools.';
COMMENT ON TABLE assistant_draft_actions IS 'Assistant-proposed actions that require manual user review before any business data changes.';

COMMIT;
