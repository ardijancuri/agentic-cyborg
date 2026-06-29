import test from 'node:test';
import assert from 'node:assert/strict';
import { readAssistantConfig } from '../src/core/config.js';
import { validateDraftActions } from '../src/core/draftActions.js';
import { buildSystemPrompt, buildUnavailableAssistantMessage } from '../src/core/promptBuilder.js';
import { resolveDraftActionRoute } from '../src/core/pageRegistry.js';
import { refreshAssistantContext, createStaticContextSource } from '../src/context/contextRefresh.js';
import { AssistantService } from '../src/core/AssistantService.js';
import { OpenAIResponsesProvider } from '../src/providers/OpenAIResponsesProvider.js';
import { createReadOnlyToolRegistry, clampToolLimit } from '../src/adapters/readOnlyToolRegistry.js';
import { createAssistantRoleAuthorize } from '../src/integrations/express/roleAccess.js';

const TEST_PAGE_REGISTRY = [
  {
    id: 'dashboard',
    label: 'Dashboard',
    route: '/dashboard',
    actionTypes: ['open_page', 'operational_note'],
    keywords: ['dashboard', 'alert'],
  },
  {
    id: 'stock',
    label: 'Stock',
    route: '/stock',
    actionTypes: ['review_stock'],
    keywords: ['stock', 'inventory'],
  },
  {
    id: 'reports',
    label: 'Reports',
    route: '/reports',
    actionTypes: ['review_report'],
    keywords: ['reports', 'finance'],
  },
];

test('config is API-ready but unconfigured without an API key', () => {
  const config = readAssistantConfig({
    ASSISTANT_ENABLED: 'true',
    ASSISTANT_PROVIDER: 'openai',
    OPENAI_MODEL: 'gpt-test',
  });

  assert.equal(config.enabled, true);
  assert.equal(config.provider, 'openai');
  assert.equal(config.model, 'gpt-test');
  assert.equal(config.hasApiKey, false);
  assert.equal(config.configured, false);
});

test('config defaults to low-cost model', () => {
  const config = readAssistantConfig({
    ASSISTANT_ENABLED: 'true',
    ASSISTANT_PROVIDER: 'openai',
  });

  assert.equal(config.model, 'gpt-5.4-mini');
});

test('missing API key message is explicit', () => {
  const message = buildUnavailableAssistantMessage({ enabled: true, hasApiKey: false });

  assert.match(message, /OPENAI_API_KEY/);
});

test('draft actions are always review-only', () => {
  const actions = validateDraftActions([
    {
      type: 'delete_invoice',
      title: 'Review unpaid invoices',
      reason: 'Some invoices need owner attention.',
      targetRoute: '/reports',
      confidence: 2,
      requiresUserReview: false,
    },
  ]);

  assert.equal(actions.length, 1);
  assert.equal(actions[0].type, 'operational_note');
  assert.equal(actions[0].requiresUserReview, true);
  assert.equal(actions[0].confidence, 1);
});

test('system prompt includes host app and tool names', () => {
  const prompt = buildSystemPrompt({
    appName: 'Test CRM',
    locale: 'en',
    contextDocuments: [{ title: 'Profile', scope: 'business_profile', content: 'Revenue: 100' }],
    toolDefinitions: [{ name: 'get_sales_summary' }],
    pageRegistry: TEST_PAGE_REGISTRY,
    fallbackRoute: '/dashboard',
  });

  assert.match(prompt, /Test CRM/);
  assert.match(prompt, /get_sales_summary/);
  assert.match(prompt, /Markdown context/);
  assert.match(prompt, /2-5 concise/);
  assert.match(prompt, /Registered pages/);
  assert.match(prompt, /\/reports/);
});

test('draft actions are clamped to registered host routes', () => {
  const actions = validateDraftActions([
    {
      type: 'review_stock',
      title: 'Review low stock',
      reason: 'Some inventory needs attention.',
      targetRoute: '/invented/stock-page',
      confidence: 0.8,
    },
  ], {
    pageRegistry: TEST_PAGE_REGISTRY,
    fallbackRoute: '/dashboard',
  });

  assert.equal(actions.length, 1);
  assert.equal(actions[0].targetRoute, '/stock');

  const resolved = resolveDraftActionRoute({
    type: 'review_report',
    title: 'Open finance details',
    reason: 'Revenue report should be reviewed.',
    targetRoute: 'https://bad.example/reports',
  }, {
    pageRegistry: TEST_PAGE_REGISTRY,
    fallbackRoute: '/dashboard',
  });

  assert.equal(resolved.route, '/reports');
});

test('read-only tool registry exposes only named tools and passes context', async () => {
  const registry = createReadOnlyToolRegistry({
    tools: [
      {
        name: 'get_inventory_summary',
        description: 'Inventory summary',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        handler: async (args, context) => ({
          data: { limit: clampToolLimit(args.limit, 5, 10), userId: context.user.id },
          summary: 'Inventory returned',
        }),
      },
    ],
  });

  assert.equal(registry.hasTool('get_inventory_summary'), true);
  assert.equal(registry.hasTool('run_sql'), false);
  assert.equal(registry.listDefinitions()[0].name, 'get_inventory_summary');

  const result = await registry.execute('get_inventory_summary', { limit: 20 }, { user: { id: 'user-1' } });
  assert.equal(result.data.limit, 10);
  assert.equal(result.data.userId, 'user-1');
  assert.equal(result.summary, 'Inventory returned');

  await assert.rejects(
    () => registry.execute('run_sql', {}),
    /Unknown assistant tool/
  );
});

test('assistant role authorize defaults to admin and full_admin', () => {
  const authorize = createAssistantRoleAuthorize();
  let nextCalled = false;

  authorize(
    { user: { role: 'admin' } },
    {},
    () => {
      nextCalled = true;
    }
  );

  assert.equal(nextCalled, true);

  let statusCode = 0;
  let payload = null;
  authorize(
    { user: { role: 'staff' } },
    {
      status(code) {
        statusCode = code;
        return this;
      },
      json(body) {
        payload = body;
      },
    },
    () => {}
  );

  assert.equal(statusCode, 403);
  assert.match(payload.error, /denied/);
});

test('context refresh stores generated markdown documents', async () => {
  const saved = [];
  const repository = {
    async upsertContextDocument(document) {
      saved.push(document);
      return { ...document, id: String(saved.length) };
    },
  };

  const result = await refreshAssistantContext({
    repository,
    user: { id: 'user-1' },
    contextSources: [
      createStaticContextSource({
        scope: 'profile',
        title: 'Profile',
        content: '# Profile',
      }),
    ],
  });

  assert.equal(result.length, 1);
  assert.equal(saved[0].scope, 'profile');
  assert.equal(typeof saved[0].sourceHash, 'string');
});

test('assistant service returns controlled unconfigured response', async () => {
  const messages = [];
  const repository = {
    async getOrCreateConversation() {
      return { id: 'conversation-1', title: 'Hello', metadata: {} };
    },
    async addMessage(message) {
      const saved = { ...message, id: `message-${messages.length + 1}`, created_at: new Date().toISOString() };
      messages.push(saved);
      return saved;
    },
    async listConversations() {
      return [];
    },
    async listMessages() {
      return messages;
    },
    async listContextDocuments() {
      return [];
    },
    async addDraftActions() {
      return [];
    },
    async addToolRun() {
      return null;
    },
  };

  const service = new AssistantService({
    repository,
    config: readAssistantConfig({ ASSISTANT_PROVIDER: 'openai' }),
    toolRegistry: {
      listDefinitions: () => [],
      execute: async () => ({ data: {}, summary: 'ok' }),
    },
  });

  const result = await service.chat({
    user: { id: 'user-1' },
    message: 'Hello',
  });

  assert.match(result.answer, /OPENAI_API_KEY/);
  assert.equal(result.draftActions.length, 0);
});

test('openai responses provider keeps tool-call continuation stateless with encrypted reasoning', async () => {
  const requests = [];
  class MockOpenAIResponsesProvider extends OpenAIResponsesProvider {
    async request(body) {
      requests.push(body);

      if (requests.length === 1) {
        return {
          id: 'resp-1',
          output: [
            {
              type: 'reasoning',
              id: 'rs_1',
              encrypted_content: 'encrypted-reasoning',
              summary: [],
            },
            {
              type: 'function_call',
              id: 'fc_1',
              call_id: 'call_1',
              name: 'get_sales_summary',
              arguments: '{}',
            },
          ],
        };
      }

      return {
        id: 'resp-2',
        output_text: JSON.stringify({ answer: 'Done', citations: [], draftActions: [] }),
        output: [],
      };
    }
  }

  const provider = new MockOpenAIResponsesProvider({
    config: { apiKey: 'test-key', model: 'gpt-test', maxToolCalls: 2 },
    toolRegistry: {
      listDefinitions: () => [
        {
          type: 'function',
          name: 'get_sales_summary',
          description: 'Get sales summary',
          parameters: { type: 'object', properties: {}, additionalProperties: false },
        },
      ],
      execute: async () => ({ data: { total: 100 }, summary: 'ok' }),
    },
  });

  const result = await provider.generate({
    message: 'Show sales',
    contextDocuments: [],
  });

  assert.equal(result.answer, 'Done');
  assert.deepEqual(requests[0].include, ['reasoning.encrypted_content']);
  assert.deepEqual(requests[1].include, ['reasoning.encrypted_content']);
  assert.equal('previous_response_id' in requests[1], false);
  assert.equal(requests[1].store, false);
  assert.equal(
    requests[1].input.some((item) => item.type === 'reasoning' && item.encrypted_content === 'encrypted-reasoning'),
    true
  );
});
