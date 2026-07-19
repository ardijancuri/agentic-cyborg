import { readAssistantConfig } from '../../core/config.js';
import { buildUnavailableAssistantMessage } from '../../core/promptBuilder.js';
import { OpenAIResponsesProvider } from '../../providers/OpenAIResponsesProvider.js';
import { createRemoteWooCommerceToolRegistry } from './remoteToolRegistry.js';
import { getHeaderValue, verifyWooCommerceAssistantSignature } from './hmac.js';
import {
  filterWooCommerceToolDefinitions,
  filterWooCommerceWriteActions,
} from './capabilities.js';

const asArray = (value) => Array.isArray(value) ? value : [];

const asString = (value, fallback = '') => {
  if (typeof value === 'string') {
    return value.trim();
  }

  if (value === null || value === undefined) {
    return fallback;
  }

  return String(value).trim();
};

const normalizeConversationMessages = (messages = []) => {
  return asArray(messages)
    .filter((message) => ['user', 'assistant'].includes(message?.role) && message?.content)
    .slice(-12)
    .map((message) => ({
      role: message.role,
      content: String(message.content),
    }));
};

export class WooCommerceAssistantRunner {
  constructor({
    config = readAssistantConfig(),
    providerFactory = null,
    fetchImpl = globalThis.fetch,
    getSiteSecret = null,
  } = {}) {
    this.config = config;
    this.providerFactory = providerFactory;
    this.fetchImpl = fetchImpl;
    this.getSiteSecret = getSiteSecret;
  }

  getStatus() {
    return {
      enabled: this.config.enabled,
      provider: this.config.provider,
      model: this.config.model,
      configured: this.config.configured,
      hasApiKey: this.config.hasApiKey,
    };
  }

  createProvider({ toolRegistry, pageRegistry, fallbackRoute }) {
    if (this.providerFactory) {
      return this.providerFactory({
        config: this.config,
        toolRegistry,
        pageRegistry,
        fallbackRoute,
      });
    }

    return new OpenAIResponsesProvider({
      config: this.config,
      toolRegistry,
      draftActionOptions: {
        pageRegistry,
        fallbackRoute,
      },
    });
  }

  async run(payload = {}) {
    const message = asString(payload.message);
    if (!message) {
      const error = new Error('Message is required');
      error.status = 400;
      throw error;
    }

    if (!this.config.configured) {
      return {
        status: this.getStatus(),
        answer: buildUnavailableAssistantMessage(this.config),
        citations: [],
        draftActions: [],
        charts: [],
        toolRuns: [],
      };
    }

    const pageRegistry = asArray(payload.pageRegistry);
    const fallbackRoute = asString(payload.fallbackRoute, 'admin.php?page=wc-admin');
    const callback = { ...(payload.callback || {}) };
    if (!callback.siteSecret && this.getSiteSecret) {
      callback.siteSecret = await this.getSiteSecret(callback.siteId, payload);
    }

    const toolDefinitions = filterWooCommerceToolDefinitions(payload.toolDefinitions);
    const writeActions = filterWooCommerceWriteActions(payload.writeActions);
    const toolRegistry = createRemoteWooCommerceToolRegistry({
      toolDefinitions,
      callback,
      fetchImpl: this.fetchImpl,
    });
    const provider = this.createProvider({ toolRegistry, pageRegistry, fallbackRoute });
    const result = await provider.generate({
      message,
      contextDocuments: asArray(payload.contextDocuments),
      conversationMessages: normalizeConversationMessages(payload.conversationMessages),
      locale: asString(payload.locale, 'en'),
      appName: payload.site?.name ? `WooCommerce store: ${payload.site.name}` : 'WooCommerce store',
      extraInstructions: [
        'This host is WordPress WooCommerce running inside wp-admin.',
        'For statistics, product/category comparisons, order trends, and performance answers, include up to two compact charts in charts[] when numeric data is available.',
        'For price changes, propose only registered price actions after product or variation id, current price, price field, operation, and currency are known from tools/context.',
        'For itemized bulk price changes, list every affected product or variation with productId, currentPrice, operation, currency, and priceField. Keep bulk drafts bounded and review-required.',
        'For category-wide price changes, do not ask for individual product ids when a category is named. Use get_product_categories and find_products_by_category when useful, then propose bulk_update_woocommerce_category_product_prices with categoryId/categorySlug/categoryName, priceField, operation, currency, reason, includeVariations, and maxItems.',
        'For product detail changes, use only fields exposed in the registered action schema, including approved catalog, taxonomy, measurement, tax, menu-order, and virtual fields.',
        'For inventory changes, propose only the registered single, explicit-bulk, or category inventory actions. Include current values for explicit products and never guess stock quantities.',
        'Never propose order status, customer, coupon, destructive product deletion, or sale schedule writes.',
      ],
      pageRegistry,
      fallbackRoute,
      writeActions,
      requestContext: {
        site: payload.site || {},
      },
    });

    return {
      status: this.getStatus(),
      answer: result.answer,
      citations: result.citations,
      draftActions: result.draftActions,
      charts: result.charts || [],
      toolRuns: result.toolRuns,
      providerResponseId: result.providerResponseId,
    };
  }
}

export const createWooCommerceAssistantRunner = (options) => new WooCommerceAssistantRunner(options);

export const createWooCommerceAssistantServiceRouter = ({
  express,
  runner = null,
  getSiteSecret = null,
  requireSignature = false,
} = {}) => {
  if (!express?.Router) {
    throw new Error('createWooCommerceAssistantServiceRouter requires the express module');
  }

  const router = express.Router();
  const assistantRunner = runner || createWooCommerceAssistantRunner({ getSiteSecret });

  router.post('/v1/woocommerce/run', async (req, res, next) => {
    try {
      if (requireSignature || getSiteSecret) {
        const rawBody = req.rawBody || JSON.stringify(req.body || {});
        const siteId = getHeaderValue(req.headers, 'x-oninova-assistant-site');
        const secret = typeof getSiteSecret === 'function'
          ? await getSiteSecret(siteId, req)
          : null;

        if (!verifyWooCommerceAssistantSignature({ body: rawBody, headers: req.headers, secret })) {
          return res.status(401).json({ error: 'Invalid WooCommerce assistant signature' });
        }
      }

      res.json(await assistantRunner.run(req.body || {}));
    } catch (error) {
      next(error);
    }
  });

  return router;
};
