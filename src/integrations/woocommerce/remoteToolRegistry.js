import { createWooCommerceAssistantSignature } from './hmac.js';

const normalizeDefinitions = (toolDefinitions = []) => {
  if (!Array.isArray(toolDefinitions)) {
    return [];
  }

  return toolDefinitions.filter((tool) => tool?.name && tool?.type === 'function');
};

const parsePayload = async (response) => {
  const text = await response.text();
  if (!text) {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch {
    return { data: text };
  }
};

export const createRemoteWooCommerceToolRegistry = ({
  toolDefinitions = [],
  callback,
  fetchImpl = globalThis.fetch,
}) => {
  const definitions = normalizeDefinitions(toolDefinitions);
  const toolsByName = new Map(definitions.map((tool) => [tool.name, tool]));

  if (!callback?.toolsRunUrl) {
    throw new Error('WooCommerce assistant callback.toolsRunUrl is required');
  }

  if (!callback?.siteId || !callback?.siteSecret) {
    throw new Error('WooCommerce assistant callback.siteId and callback.siteSecret are required');
  }

  if (typeof fetchImpl !== 'function') {
    throw new Error('A fetch implementation is required for remote WooCommerce tools');
  }

  return {
    listDefinitions: () => definitions,
    hasTool: (name) => toolsByName.has(name),
    async execute(name, args = {}) {
      if (!toolsByName.has(name)) {
        const error = new Error(`Unknown WooCommerce assistant tool: ${name}`);
        error.status = 400;
        throw error;
      }

      const body = JSON.stringify({ toolName: name, args: args || {} });
      const { headers } = createWooCommerceAssistantSignature({
        body,
        siteId: callback.siteId,
        secret: callback.siteSecret,
      });

      const response = await fetchImpl(callback.toolsRunUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...headers,
        },
        body,
      });
      const payload = await parsePayload(response);

      if (!response.ok) {
        const error = new Error(payload?.message || payload?.error || 'WooCommerce tool request failed');
        error.status = response.status;
        error.payload = payload;
        throw error;
      }

      return {
        data: payload.data ?? payload,
        summary: payload.summary || 'WooCommerce data returned',
      };
    },
  };
};
