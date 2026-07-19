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

const userRoles = (user) => {
  const roles = [];
  if (user?.role) roles.push(user.role);
  if (Array.isArray(user?.roles)) roles.push(...user.roles);
  return roles.map((role) => String(role || '').trim()).filter(Boolean);
};

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
    ...(tool.strict === true ? { strict: true } : {}),
  };
};

const normalizeCapability = (tool, definition) => ({
  mode: 'read',
  name: definition.name,
  title: String(tool.title || definition.name).trim(),
  description: definition.description,
  resource: String(tool.resource || 'business_data').trim(),
  risk: 'low',
  requiredRoles: (tool.requiredRoles || []).map((role) => String(role || '').trim()).filter(Boolean),
});

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
      capability: normalizeCapability(tool, definition),
      authorize: typeof tool.authorize === 'function' ? tool.authorize : null,
    });
  }

  return {
    listDefinitions: () => definitions.map(cloneJson),
    listCapabilities: () => definitions.map((definition) => cloneJson(handlers.get(definition.name).capability)),
    hasTool: (name) => handlers.has(name),
    async execute(name, args = {}, context = {}) {
      const tool = handlers.get(name);
      if (!tool) {
        const error = new Error(`Unknown assistant tool: ${name}`);
        error.status = 400;
        throw error;
      }

      const requiredRoles = new Set(tool.capability.requiredRoles);
      if (requiredRoles.size > 0 && !userRoles(context.user).some((role) => requiredRoles.has(role))) {
        const error = new Error('You are not authorized to use this assistant tool');
        error.status = 403;
        throw error;
      }

      if (tool.authorize) {
        const authorized = await tool.authorize({ args: args || {}, ...context });
        if (authorized === false) {
          const error = new Error('You are not authorized to use this assistant tool');
          error.status = 403;
          throw error;
        }
      }

      const result = await tool.handler(args || {}, context);
      return normalizeToolResult(result, tool.summary);
    },
  };
};
