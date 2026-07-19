const cloneJson = (value) => JSON.parse(JSON.stringify(value));

const readCapabilities = (toolRegistry) => {
  if (typeof toolRegistry?.listCapabilities === 'function') {
    return toolRegistry.listCapabilities();
  }

  return (toolRegistry?.listDefinitions?.() || []).map((tool) => ({
    mode: 'read',
    name: tool.name,
    title: tool.name,
    description: tool.description || '',
    resource: 'business_data',
    risk: 'low',
  }));
};

export const createAssistantCapabilityHarness = ({
  toolRegistry,
  writeActionRegistry = null,
} = {}) => {
  if (!toolRegistry?.listDefinitions || !toolRegistry?.execute) {
    throw new Error('Assistant capability harness requires a toolRegistry');
  }

  return {
    toolRegistry,
    writeActionRegistry,
    listCapabilities() {
      return {
        read: readCapabilities(toolRegistry).map(cloneJson),
        write: (writeActionRegistry?.listDefinitions?.() || []).map(cloneJson),
      };
    },
    listWriteDefinitions() {
      return writeActionRegistry?.listDefinitions?.() || [];
    },
    getAllowedWriteTypes() {
      return writeActionRegistry?.getAllowedTypes?.()
        || (writeActionRegistry?.listDefinitions?.() || []).map((action) => action.type);
    },
    decorateDraftAction(action) {
      return writeActionRegistry?.decorateAction?.(action) || action;
    },
    async assertCanApply(action, context = {}) {
      if (!writeActionRegistry?.assertAuthorized) {
        const error = new Error('Assistant write actions are not configured');
        error.status = 400;
        throw error;
      }
      return writeActionRegistry.assertAuthorized(action, context);
    },
    async previewWriteAction(action, context = {}) {
      if (!writeActionRegistry?.preview) {
        const error = new Error('Assistant write action previews are not configured');
        error.status = 400;
        throw error;
      }
      return writeActionRegistry.preview(action, context);
    },
    async executeWriteAction(action, context = {}) {
      if (!writeActionRegistry?.execute) {
        const error = new Error('Assistant write actions are not configured');
        error.status = 400;
        throw error;
      }
      return writeActionRegistry.execute(action, context);
    },
  };
};
