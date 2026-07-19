import test from 'node:test';
import assert from 'node:assert/strict';
import { readAssistantConfig } from '../src/core/config.js';
import { validateDraftActions } from '../src/core/draftActions.js';
import { validateAssistantCharts } from '../src/core/charts.js';
import { buildSystemPrompt, buildUnavailableAssistantMessage } from '../src/core/promptBuilder.js';
import { resolveDraftActionRoute } from '../src/core/pageRegistry.js';
import { refreshAssistantContext, createStaticContextSource } from '../src/context/contextRefresh.js';
import { AssistantService } from '../src/core/AssistantService.js';
import { createWriteActionRegistry } from '../src/core/writeActionRegistry.js';
import { createAssistantCapabilityHarness } from '../src/core/capabilityHarness.js';
import {
  calculateProductPrice,
  createActionPreviewFingerprint,
  normalizeBulkLimit,
  normalizePriceMutation,
} from '../src/products/productMutations.js';
import { OpenAIResponsesProvider } from '../src/providers/OpenAIResponsesProvider.js';
import { createReadOnlyToolRegistry, clampToolLimit } from '../src/adapters/readOnlyToolRegistry.js';
import { createAssistantRoleAuthorize } from '../src/integrations/express/roleAccess.js';
import { createRemoteWooCommerceToolRegistry } from '../src/integrations/woocommerce/remoteToolRegistry.js';
import { WooCommerceAssistantRunner } from '../src/integrations/woocommerce/WooCommerceAssistantRunner.js';
import {
  filterWooCommerceToolDefinitions,
  filterWooCommerceWriteActions,
} from '../src/integrations/woocommerce/capabilities.js';
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
    actionTypes: [
      'update_woocommerce_product_price',
      'bulk_update_woocommerce_product_prices',
      'bulk_update_woocommerce_category_product_prices',
      'update_woocommerce_product_details',
      'bulk_update_woocommerce_product_details',
      'bulk_update_woocommerce_category_product_details',
    ],
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
  assert.equal(config.maxBulkItems, 100);
  assert.equal(config.actionPreviewLimit, 20);
});

test('product price mutations support reviewed set, percentage, fixed, and clear operations', () => {
  const decrease = normalizePriceMutation({
    priceField: 'price',
    operation: 'decrease_percent',
    percent: 10,
  });
  assert.equal(calculateProductPrice({ currentPrice: 100, regularPrice: 100, mutation: decrease }), 90);

  const increase = normalizePriceMutation({
    priceField: 'price',
    operation: 'increase_fixed',
    amount: 12.5,
  });
  assert.equal(calculateProductPrice({ currentPrice: 100, regularPrice: 100, mutation: increase }), 112.5);

  const clear = normalizePriceMutation({ priceField: 'sale_price', operation: 'clear' });
  assert.equal(calculateProductPrice({ currentPrice: 80, regularPrice: 100, mutation: clear }), null);
  assert.equal(normalizeBulkLimit(1000, 50, 100), 100);
  assert.equal(
    createActionPreviewFingerprint([{ id: 1, value: 2 }]),
    createActionPreviewFingerprint([{ value: 2, id: 1 }])
  );
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
  assert.match(prompt, /server generates a fresh preview/i);
  assert.match(prompt, /instead of asking the user to manually list product ids/i);
  assert.match(prompt, /Never guess a product id/i);
  assert.match(prompt, /include up to two compact charts/i);
});

test('assistant charts are bounded and numeric', () => {
  const charts = validateAssistantCharts([
    {
      type: 'bar',
      title: 'Top products',
      unit: 'orders',
      labels: ['A', 'B'],
      datasets: [{ label: 'Orders', data: [10, 5] }],
    },
    {
      type: 'line',
      title: 'Bad data',
      labels: ['A'],
      datasets: [{ label: 'Orders', data: ['not-a-number'] }],
    },
    {
      type: 'donut',
      title: 'Ignored third chart',
      labels: ['A'],
      datasets: [{ label: 'Orders', data: [1] }],
    },
  ]);

  assert.equal(charts.length, 1);
  assert.equal(charts[0].type, 'bar');
  assert.deepEqual(charts[0].datasets[0].data, [10, 5]);
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

test('bulk product price draft actions are review-only and route-clamped', () => {
  const actions = validateDraftActions([
    {
      type: 'bulk_update_woocommerce_product_prices',
      title: 'Bulk update sale prices',
      reason: 'The owner requested a reviewed sale price update for selected products.',
      targetRoute: '/invented-products',
      payload: {
        priceField: 'sale_price',
        currency: 'EUR',
        reason: 'Seasonal sale',
        items: [
          { productId: 10, variationId: null, currentPrice: '', newPrice: '80.00' },
          { productId: 11, variationId: 21, currentPrice: '90.00', newPrice: '70.00' },
        ],
      },
      confidence: 0.88,
      requiresUserReview: false,
      status: 'applied',
    },
    {
      type: 'bulk_update_product_prices',
      title: 'Bulk update CRM prices',
      reason: 'The owner requested reviewed stock item price updates.',
      targetRoute: '/missing-stock',
      payload: {
        currency: 'MKD',
        items: [{ stockItemId: 'stock-1', currentPrice: 100, newPrice: 120 }],
      },
      confidence: 0.8,
    },
    {
      type: 'bulk_update_woocommerce_category_product_prices',
      title: 'Clear category sale prices',
      reason: 'The owner requested a reviewed sale price removal for one category.',
      targetRoute: '/wrong-category-route',
      payload: {
        categoryName: 'Tekstil',
        priceField: 'sale_price',
        operation: 'clear_sale_price',
        currency: 'EUR',
        includeVariations: true,
        maxItems: 100,
        reason: 'Owner requested sale price removal',
      },
      confidence: 0.86,
      requiresUserReview: false,
      status: 'applied',
    },
  ], {
    pageRegistry: [
      ...TEST_PAGE_REGISTRY,
      {
        id: 'stock_bulk',
        label: 'Stock',
        route: '/stock',
        actionTypes: ['bulk_update_product_prices'],
        keywords: ['stock'],
      },
    ],
    fallbackRoute: '/dashboard',
  });

  assert.equal(actions.length, 3);
  assert.equal(actions[0].type, 'bulk_update_woocommerce_product_prices');
  assert.equal(actions[0].targetRoute, '/wp-admin/edit.php?post_type=product');
  assert.equal(actions[0].requiresUserReview, true);
  assert.equal(actions[0].status, 'draft');
  assert.equal(actions[0].payload.items.length, 2);
  assert.equal(actions[1].type, 'bulk_update_product_prices');
  assert.equal(actions[1].targetRoute, '/stock');
  assert.equal(actions[2].type, 'bulk_update_woocommerce_category_product_prices');
  assert.equal(actions[2].targetRoute, '/wp-admin/edit.php?post_type=product');
  assert.equal(actions[2].status, 'draft');
  assert.equal(actions[2].requiresUserReview, true);
});

test('product detail draft actions are review-only and route-clamped', () => {
  const actions = validateDraftActions([
    {
      type: 'bulk_update_woocommerce_category_product_details',
      title: 'Bulk update product visibility',
      reason: 'Owner requested a reviewed category product detail update.',
      targetRoute: '/bad-route',
      payload: {
        categoryName: 'Tekstil',
        fields: { status: 'draft' },
        includeVariations: false,
        maxItems: 100,
        reason: 'Seasonal cleanup',
      },
      confidence: 0.8,
      requiresUserReview: false,
      status: 'applied',
    },
    {
      type: 'bulk_update_product_details_by_category',
      title: 'Bulk update generic product details',
      reason: 'Owner requested a reviewed category detail update.',
      targetRoute: '/wrong',
      payload: {
        categoryId: 'cat-1',
        fields: { status: 'draft' },
        maxItems: 50,
      },
      confidence: 0.7,
    },
  ], {
    pageRegistry: [
      ...TEST_PAGE_REGISTRY,
      {
        id: 'products',
        label: 'Products',
        route: '/products',
        actionTypes: ['bulk_update_product_details_by_category'],
        keywords: ['products'],
      },
    ],
    fallbackRoute: '/dashboard',
  });

  assert.equal(actions.length, 2);
  assert.equal(actions[0].type, 'bulk_update_woocommerce_category_product_details');
  assert.equal(actions[0].targetRoute, '/wp-admin/edit.php?post_type=product');
  assert.equal(actions[0].requiresUserReview, true);
  assert.equal(actions[0].status, 'draft');
  assert.equal(actions[1].type, 'bulk_update_product_details_by_category');
  assert.equal(actions[1].targetRoute, '/products');
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

test('read-only tool capabilities enforce configured roles', async () => {
  const registry = createReadOnlyToolRegistry({
    tools: [{
      name: 'get_sensitive_margin',
      description: 'Read margin data',
      resource: 'finance',
      requiredRoles: ['full_admin'],
      handler: async () => ({ margin: 42 }),
    }],
  });

  assert.equal(registry.listCapabilities()[0].resource, 'finance');
  await assert.rejects(
    () => registry.execute('get_sensitive_margin', {}, { user: { role: 'admin' } }),
    /not authorized/
  );
  const result = await registry.execute('get_sensitive_margin', {}, { user: { role: 'full_admin' } });
  assert.equal(result.data.margin, 42);
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

test('write action registry apply remains usable when detached from the registry object', async () => {
  const registry = createWriteActionRegistry({
    actions: [
      {
        type: 'update_product_price',
        requiredRoles: ['full_admin'],
        apply: async ({ payload }) => ({ updated: payload.productId }),
      },
    ],
  });
  const { apply } = registry;

  const result = await apply(
    { type: 'update_product_price', payload: { productId: 'product-1' } },
    { user: { role: 'full_admin' } }
  );

  assert.deepEqual(result, { updated: 'product-1' });
});

test('capability harness exposes bounded reviewed previews and decorated actions', async () => {
  const toolRegistry = createReadOnlyToolRegistry({
    tools: [{ name: 'find_products', handler: async () => ({ products: [] }) }],
  });
  const writeActionRegistry = createWriteActionRegistry({
    actions: [{
      type: 'bulk_update_product_inventory',
      title: 'Update inventory',
      resource: 'inventory',
      scope: 'selection',
      risk: 'high',
      maxBatchSize: 2,
      requiredRoles: ['full_admin'],
      preview: async ({ action }) => ({
        summary: 'Two inventory rows will change',
        affectedCount: action.payload.items.length,
        changes: action.payload.items,
      }),
      apply: async ({ preview }) => ({ updatedCount: preview.affectedCount }),
    }],
  });
  const harness = createAssistantCapabilityHarness({ toolRegistry, writeActionRegistry });
  const action = {
    id: 'action-1',
    type: 'bulk_update_product_inventory',
    payload: { items: [{ productId: '1' }, { productId: '2' }] },
  };

  assert.equal(harness.listCapabilities().read[0].name, 'find_products');
  assert.equal(harness.listCapabilities().write[0].maxBatchSize, 2);
  assert.equal(harness.decorateDraftAction(action).metadata.capability.mode, 'write');
  const preview = await harness.previewWriteAction(action, { user: { role: 'full_admin' } });
  assert.equal(preview.affectedCount, 2);
  const execution = await harness.executeWriteAction(action, { user: { role: 'full_admin' } });
  assert.equal(execution.result.updatedCount, 2);

  await assert.rejects(
    () => harness.previewWriteAction({ ...action, payload: { items: [{}, {}, {}] } }, { user: { role: 'full_admin' } }),
    /above the 2 record limit/
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

test('assistant service previews and atomically claims reviewed write actions', async () => {
  const action = {
    id: 'action-2',
    conversation_id: 'conversation-1',
    type: 'update_product_inventory',
    title: 'Update inventory',
    reason: 'Owner requested it',
    target_route: '/inventory',
    payload: { productId: 'product-1', fields: { quantity: 8 } },
    confidence: 0.9,
    requires_user_review: true,
    status: 'draft',
    metadata: {},
  };
  const transitions = [];
  const updates = [];
  const registry = createWriteActionRegistry({
    actions: [{
      type: 'update_product_inventory',
      resource: 'inventory',
      requiredRoles: ['full_admin'],
      preview: async () => ({
        summary: 'One inventory row will change',
        affectedCount: 1,
        changes: [{ productId: 'product-1', oldValues: { quantity: 5 }, newValues: { quantity: 8 } }],
      }),
      apply: async () => ({ updatedCount: 1 }),
    }],
  });
  const service = new AssistantService({
    repository: {
      async getDraftActionForUser() { return action; },
      async transitionDraftActionStatus(update) {
        transitions.push(update);
        return { ...action, status: update.status, metadata: update.metadata };
      },
      async updateDraftActionStatus(update) {
        updates.push(update);
        return { ...action, status: update.status, metadata: update.metadata };
      },
    },
    config: readAssistantConfig({ ASSISTANT_PROVIDER: 'openai' }),
    toolRegistry: createReadOnlyToolRegistry({ tools: [] }),
    writeActionRegistry: registry,
  });
  const user = { id: 'user-1', role: 'full_admin' };

  const preview = await service.previewDraftAction({ actionId: action.id, user });
  assert.equal(preview.preview.affectedCount, 1);
  assert.equal(preview.capability.resource, 'inventory');

  const applied = await service.applyDraftAction({ actionId: action.id, user });
  assert.equal(transitions[0].status, 'applying');
  assert.equal(updates[0].status, 'applied');
  assert.equal(applied.draftAction.metadata.preview.affectedCount, 1);
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
        output_text: JSON.stringify({
          answer: 'Done',
          citations: [],
          draftActions: [],
          charts: [
            {
              type: 'bar',
              title: 'Sales',
              labels: ['This month'],
              datasets: [{ label: 'Revenue', data: [100] }],
            },
          ],
        }),
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
  assert.equal(result.charts.length, 1);
  assert.equal(result.charts[0].title, 'Sales');
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

test('woocommerce capability filters reject site-supplied unknown tools and writes', () => {
  const tools = filterWooCommerceToolDefinitions([
    { type: 'function', name: 'find_products', parameters: { type: 'object' } },
    { type: 'function', name: 'run_sql', parameters: { type: 'object' } },
  ]);
  const writes = filterWooCommerceWriteActions([
    { type: 'bulk_update_woocommerce_category_product_inventory', maxBatchSize: 999 },
    { type: 'delete_all_products' },
  ]);

  assert.deepEqual(tools.map((tool) => tool.name), ['find_products']);
  assert.deepEqual(writes.map((action) => action.type), ['bulk_update_woocommerce_category_product_inventory']);
  assert.equal(writes[0].maxBatchSize, 100);
  assert.equal(writes[0].requiresReview, true);
  assert.equal(writes[0].resource, 'inventory');
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
      assert.equal(this.toolRegistry.hasTool('get_product_categories'), true);
      assert.equal(this.toolRegistry.hasTool('find_products_by_category'), true);
      assert.equal(input.writeActions[0].type, 'update_woocommerce_product_price');
      assert.equal(input.writeActions[1].type, 'bulk_update_woocommerce_product_prices');
      assert.equal(input.writeActions[2].type, 'bulk_update_woocommerce_category_product_prices');
      assert.equal(input.writeActions[3].type, 'bulk_update_woocommerce_category_product_inventory');
      assert.equal(this.toolRegistry.hasTool('run_sql'), false);
      assert.equal(input.pageRegistry[0].route, '/wp-admin/edit.php?post_type=product');
      assert.equal(input.extraInstructions.some((instruction) => /do not ask for individual product ids/i.test(instruction)), true);
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
      {
        type: 'function',
        name: 'get_product_categories',
        description: 'Find categories',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
      },
      {
        type: 'function',
        name: 'find_products_by_category',
        description: 'Find products by category',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
      },
      {
        type: 'function',
        name: 'run_sql',
        description: 'Must be rejected',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
      },
    ],
    callback: {
      toolsRunUrl: 'https://store.example/wp-json/oninova-assistant/v1/tools/run',
      siteId: 'site-1',
    },
    writeActions: [
      { type: 'update_woocommerce_product_price' },
      { type: 'bulk_update_woocommerce_product_prices' },
      { type: 'bulk_update_woocommerce_category_product_prices' },
      { type: 'bulk_update_woocommerce_category_product_inventory', maxBatchSize: 999 },
      { type: 'delete_all_products' },
    ],
    pageRegistry: [{ id: 'products', route: '/wp-admin/edit.php?post_type=product' }],
  });

  assert.equal(result.answer, 'Done');
  assert.equal(result.providerResponseId, 'resp-test');
});
