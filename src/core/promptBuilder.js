import { formatPageRegistryForPrompt } from './pageRegistry.js';
import { formatWriteActionsForPrompt } from './writeActionRegistry.js';

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
  writeActions = [],
} = {}) => {
  const context = contextDocuments.length > 0
    ? contextDocuments.map(formatContextDocument).join('\n\n---\n\n')
    : 'No generated Markdown context is available yet. Use approved tools when business data is needed.';

  const toolNames = toolDefinitions.map((tool) => tool.name).join(', ') || 'none';
  const pageRoutes = formatPageRegistryForPrompt(pageRegistry, { fallbackRoute });
  const writeActionText = formatWriteActionsForPrompt(writeActions);

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
    '- Never claim that you changed business data unless a separate user-approved apply action succeeds.',
    '- Draft actions are suggestions only and always require manual user review.',
    '- Draft action targetRoute must exactly match one registered page route below. Do not invent routes, query params, record URLs, or external links.',
    '- Write-capable draft actions must include the exact payload needed for review and must keep requiresUserReview true.',
    '- Bulk price draft actions are allowed only when every affected product is explicitly listed with its id, current price, new price, currency, and target price field. Do not create open-ended category-wide writes.',
    '- If the user asks for a broad category/group price edit, use approved read-only tools to identify a bounded product list first, then draft one reviewed bulk action for those exact items.',
    '- Do not ask for raw SQL and do not produce SQL for execution.',
    ...extraInstructions.map((instruction) => `- ${instruction}`),
    '',
    `Application locale: ${locale}`,
    `Available read-only tools: ${toolNames}`,
    '',
    'Registered pages for draft action links:',
    pageRoutes,
    '',
    'Approved write-capable draft actions:',
    writeActionText,
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
