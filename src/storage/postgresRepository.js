const safeJson = (value) => JSON.stringify(value && typeof value === 'object' ? value : {});

const defaultNormalizeUserId = (user) => {
  if (!user?.id || user.id === 'service-account') {
    return null;
  }

  return user.id;
};

const makeTitle = (message = '') => {
  const clean = String(message).replace(/\s+/g, ' ').trim();
  if (!clean) {
    return 'Business assistant chat';
  }

  return clean.length > 80 ? `${clean.slice(0, 77)}...` : clean;
};

export const createPostgresAssistantRepository = ({ pool, normalizeUserId = defaultNormalizeUserId }) => {
  if (!pool?.query) {
    throw new Error('createPostgresAssistantRepository requires a pg Pool or client with query()');
  }

  return {
    async createConversation({ user, title, metadata = {} }) {
      const result = await pool.query(
        `INSERT INTO assistant_conversations (user_id, title, metadata)
         VALUES ($1, $2, $3)
         RETURNING *`,
        [normalizeUserId(user), title || 'Business assistant chat', safeJson(metadata)]
      );

      return result.rows[0];
    },

    async getConversationForUser(id, user) {
      const result = await pool.query(
        `SELECT *
         FROM assistant_conversations
         WHERE id = $1
           AND (user_id = $2 OR $2::uuid IS NULL)
         LIMIT 1`,
        [id, normalizeUserId(user)]
      );

      return result.rows[0] || null;
    },

    async getOrCreateConversation({ conversationId, user, firstMessage }) {
      if (conversationId) {
        const existing = await this.getConversationForUser(conversationId, user);
        if (existing) {
          return existing;
        }
      }

      return this.createConversation({
        user,
        title: makeTitle(firstMessage),
        metadata: { source: 'assistant_ui' },
      });
    },

    async listConversations(user, { limit = 20 } = {}) {
      const safeLimit = Math.max(1, Math.min(parseInt(limit, 10) || 20, 50));
      const result = await pool.query(
        `SELECT c.*,
          (
            SELECT content
            FROM assistant_messages m
            WHERE m.conversation_id = c.id
            ORDER BY m.created_at DESC
            LIMIT 1
          ) AS last_message
         FROM assistant_conversations c
         WHERE c.user_id = $1
         ORDER BY c.updated_at DESC
         LIMIT $2`,
        [normalizeUserId(user), safeLimit]
      );

      return result.rows;
    },

    async listMessages(conversationId, { limit = 50 } = {}) {
      const safeLimit = Math.max(1, Math.min(parseInt(limit, 10) || 50, 100));
      const result = await pool.query(
        `SELECT *
         FROM assistant_messages
         WHERE conversation_id = $1
         ORDER BY created_at DESC
         LIMIT $2`,
        [conversationId, safeLimit]
      );

      return result.rows.reverse();
    },

    async addMessage({ conversationId, role, content, metadata = {} }) {
      const result = await pool.query(
        `INSERT INTO assistant_messages (conversation_id, role, content, metadata)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [conversationId, role, String(content || ''), safeJson(metadata)]
      );

      await pool.query(
        `UPDATE assistant_conversations
         SET updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [conversationId]
      );

      return result.rows[0];
    },

    async upsertContextDocument({ scope, title, content, metadata = {}, sourceHash, user }) {
      const result = await pool.query(
        `INSERT INTO assistant_context_documents (
          scope, title, content, metadata, source_hash, created_by, refreshed_at, updated_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
         ON CONFLICT (scope)
         DO UPDATE SET
          title = EXCLUDED.title,
          content = EXCLUDED.content,
          metadata = EXCLUDED.metadata,
          source_hash = EXCLUDED.source_hash,
          created_by = EXCLUDED.created_by,
          refreshed_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
         RETURNING *`,
        [scope, title, content, safeJson(metadata), sourceHash, normalizeUserId(user)]
      );

      return result.rows[0];
    },

    async listContextDocuments({ includeContent = false } = {}) {
      const fields = includeContent
        ? '*'
        : `id, scope, title, metadata, source_hash, refreshed_at, created_at, updated_at,
           LEFT(content, 360) AS preview`;

      const result = await pool.query(
        `SELECT ${fields}
         FROM assistant_context_documents
         ORDER BY scope ASC`
      );

      return result.rows;
    },

    async addDraftActions({ conversationId, messageId, actions = [] }) {
      const saved = [];

      for (const action of actions) {
        const result = await pool.query(
          `INSERT INTO assistant_draft_actions (
            conversation_id, message_id, type, title, reason, target_route,
            payload, confidence, requires_user_review
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true)
          RETURNING *`,
          [
            conversationId,
            messageId,
            action.type,
            action.title,
            action.reason,
            action.targetRoute,
            safeJson(action.payload),
            action.confidence,
          ]
        );
        saved.push(result.rows[0]);
      }

      return saved;
    },

    async addToolRun({ conversationId, messageId = null, toolName, args = {}, resultSummary, status = 'completed', error = null, durationMs = null }) {
      const result = await pool.query(
        `INSERT INTO assistant_tool_runs (
          conversation_id, message_id, tool_name, arguments, result_summary,
          status, error, duration_ms
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING *`,
        [
          conversationId,
          messageId,
          toolName,
          safeJson(args),
          resultSummary || null,
          status,
          error,
          durationMs,
        ]
      );

      return result.rows[0];
    },
  };
};
