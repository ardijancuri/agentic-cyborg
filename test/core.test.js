import test from 'node:test';
import assert from 'node:assert/strict';
import { readAssistantConfig } from '../src/core/config.js';
import { validateDraftActions } from '../src/core/draftActions.js';
import { buildSystemPrompt, buildUnavailableAssistantMessage } from '../src/core/promptBuilder.js';
import { resolveDraftActionRoute } from '../src/core/pageRegistry.js';
import { refreshAssistantContext, createStaticContextSource } from '../src/context/contextRefresh.js';
import { AssistantService } from '../src/core/AssistantService.js';
import { createWriteActionRegistry } from '../src/core/writeActionRegistry.js';
import { OpenAIResponsesProvider } from '../src/providers/OpenAIResponsesProvider.js';
import { createReadOnlyToolRegistry, clampToolLimit } from '../src/adapters/readOnlyToolRegistry.js';
import { createAssistantRoleAuthorize } from '../src/integrations/express/roleAccess.js';
import { createRemoteWooCommerceToolRegistry } from '../src/integrations/woocommerce/remoteToolRegistry.js';
import { WooCommerceAssistantRunner } from '../src/integrations/woocommerce/WooCommerceAssistantRunner.js';
import {
  createWooCommerceAssistantSignature,
  verifyWooCommerceAssistantSignature,
} from '../src/integrations/woocommerce/hmac.js';

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
  {
    id: 'wc_products',
    label: 'WooCommerce Products',
    route: '/wp-admin/edit.php?post_type=product',
    actionTypes: ['update_woocommerce_product_price'],
    keywords: ['product', 'price'],
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
  assert.equal(actions[0].status, 'draft');
});

test('model-proposed draft action status is ignored', () => {
  const actions = validateDraftActions([
    {
      type: 'update_product_price',
      title: 'Update product price',
      reason: 'Owner requested a reviewed price update.',
      targetRoute: '/stock',
      payload: { stockItemId: 'item-1', currentPrice: 10, newPrice: 12 },
      confidence: 0.9,
      requiresUserReview: false,
      status: 'applied',
    },
  ], {
    pageRegistry: TEST_PAGE_REGISTRY,
    fallbackRoute: '/dashboard',
  });

  assert.equal(actions.length, 1);
  assert.equal(actions[0].status, 'draft');
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

test('woocommerce draft actions keep registered wp-admin query routes', () => {
  const actions = validateDraftActions([
    {
      type: 'update_woocommerce_product_price',
      title: 'Update product price',
      reason: 'The owner requested a reviewed price change.',
      targetRoute: '/invented',
      payload: {
        productId: 10,
        variationId: null,
        priceField: 'regular_price',
        currentPrice: '100.00',
        newPrice: '120.00',
        currency: 'EUR',
        reason: 'Owner requested price update',
      },
      confidence: 0.9,
    },
  ], {
    pageRegistry: TEST_PAGE_REGISTRY,
    fallbackRoute: '/wp-admin/admin.php?page=wc-admin',
  });

  assert.equal(actions.length, 1);
  assert.equal(actions[0].type, 'update_woocommerce_product_price');
  assert.equal(actions[0].targetRoute, '/wp-admin/edit.php?post_type=product');
  assert.equal(actions[0].status, 'draft');
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

test('assistant service returns controlled error when write registry is missing', async () => {
  const service = new AssistantService({
    repository: {
      async getDraftActionForUser() {
        return { id: 'action-1', type: 'update_product_price', status: 'draft', metadata: {} };
      },
      async updateDraftActionStatus() {
        return null;
      },
    },
    config: readAssistantConfig({ ASSISTANT_PROVIDER: 'openai' }),
    toolRegistry: {
      listDefinitions: () => [],
      execute: async () => ({ data: {}, summary: 'ok' }),
    },
  });

  await assert.rejects(
    () => service.applyDraftAction({ actionId: 'action-1', user: { id: 'user-1', role: 'full_admin' } }),
    /write actions are not configured/
  );
});

test('write action registry blocks non-authorized users', async () => {
  const registry = createWriteActionRegistry({
    actions: [
      {
        type: 'update_product_price',
        apply: async () => ({ ok: true }),
      },
    ],
  });

  await assert.rejects(
    () => registry.apply(
      { id: 'action-1', type: 'update_product_price', payload: {} },
      { user: { id: 'user-1', role: 'admin' } }
    ),
    /Only authorized users/
  );
});

test('assistant service applies write action and updates status', async () => {
  const action = {
    id: 'action-1',
    conversation_id: 'conversation-1',
    type: 'update_product_price',
    title: 'Update price',
    reason: 'Owner requested it',
    target_route: '/stock',
    payload: { stockItemId: 'item-1', currentPrice: 10, newPrice: 12 },
    confidence: 0.9,
    requires_user_review: true,
    status: 'draft',
    metadata: {},
  };
  const statuses = [];
  const service = new AssistantService({
    repository: {
      async getDraftActionForUser() {
        return action;
      },
      async updateDraftActionStatus(update) {
        statuses.push(update);
        return { ...action, status: update.status, metadata: update.metadata };
      },
    },
    config: readAssistantConfig({ ASSISTANT_PROVIDER: 'openai' }),
    toolRegistry: {
      listDefinitions: () => [],
      execute: async () => ({ data: {}, summary: 'ok' }),
    },
    writeActionRegistry: createWriteActionRegistry({
      actions: [
        {
          type: 'update_product_price',
          apply: async ({ action: draftAction }) => ({ updated: draftAction.payload.stockItemId }),
        },
      ],
    }),
  });

  const result = await service.applyDraftAction({
    actionId: 'action-1',
    user: { id: 'user-1', role: 'full_admin' },
  });

  assert.equal(result.draftAction.status, 'applied');
  assert.equal(statuses[0].status, 'applied');
  assert.equal(statuses[0].metadata.applyResult.updated, 'item-1');
});

test('assistant service rejects draft action and updates status', async () => {
  const action = {
    id: 'action-1',
    conversation_id: 'conversation-1',
    type: 'update_product_price',
    title: 'Update price',
    reason: 'Owner requested it',
    target_route: '/stock',
    payload: {},
    confidence: 0.8,
    requires_user_review: true,
    status: 'draft',
    metadata: {},
  };
  const service = new AssistantService({
    repository: {
      async getDraftActionForUser() {
        return action;
      },
      async updateDraftActionStatus(update) {
        return { ...action, status: update.status, metadata: update.metadata };
      },
    },
    config: readAssistantConfig({ ASSISTANT_PROVIDER: 'openai' }),
    toolRegistry: {
      listDefinitions: () => [],
      execute: async () => ({ data: {}, summary: 'ok' }),
    },
  });

  const result = await service.rejectDraftAction({
    actionId: 'action-1',
    user: { id: 'user-1', role: 'admin' },
  });

  assert.equal(result.draftAction.status, 'rejected');
  assert.equal(result.draftAction.metadata.rejectedBy, 'user-1');
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

test('woocommerce hmac signs and verifies request bodies', () => {
  const body = JSON.stringify({ message: 'hello' });
  const signed = createWooCommerceAssistantSignature({
    body,
    siteId: 'site-1',
    secret: 'secret-1',
    timestamp: Math.floor(Date.now() / 1000).toString(),
  });

  assert.equal(
    verifyWooCommerceAssistantSignature({
      body,
      headers: signed.headers,
      secret: 'secret-1',
    }),
    true
  );
  assert.equal(
    verifyWooCommerceAssistantSignature({
      body: JSON.stringify({ message: 'changed' }),
      headers: signed.headers,
      secret: 'secret-1',
    }),
    false
  );
});

test('remote woocommerce tool registry signs approved tool callbacks', async () => {
  const calls = [];
  const registry = createRemoteWooCommerceToolRegistry({
    toolDefinitions: [
      {
        type: 'function',
        name: 'find_products',
        description: 'Find products',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
      },
    ],
    callback: {
      toolsRunUrl: 'https://store.example/wp-json/oninova-assistant/v1/tools/run',
      siteId: 'site-1',
      siteSecret: 'secret-1',
    },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response(JSON.stringify({ data: { products: [] }, summary: 'ok' }), { status: 200 });
    },
  });

  const result = await registry.execute('find_products', { search: 'ring' });

  assert.equal(result.summary, 'ok');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://store.example/wp-json/oninova-assistant/v1/tools/run');
  assert.equal(Boolean(calls[0].options.headers['x-oninova-assistant-signature']), true);

  await assert.rejects(
    () => registry.execute('run_sql', {}),
    /Unknown WooCommerce assistant tool/
  );
});

test('woocommerce runner returns controlled unavailable response without api key', async () => {
  const runner = new WooCommerceAssistantRunner({
    config: readAssistantConfig({ ASSISTANT_ENABLED: 'true', ASSISTANT_PROVIDER: 'openai' }),
  });

  const result = await runner.run({ message: 'Show sales' });

  assert.match(result.answer, /OPENAI_API_KEY/);
  assert.equal(result.draftActions.length, 0);
});

test('woocommerce runner passes remote tools and write actions to provider', async () => {
  class MockProvider {
    constructor({ toolRegistry }) {
      this.toolRegistry = toolRegistry;
    }

    async generate(input) {
      assert.equal(this.toolRegistry.hasTool('find_products'), true);
      assert.equal(input.writeActions[0].type, 'update_woocommerce_product_price');
      assert.equal(input.pageRegistry[0].route, '/wp-admin/edit.php?post_type=product');
      return {
        answer: 'Done',
        citations: [],
        draftActions: [],
        toolRuns: [],
        providerResponseId: 'resp-test',
      };
    }
  }

  const runner = new WooCommerceAssistantRunner({
    config: {
      enabled: true,
      provider: 'openai',
      model: 'gpt-test',
      configured: true,
      hasApiKey: true,
      apiKey: 'test-key',
      maxToolCalls: 1,
    },
    providerFactory: (options) => new MockProvider(options),
    getSiteSecret: async () => 'secret-1',
  });

  const result = await runner.run({
    message: 'Find products',
    toolDefinitions: [
      {
        type: 'function',
        name: 'find_products',
        description: 'Find products',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
      },
    ],
    callback: {
      toolsRunUrl: 'https://store.example/wp-json/oninova-assistant/v1/tools/run',
      siteId: 'site-1',
    },
    writeActions: [{ type: 'update_woocommerce_product_price' }],
    pageRegistry: [{ id: 'products', route: '/wp-admin/edit.php?post_type=product' }],
  });

  assert.equal(result.answer, 'Done');
  assert.equal(result.providerResponseId, 'resp-test');
});
