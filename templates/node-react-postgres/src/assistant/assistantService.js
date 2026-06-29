import {
  createAssistantService,
  createPostgresAssistantRepository,
  readAssistantConfig,
} from '@oninova/personal-software-assistant';
import { createProjectToolRegistry } from './toolRegistry.js';
import { createProjectContextSources } from './contextSources.js';
import { createProjectPageRegistry } from './pageRegistry.js';
import { createProjectAuditLogger } from './auditLogger.js';

export const createProjectAssistantService = ({
  pool,
  appName = 'Project Name',
  auditLogger = createProjectAuditLogger(),
} = {}) => {
  if (!pool?.query) {
    throw new Error('createProjectAssistantService requires a PostgreSQL pool/client');
  }

  return createAssistantService({
    repository: createPostgresAssistantRepository({ pool }),
    toolRegistry: createProjectToolRegistry({ pool }),
    contextSources: createProjectContextSources(),
    pageRegistry: createProjectPageRegistry(),
    fallbackRoute: '/dashboard',
    config: readAssistantConfig(process.env),
    appName,
    auditLogger,
  });
};
