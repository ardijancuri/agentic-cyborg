const ACTION_RISKS = new Set(['low', 'medium', 'high']);
const ACTION_SCOPES = new Set(['single', 'selection', 'category', 'filter']);

const normalizeRole = (role) => String(role || '').trim();

const userRoles = (user) => {
  const roles = [];

  if (user?.role) {
    roles.push(user.role);
  }

  if (Array.isArray(user?.roles)) {
    roles.push(...user.roles);
  }

  return roles.map(normalizeRole).filter(Boolean);
};

const asPositiveInteger = (value, fallback, max = 500) => {
  const numeric = Number.parseInt(value, 10);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }

  return Math.max(1, Math.min(numeric, max));
};

const cloneJson = (value) => JSON.parse(JSON.stringify(value));

const normalizeActionDefinition = (action) => {
  const type = String(action.type || '').trim();
  if (!type) {
    throw new Error('Write action requires a type');
  }

  if (typeof action.apply !== 'function') {
    throw new Error(`Write action ${type} requires an apply() handler`);
  }

  const scope = ACTION_SCOPES.has(action.scope) ? action.scope : 'single';
  const defaultBatchSize = scope === 'single' ? 1 : 50;

  return {
    type,
    handlerName: String(action.handlerName || action.name || type).trim(),
    title: String(action.title || type).trim(),
    description: String(action.description || '').trim(),
    resource: String(action.resource || 'business_record').trim(),
    scope,
    risk: ACTION_RISKS.has(action.risk) ? action.risk : (scope === 'single' ? 'medium' : 'high'),
    requiredRoles: (action.requiredRoles || ['full_admin']).map(normalizeRole).filter(Boolean),
    requiresReview: true,
    maxBatchSize: asPositiveInteger(action.maxBatchSize, defaultBatchSize),
    payloadSchema: action.payloadSchema || null,
    authorize: typeof action.authorize === 'function' ? action.authorize : null,
    validate: typeof action.validate === 'function' ? action.validate : null,
    preview: typeof action.preview === 'function' ? action.preview : null,
    apply: action.apply,
  };
};

const publicDefinition = (definition) => ({
  type: definition.type,
  handlerName: definition.handlerName,
  title: definition.title,
  description: definition.description,
  mode: 'write',
  resource: definition.resource,
  scope: definition.scope,
  risk: definition.risk,
  requiredRoles: [...definition.requiredRoles],
  requiresReview: true,
  maxBatchSize: definition.maxBatchSize,
  supportsPreview: true,
  payloadSchema: definition.payloadSchema ? cloneJson(definition.payloadSchema) : null,
});

const assertAuthorized = async (definition, action, context) => {
  const allowedRoles = new Set(definition.requiredRoles);
  const hasRole = allowedRoles.size === 0
    || userRoles(context.user).some((role) => allowedRoles.has(role));

  if (!hasRole) {
    const error = new Error('Only authorized users can apply this assistant action');
    error.status = 403;
    throw error;
  }

  if (definition.authorize) {
    const authorized = await definition.authorize({
      action,
      user: context.user,
      requestContext: context.requestContext || {},
    });
    if (authorized === false) {
      const error = new Error('This assistant action is not authorized for the current user');
      error.status = 403;
      throw error;
    }
  }
};

const inferPreview = (definition, action) => {
  const items = Array.isArray(action?.payload?.items) ? action.payload.items : [];
  const affectedCount = items.length || (definition.scope === 'single' ? 1 : 0);

  return {
    summary: definition.title,
    affectedCount,
    items: items.slice(0, 20),
    changes: [],
    warnings: definition.preview
      ? []
      : ['The host adapter did not provide a detailed preview for this action.'],
  };
};

const normalizePreview = (definition, preview = {}) => {
  const affectedCount = Math.max(0, Number.parseInt(preview.affectedCount, 10) || 0);
  if (affectedCount > definition.maxBatchSize) {
    const error = new Error(
      `Action affects ${affectedCount} records, above the ${definition.maxBatchSize} record limit`
    );
    error.status = 400;
    throw error;
  }

  return {
    actionType: definition.type,
    resource: definition.resource,
    scope: definition.scope,
    risk: definition.risk,
    requiresUserReview: true,
    maxBatchSize: definition.maxBatchSize,
    summary: String(preview.summary || definition.title),
    affectedCount,
    truncated: Boolean(preview.truncated),
    items: Array.isArray(preview.items) ? preview.items.slice(0, 20) : [],
    changes: Array.isArray(preview.changes) ? preview.changes.slice(0, 20) : [],
    warnings: Array.isArray(preview.warnings) ? preview.warnings.slice(0, 10) : [],
    fingerprint: preview.fingerprint ? String(preview.fingerprint) : null,
  };
};

export const createWriteActionRegistry = ({ actions = [] } = {}) => {
  const definitions = actions.map(normalizeActionDefinition);
  const handlers = new Map();

  for (const definition of definitions) {
    if (handlers.has(definition.type)) {
      throw new Error(`Duplicate assistant write action: ${definition.type}`);
    }
    handlers.set(definition.type, definition);
  }

  const getDefinition = (type) => {
    const definition = handlers.get(type);
    if (!definition) {
      const error = new Error(`Unsupported assistant write action: ${type || 'unknown'}`);
      error.status = 400;
      throw error;
    }
    return definition;
  };

  const prepare = async (action, context = {}) => {
    const definition = getDefinition(action?.type);
    await assertAuthorized(definition, action, context);

    let preparedAction = action;
    if (definition.validate) {
      const payload = await definition.validate({
        action,
        payload: action?.payload || {},
        user: context.user,
        requestContext: context.requestContext || {},
      });
      if (payload !== undefined) {
        preparedAction = { ...action, payload };
      }
    }

    const previewResult = definition.preview
      ? await definition.preview({
        action: preparedAction,
        payload: preparedAction?.payload || {},
        user: context.user,
        requestContext: context.requestContext || {},
      })
      : inferPreview(definition, preparedAction);

    return {
      definition,
      action: preparedAction,
      preview: normalizePreview(definition, previewResult),
    };
  };

  const execute = async (action, context = {}) => {
    const prepared = await prepare(action, context);
    const result = await prepared.definition.apply({
      action: prepared.action,
      payload: prepared.action?.payload || {},
      preview: prepared.preview,
      user: context.user,
      requestContext: context.requestContext || {},
    });

    return {
      result,
      preview: prepared.preview,
      capability: publicDefinition(prepared.definition),
    };
  };

  return {
    hasAction: (type) => handlers.has(type),
    listDefinitions: () => definitions.map(publicDefinition),
    getDefinition: (type) => publicDefinition(getDefinition(type)),
    getAllowedTypes: () => definitions.map((definition) => definition.type),
    async assertAuthorized(action, context = {}) {
      const definition = getDefinition(action?.type);
      await assertAuthorized(definition, action, context);
      return publicDefinition(definition);
    },
    decorateAction(action) {
      const definition = handlers.get(action?.type);
      if (!definition) {
        return action;
      }

      return {
        ...action,
        metadata: {
          ...(action.metadata || {}),
          capability: publicDefinition(definition),
        },
      };
    },
    async preview(action, context = {}) {
      const prepared = await prepare(action, context);
      return prepared.preview;
    },
    execute,
    async apply(action, context = {}) {
      return (await execute(action, context)).result;
    },
  };
};

export const formatWriteActionsForPrompt = (writeActions = []) => {
  if (!writeActions.length) {
    return '- none';
  }

  return writeActions
    .map((action) => {
      const payloadSchema = action.payloadSchema
        ? `payload schema: ${JSON.stringify(action.payloadSchema)}`
        : '';
      const details = [
        action.description,
        action.resource ? `resource: ${action.resource}` : '',
        action.scope ? `scope: ${action.scope}` : '',
        action.risk ? `risk: ${action.risk}` : '',
        action.maxBatchSize ? `maximum records: ${action.maxBatchSize}` : '',
        action.handlerName ? `handler: ${action.handlerName}` : '',
        action.requiredRoles?.length ? `requires: ${action.requiredRoles.join(', ')}` : '',
        'requires explicit review and supports a server-generated preview',
        payloadSchema,
      ].filter(Boolean).join('; ');

      return `- ${action.type}${details ? ` (${details})` : ''}`;
    })
    .join('\n');
};
