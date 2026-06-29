import { readAssistantConfig } from '../../core/config.js';
import { buildUnavailableAssistantMessage } from '../../core/promptBuilder.js';
import { OpenAIResponsesProvider } from '../../providers/OpenAIResponsesProvider.js';
import { createRemoteWooCommerceToolRegistry } from './remoteToolRegistry.js';
import { getHeaderValue, verifyWooCommerceAssistantSignature } from './hmac.js';

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
        toolRuns: [],
      };
    }

    const pageRegistry = asArray(payload.pageRegistry);
    const fallbackRoute = asString(payload.fallbackRoute, 'admin.php?page=wc-admin');
    const callback = { ...(payload.callback || {}) };
    if (!callback.siteSecret && this.getSiteSecret) {
      callback.siteSecret = await this.getSiteSecret(callback.siteId, payload);
    }

    const toolRegistry = createRemoteWooCommerceToolRegistry({
      toolDefinitions: payload.toolDefinitions,
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
        'For price changes, only propose update_woocommerce_product_price draft actions when the product or variation id and current price are known from tools/context.',
        'Never propose stock, order status, customer, coupon, or sale schedule writes in WooCommerce V1.',
      ],
      pageRegistry,
      fallbackRoute,
      writeActions: asArray(payload.writeActions),
      requestContext: {
        site: payload.site || {},
      },
    });

    return {
      status: this.getStatus(),
      answer: result.answer,
      citations: result.citations,
      draftActions: result.draftActions,
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
