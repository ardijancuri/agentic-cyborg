import { buildSystemPrompt } from '../core/promptBuilder.js';
import { ADVISORY_DRAFT_ACTION_TYPES, validateDraftActions } from '../core/draftActions.js';
import { validateAssistantCharts } from '../core/charts.js';

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['answer', 'citations', 'draftActions', 'charts'],
  properties: {
    answer: { type: 'string' },
    citations: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['label', 'scope'],
        properties: {
          label: { type: 'string' },
          scope: { type: 'string' },
        },
      },
    },
    draftActions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: true,
        required: ['type', 'title', 'reason', 'targetRoute', 'payload', 'confidence', 'requiresUserReview'],
        properties: {
          type: { type: 'string' },
          title: { type: 'string' },
          reason: { type: 'string' },
          targetRoute: { type: 'string' },
          payload: { type: 'object', additionalProperties: true },
          confidence: { type: 'number' },
          requiresUserReview: { type: 'boolean' },
        },
      },
    },
    charts: {
      type: 'array',
      maxItems: 2,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['type', 'title', 'labels', 'datasets'],
        properties: {
          type: { type: 'string', enum: ['bar', 'line', 'donut'] },
          title: { type: 'string' },
          description: { type: 'string' },
          unit: { type: 'string' },
          labels: {
            type: 'array',
            maxItems: 12,
            items: { type: 'string' },
          },
          datasets: {
            type: 'array',
            maxItems: 4,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['label', 'data'],
              properties: {
                label: { type: 'string' },
                data: {
                  type: 'array',
                  maxItems: 12,
                  items: { type: 'number' },
                },
              },
            },
          },
        },
      },
    },
  },
};

const API_URL = 'https://api.openai.com/v1/responses';
const STATELESS_RESPONSE_INCLUDE = ['reasoning.encrypted_content'];

const parseArguments = (value) => {
  if (!value) {
    return {};
  }

  if (typeof value === 'object') {
    return value;
  }

  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
};

const extractOutputText = (response) => {
  if (response?.output_text) {
    return response.output_text;
  }

  const message = response?.output?.find((item) => item.type === 'message');
  const textPart = message?.content?.find((part) => part.type === 'output_text' || part.type === 'text');
  return textPart?.text || '';
};

const parseAssistantJson = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return {
      answer: text || 'I could not produce a structured answer. Please try again.',
      citations: [],
      draftActions: [],
      charts: [],
    };
  }
};

const compactMessages = (messages = []) => {
  return messages.slice(-10).map((message) => ({
    role: message.role === 'assistant' ? 'assistant' : 'user',
    content: message.content,
  }));
};

export class OpenAIResponsesProvider {
  constructor({ config, toolRegistry, promptBuilder = buildSystemPrompt, draftActionOptions = {} }) {
    this.config = config;
    this.toolRegistry = toolRegistry;
    this.promptBuilder = promptBuilder;
    this.draftActionOptions = draftActionOptions;
  }

  async request(body) {
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      const error = new Error(payload?.error?.message || 'OpenAI request failed');
      error.status = response.status;
      error.payload = payload;
      throw error;
    }

    return payload;
  }

  async generate({
    message,
    contextDocuments,
    conversationMessages = [],
    locale = 'en',
    appName,
    extraInstructions = [],
    pageRegistry = this.draftActionOptions.pageRegistry,
    fallbackRoute = this.draftActionOptions.fallbackRoute,
    writeActions = [],
    user = null,
    requestContext = {},
  }) {
    const toolDefinitions = this.toolRegistry.listDefinitions();
    const instructions = this.promptBuilder({
      appName,
      contextDocuments,
      toolDefinitions,
      locale,
      extraInstructions,
      pageRegistry,
      fallbackRoute,
      writeActions,
    });
    const draftActionOptions = {
      ...this.draftActionOptions,
      pageRegistry,
      fallbackRoute,
      allowedTypes: [
        ...ADVISORY_DRAFT_ACTION_TYPES,
        ...writeActions.map((action) => action.type).filter(Boolean),
      ],
    };
    const toolRuns = [];
    let inputItems = [
      ...compactMessages(conversationMessages),
      { role: 'user', content: message },
    ];

    let response = await this.request({
      model: this.config.model,
      instructions,
      input: inputItems,
      tools: toolDefinitions,
      tool_choice: 'auto',
      parallel_tool_calls: false,
      store: false,
      include: STATELESS_RESPONSE_INCLUDE,
      max_tool_calls: this.config.maxToolCalls,
      reasoning: { effort: 'low' },
      text: {
        verbosity: 'low',
        format: {
          type: 'json_schema',
          name: 'business_assistant_response',
          strict: false,
          schema: OUTPUT_SCHEMA,
        },
      },
    });

    for (let index = 0; index < this.config.maxToolCalls; index += 1) {
      const calls = (response.output || []).filter((item) => item.type === 'function_call');
      if (calls.length === 0) {
        break;
      }

      const outputs = [];

      for (const call of calls) {
        const started = Date.now();
        const args = parseArguments(call.arguments);

        try {
          const result = await this.toolRegistry.execute(call.name, args, { user, requestContext });
          const durationMs = Date.now() - started;
          toolRuns.push({
            toolName: call.name,
            args,
            resultSummary: result.summary,
            status: 'completed',
            durationMs,
          });
          outputs.push({
            type: 'function_call_output',
            call_id: call.call_id,
            output: JSON.stringify(result.data),
          });
        } catch (error) {
          const durationMs = Date.now() - started;
          toolRuns.push({
            toolName: call.name,
            args,
            resultSummary: null,
            status: 'failed',
            error: error.message,
            durationMs,
          });
          outputs.push({
            type: 'function_call_output',
            call_id: call.call_id,
            output: JSON.stringify({ error: error.message }),
          });
        }
      }

      inputItems = [
        ...inputItems,
        ...(response.output || []),
        ...outputs,
      ];

      response = await this.request({
        model: this.config.model,
        instructions,
        input: inputItems,
        tools: toolDefinitions,
        tool_choice: 'auto',
        parallel_tool_calls: false,
        store: false,
        include: STATELESS_RESPONSE_INCLUDE,
        max_tool_calls: this.config.maxToolCalls,
        reasoning: { effort: 'low' },
        text: {
          verbosity: 'low',
          format: {
            type: 'json_schema',
            name: 'business_assistant_response',
            strict: false,
            schema: OUTPUT_SCHEMA,
          },
        },
      });
    }

    const parsed = parseAssistantJson(extractOutputText(response));

    return {
      answer: parsed.answer || '',
      citations: Array.isArray(parsed.citations) ? parsed.citations : [],
      draftActions: validateDraftActions(parsed.draftActions, draftActionOptions),
      charts: validateAssistantCharts(parsed.charts),
      toolRuns,
      providerResponseId: response.id,
    };
  }
}
