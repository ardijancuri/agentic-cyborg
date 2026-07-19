import {
  createAssistantService,
  createAssistantCapabilityHarness,
  createPostgresAssistantRepository,
  readAssistantConfig,
} from '@oninova/personal-software-assistant';
import { createProjectToolRegistry } from './toolRegistry.js';
import { createProjectContextSources } from './contextSources.js';
import { createProjectPageRegistry } from './pageRegistry.js';
import { createProjectAuditLogger } from './auditLogger.js';
import { createProjectWriteActionRegistry } from './writeActionRegistry.js';

export const createProjectAssistantService = ({
  pool,
  appName = 'Project Name',
  auditLogger = createProjectAuditLogger(),
  writeRoles = ['full_admin'],
} = {}) => {
  if (!pool?.query) {
    throw new Error('createProjectAssistantService requires a PostgreSQL pool/client');
  }

  const config = readAssistantConfig(process.env);
  const toolRegistry = createProjectToolRegistry({ pool });
  const writeActionRegistry = createProjectWriteActionRegistry({
    pool,
    maxBulkItems: config.maxBulkItems,
    requiredRoles: writeRoles,
  });

  return createAssistantService({
    repository: createPostgresAssistantRepository({ pool }),
    toolRegistry,
    contextSources: createProjectContextSources(),
    pageRegistry: createProjectPageRegistry(),
    writeActionRegistry,
    capabilityHarness: createAssistantCapabilityHarness({ toolRegistry, writeActionRegistry }),
    fallbackRoute: '/dashboard',
    config,
    appName,
    auditLogger,
  });
};
