import crypto from 'crypto';

const hashContent = (content) => crypto.createHash('sha256').update(content).digest('hex');

export const createStaticContextSource = ({ scope, title, content, metadata = {} }) => {
  return async () => [{
    scope,
    title,
    content,
    metadata,
  }];
};

const normalizeDocuments = (documents = []) => {
  return documents.map((doc) => ({
    scope: doc.scope,
    title: doc.title,
    content: doc.content,
    metadata: doc.metadata || {},
    sourceHash: doc.sourceHash || hashContent(doc.content || ''),
  }));
};

export const refreshAssistantContext = async ({
  repository,
  user,
  contextSources = [],
  toolRegistry = null,
}) => {
  if (!repository?.upsertContextDocument) {
    throw new Error('refreshAssistantContext requires a repository with upsertContextDocument()');
  }

  const documents = [];

  for (const source of contextSources) {
    const produced = typeof source === 'function'
      ? await source({ user, toolRegistry })
      : source;

    if (Array.isArray(produced)) {
      documents.push(...produced);
    } else if (produced) {
      documents.push(produced);
    }
  }

  const saved = [];
  for (const document of normalizeDocuments(documents)) {
    saved.push(await repository.upsertContextDocument({ ...document, user }));
  }

  return saved;
};
