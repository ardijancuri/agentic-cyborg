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

const normalizeActionDefinition = (action) => {
  const type = String(action.type || '').trim();
  if (!type) {
    throw new Error('Write action requires a type');
  }

  if (typeof action.apply !== 'function') {
    throw new Error(`Write action ${type} requires an apply() handler`);
  }

  return {
    type,
    handlerName: String(action.handlerName || action.name || type).trim(),
    title: String(action.title || type).trim(),
    description: String(action.description || '').trim(),
    requiredRoles: (action.requiredRoles || ['full_admin']).map(normalizeRole).filter(Boolean),
    payloadSchema: action.payloadSchema || null,
    apply: action.apply,
  };
};

export const createWriteActionRegistry = ({ actions = [] } = {}) => {
  const definitions = actions.map(normalizeActionDefinition);
  const handlers = new Map(definitions.map((action) => [action.type, action]));

  return {
    hasAction: (type) => handlers.has(type),
    listDefinitions: () => definitions.map(({ apply, ...definition }) => definition),
    async apply(action, context = {}) {
      const definition = handlers.get(action?.type);
      if (!definition) {
        const error = new Error(`Unsupported assistant write action: ${action?.type || 'unknown'}`);
        error.status = 400;
        throw error;
      }

      const allowedRoles = new Set(definition.requiredRoles);
      const hasRole = userRoles(context.user).some((role) => allowedRoles.has(role));
      if (!hasRole) {
        const error = new Error('Only authorized users can apply this assistant action');
        error.status = 403;
        throw error;
      }

      return definition.apply({
        action,
        user: context.user,
        requestContext: context.requestContext || {},
      });
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
        action.handlerName ? `handler: ${action.handlerName}` : '',
        action.requiredRoles?.length ? `requires: ${action.requiredRoles.join(', ')}` : '',
        payloadSchema,
      ].filter(Boolean).join('; ');

      return `- ${action.type}${details ? ` (${details})` : ''}`;
    })
    .join('\n');
};
