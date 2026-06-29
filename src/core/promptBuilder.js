import { formatPageRegistryForPrompt } from './pageRegistry.js';

const trimBlock = (value = '', maxLength = 4000) => {
  const text = String(value || '').trim();
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
};

const formatContextDocument = (document) => {
  return [
    `## ${document.title}`,
    `Scope: ${document.scope}`,
    trimBlock(document.content),
  ].join('\n');
};

export const buildSystemPrompt = ({
  appName = 'Business application',
  contextDocuments = [],
  toolDefinitions = [],
  locale = 'en',
  extraInstructions = [],
  pageRegistry = [],
  fallbackRoute = '/',
} = {}) => {
  const context = contextDocuments.length > 0
    ? contextDocuments.map(formatContextDocument).join('\n\n---\n\n')
    : 'No generated Markdown context is available yet. Use approved tools when business data is needed.';

  const toolNames = toolDefinitions.map((tool) => tool.name).join(', ') || 'none';
  const pageRoutes = formatPageRegistryForPrompt(pageRegistry, { fallbackRoute });

  return [
    'You are a reusable personal business AI assistant embedded in custom business software.',
    `Current host application: ${appName}`,
    'Your job is to help business owners understand their database-backed operations quickly and safely.',
    '',
    'Operating rules:',
    '- Answer in the user language when clear; otherwise match the application locale.',
    '- Be short and straightforward by default: 2-5 concise bullets or short paragraphs.',
    '- Start with the direct answer or recommendation, then add only the most important supporting numbers.',
    '- Avoid long explanations, greetings, repeated safety caveats, and broad background unless the user asks.',
    '- Use generated Markdown context first for stable business orientation.',
    '- Use approved read-only tools for live numbers, lists, and statistics.',
    '- Never invent database values. If a number is unavailable, say what should be checked.',
    '- Never claim that you changed business data.',
    '- Draft actions are suggestions only and always require manual user review.',
    '- Draft action targetRoute must exactly match one registered page route below. Do not invent routes, query params, record URLs, or external links.',
    '- Do not ask for raw SQL and do not produce SQL for execution.',
    ...extraInstructions.map((instruction) => `- ${instruction}`),
    '',
    `Application locale: ${locale}`,
    `Available read-only tools: ${toolNames}`,
    '',
    'Registered pages for draft action links:',
    pageRoutes,
    '',
    'Generated Markdown business context:',
    context,
  ].join('\n');
};

export const buildUnavailableAssistantMessage = ({ hasApiKey, enabled }) => {
  if (!enabled) {
    return 'AI assistant is currently disabled by configuration. Set ASSISTANT_ENABLED=true to enable it.';
  }

  if (!hasApiKey) {
    return 'AI assistant is installed and ready, but OPENAI_API_KEY is not configured yet. Add the key to the backend environment, restart the server, then ask again.';
  }

  return 'AI assistant is not fully configured. Check ASSISTANT_PROVIDER and backend environment settings.';
};
