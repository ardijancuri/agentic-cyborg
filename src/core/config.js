export const DEFAULT_ASSISTANT_MODEL = 'gpt-5.4-mini';

const parseBooleanFlag = (value, defaultValue = true) => {
  if (value === undefined || value === null || value === '') {
    return defaultValue;
  }

  return !['0', 'false', 'no', 'off'].includes(String(value).trim().toLowerCase());
};

export const readAssistantConfig = (env = process.env) => {
  const provider = (env.ASSISTANT_PROVIDER || 'openai').trim().toLowerCase();
  const apiKey = (env.OPENAI_API_KEY || '').trim();
  const enabled = parseBooleanFlag(env.ASSISTANT_ENABLED, true);

  return {
    enabled,
    provider,
    model: (env.OPENAI_MODEL || DEFAULT_ASSISTANT_MODEL).trim(),
    hasApiKey: Boolean(apiKey),
    apiKey,
    configured: enabled && provider === 'openai' && Boolean(apiKey),
    maxToolCalls: Math.max(1, Math.min(parseInt(env.ASSISTANT_MAX_TOOL_CALLS, 10) || 4, 8)),
    maxBulkItems: Math.max(1, Math.min(parseInt(env.ASSISTANT_MAX_BULK_ITEMS, 10) || 100, 500)),
    actionPreviewLimit: Math.max(1, Math.min(parseInt(env.ASSISTANT_ACTION_PREVIEW_LIMIT, 10) || 20, 50)),
  };
};
