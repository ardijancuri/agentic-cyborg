const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;

const defaultParameters = {
  type: 'object',
  properties: {},
  additionalProperties: false,
};

const asToolArray = (tools) => {
  if (Array.isArray(tools)) {
    return tools;
  }

  if (!tools || typeof tools !== 'object') {
    return [];
  }

  return Object.entries(tools).map(([name, tool]) => ({ name, ...(tool || {}) }));
};

const cloneJson = (value) => JSON.parse(JSON.stringify(value));

const normalizeToolDefinition = (tool) => {
  const name = String(tool.name || '').trim();
  if (!TOOL_NAME_PATTERN.test(name)) {
    throw new Error(`Invalid assistant tool name: ${name || '<empty>'}`);
  }

  return {
    type: 'function',
    name,
    description: String(tool.description || `${name} read-only business tool`).trim(),
    parameters: tool.parameters || defaultParameters,
  };
};

const normalizeToolResult = (result, fallbackSummary) => {
  if (result && typeof result === 'object' && Object.hasOwn(result, 'data')) {
    return {
      data: result.data,
      summary: result.summary || fallbackSummary,
    };
  }

  return {
    data: result,
    summary: fallbackSummary,
  };
};

export const clampToolLimit = (value, fallback = 10, max = 50) => {
  const numeric = parseInt(value, 10);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }

  return Math.max(1, Math.min(numeric, max));
};

export const createReadOnlyToolRegistry = ({ tools = [], defaultSummary = 'Business data returned' } = {}) => {
  const definitions = [];
  const handlers = new Map();

  for (const tool of asToolArray(tools)) {
    const definition = normalizeToolDefinition(tool);
    const handler = tool.handler || tool.execute;

    if (typeof handler !== 'function') {
      throw new Error(`Assistant tool ${definition.name} requires a handler function`);
    }

    definitions.push(definition);
    handlers.set(definition.name, {
      handler,
      summary: tool.summary || defaultSummary,
    });
  }

  return {
    listDefinitions: () => definitions.map(cloneJson),
    hasTool: (name) => handlers.has(name),
    async execute(name, args = {}, context = {}) {
      const tool = handlers.get(name);
      if (!tool) {
        const error = new Error(`Unknown assistant tool: ${name}`);
        error.status = 400;
        throw error;
      }

      const result = await tool.handler(args || {}, context);
      return normalizeToolResult(result, tool.summary);
    },
  };
};
