import { readAssistantConfig } from './config.js';
import { buildUnavailableAssistantMessage } from './promptBuilder.js';
import { OpenAIResponsesProvider } from '../providers/OpenAIResponsesProvider.js';
import { refreshAssistantContext } from '../context/contextRefresh.js';
import { createAssistantCapabilityHarness } from './capabilityHarness.js';

const serializeContextDocument = (doc) => ({
  id: doc.id,
  scope: doc.scope,
  title: doc.title,
  metadata: doc.metadata,
  sourceHash: doc.source_hash || doc.sourceHash,
  refreshedAt: doc.refreshed_at || doc.refreshedAt,
  preview: doc.preview,
});

const serializeConversation = (conversation) => ({
  id: conversation.id,
  title: conversation.title,
  metadata: conversation.metadata,
  createdAt: conversation.created_at || conversation.createdAt,
  updatedAt: conversation.updated_at || conversation.updatedAt,
  lastMessage: conversation.last_message || conversation.lastMessage,
});

const serializeMessage = (message) => ({
  id: message.id,
  conversationId: message.conversation_id || message.conversationId,
  role: message.role,
  content: message.content,
  metadata: message.metadata,
  createdAt: message.created_at || message.createdAt,
});

const serializeDraftAction = (draft) => ({
  id: draft.id,
  type: draft.type,
  title: draft.title,
  reason: draft.reason,
  targetRoute: draft.target_route || draft.targetRoute,
  payload: draft.payload,
  confidence: Number(draft.confidence || 0),
  requiresUserReview: draft.requires_user_review ?? draft.requiresUserReview,
  status: draft.status,
  metadata: draft.metadata,
});

const noopAuditLogger = async () => {};

export class AssistantService {
  constructor({
    repository,
    config = readAssistantConfig(),
    toolRegistry,
    contextSources = [],
    provider = null,
    auditLogger = noopAuditLogger,
    appName = 'Business application',
    extraInstructions = [],
    pageRegistry = [],
    fallbackRoute = '/',
    writeActionRegistry = null,
    capabilityHarness = null,
  } = {}) {
    if (!repository) {
      throw new Error('AssistantService requires a repository');
    }

    if (!toolRegistry) {
      throw new Error('AssistantService requires a toolRegistry');
    }

    this.repository = repository;
    this.config = config;
    this.toolRegistry = toolRegistry;
    this.contextSources = contextSources;
    this.provider = provider;
    this.auditLogger = auditLogger;
    this.appName = appName;
    this.extraInstructions = extraInstructions;
    this.pageRegistry = pageRegistry;
    this.fallbackRoute = fallbackRoute;
    this.writeActionRegistry = writeActionRegistry;
    this.capabilityHarness = capabilityHarness || createAssistantCapabilityHarness({
      toolRegistry,
      writeActionRegistry,
    });
  }

  getStatus() {
    return {
      enabled: this.config.enabled,
      provider: this.config.provider,
      model: this.config.model,
      configured: this.config.configured,
      hasApiKey: this.config.hasApiKey,
    };
  }

  async listConversations(user) {
    const conversations = await this.repository.listConversations(user);
    return conversations.map(serializeConversation);
  }

  async getConversation(id, user) {
    const conversation = await this.repository.getConversationForUser(id, user);
    if (!conversation) {
      const error = new Error('Conversation not found');
      error.status = 404;
      throw error;
    }

    const messages = await this.repository.listMessages(id);

    return {
      conversation: serializeConversation(conversation),
      messages: messages.map(serializeMessage),
    };
  }

  async listContext() {
    const documents = await this.repository.listContextDocuments({ includeContent: false });
    return {
      status: this.getStatus(),
      documents: documents.map(serializeContextDocument),
    };
  }

  getCapabilities() {
    return {
      status: this.getStatus(),
      capabilities: this.capabilityHarness.listCapabilities(),
    };
  }

  async refreshContext(user, requestContext = {}) {
    const documents = await refreshAssistantContext({
      repository: this.repository,
      user,
      contextSources: this.contextSources,
      toolRegistry: this.toolRegistry,
    });

    await this.auditLogger({
      user,
      requestContext,
      module: 'assistant',
      action: 'context_refresh',
      targetType: 'assistant_context_documents',
      description: `Refreshed ${documents.length} assistant context documents`,
      metadata: { scopes: documents.map((doc) => doc.scope) },
    });

    return {
      status: this.getStatus(),
      documents: documents.map(serializeContextDocument),
    };
  }

  createProvider() {
    if (this.provider) {
      return this.provider;
    }

    return new OpenAIResponsesProvider({
      config: this.config,
      toolRegistry: this.toolRegistry,
      draftActionOptions: {
        pageRegistry: this.pageRegistry,
        fallbackRoute: this.fallbackRoute,
      },
    });
  }

  async chat({ user, message, conversationId, locale = 'en', requestContext = {} }) {
    const cleanMessage = String(message || '').trim();
    if (!cleanMessage) {
      const error = new Error('Message is required');
      error.status = 400;
      throw error;
    }

    if (cleanMessage.length > 4000) {
      const error = new Error('Message is too long');
      error.status = 400;
      throw error;
    }

    const conversation = await this.repository.getOrCreateConversation({
      conversationId,
      user,
      firstMessage: cleanMessage,
    });

    const userMessage = await this.repository.addMessage({
      conversationId: conversation.id,
      role: 'user',
      content: cleanMessage,
      metadata: { locale },
    });

    await this.auditLogger({
      user,
      requestContext,
      module: 'assistant',
      action: 'chat',
      targetType: 'assistant_conversation',
      targetId: conversation.id,
      description: 'Assistant chat message submitted',
      metadata: { messageId: userMessage.id },
    });

    if (!this.config.configured) {
      const answer = buildUnavailableAssistantMessage(this.config);
      const assistantMessage = await this.repository.addMessage({
        conversationId: conversation.id,
        role: 'assistant',
        content: answer,
        metadata: {
          notConfigured: true,
          status: this.getStatus(),
        },
      });

      return {
        status: this.getStatus(),
        conversation: serializeConversation(conversation),
        userMessage: serializeMessage(userMessage),
        assistantMessage: serializeMessage(assistantMessage),
        answer,
        citations: [],
        draftActions: [],
        charts: [],
      };
    }

    let contextDocuments = await this.repository.listContextDocuments({ includeContent: true });
    if (contextDocuments.length === 0 && this.contextSources.length > 0) {
      contextDocuments = await refreshAssistantContext({
        repository: this.repository,
        user,
        contextSources: this.contextSources,
        toolRegistry: this.toolRegistry,
      });
    }

    const conversationMessages = (await this.repository.listMessages(conversation.id, { limit: 12 }))
      .filter((savedMessage) => savedMessage.id !== userMessage.id);
    const provider = this.createProvider();

    const writeActions = this.capabilityHarness.listWriteDefinitions();
    const result = await provider.generate({
      message: cleanMessage,
      contextDocuments,
      conversationMessages,
      locale,
      appName: this.appName,
      extraInstructions: this.extraInstructions,
      pageRegistry: this.pageRegistry,
      fallbackRoute: this.fallbackRoute,
      writeActions,
      user,
      requestContext,
    });

    const assistantMessage = await this.repository.addMessage({
      conversationId: conversation.id,
      role: 'assistant',
      content: result.answer,
      metadata: {
        citations: result.citations,
        charts: result.charts || [],
        provider: this.config.provider,
        model: this.config.model,
        providerResponseId: result.providerResponseId,
      },
    });

    for (const toolRun of result.toolRuns) {
      await this.repository.addToolRun({
        conversationId: conversation.id,
        messageId: assistantMessage.id,
        ...toolRun,
      });
    }

    const decoratedDrafts = result.draftActions.map((action) => (
      this.capabilityHarness.decorateDraftAction(action)
    ));
    const savedDrafts = await this.repository.addDraftActions({
      conversationId: conversation.id,
      messageId: assistantMessage.id,
      actions: decoratedDrafts,
    });

    return {
      status: this.getStatus(),
      conversation: serializeConversation(conversation),
      userMessage: serializeMessage(userMessage),
      assistantMessage: serializeMessage(assistantMessage),
      answer: result.answer,
      citations: result.citations,
      draftActions: savedDrafts.map(serializeDraftAction),
      charts: result.charts || [],
    };
  }

  async previewDraftAction({ actionId, user, requestContext = {} }) {
    if (!this.repository.getDraftActionForUser) {
      const error = new Error('Assistant repository does not support draft actions');
      error.status = 500;
      throw error;
    }

    const action = await this.repository.getDraftActionForUser(actionId, user);
    if (!action) {
      const error = new Error('Draft action not found');
      error.status = 404;
      throw error;
    }

    if (action.status && !['draft', 'failed'].includes(action.status)) {
      const error = new Error(`Draft action cannot be previewed from status: ${action.status}`);
      error.status = 409;
      throw error;
    }

    const context = { user, requestContext };
    const preview = await this.capabilityHarness.previewWriteAction(action, context);
    const capability = this.writeActionRegistry?.getDefinition?.(action.type)
      || action.metadata?.capability
      || null;

    await this.auditLogger({
      user,
      requestContext,
      module: 'assistant',
      action: 'draft_action_preview',
      targetType: 'assistant_draft_action',
      targetId: action.id,
      description: `Previewed assistant draft action ${action.type}`,
      metadata: {
        conversationId: action.conversation_id || action.conversationId,
        affectedCount: preview.affectedCount,
      },
    });

    return {
      draftAction: serializeDraftAction(action),
      capability,
      preview,
    };
  }

  async applyDraftAction({ actionId, user, requestContext = {} }) {
    if (!this.capabilityHarness?.executeWriteAction) {
      const error = new Error('Assistant write actions are not configured');
      error.status = 400;
      throw error;
    }

    if (!this.repository.getDraftActionForUser || !this.repository.updateDraftActionStatus) {
      const error = new Error('Assistant repository does not support draft action updates');
      error.status = 500;
      throw error;
    }

    const action = await this.repository.getDraftActionForUser(actionId, user);
    if (!action) {
      const error = new Error('Draft action not found');
      error.status = 404;
      throw error;
    }

    if (action.status && action.status !== 'draft' && action.status !== 'failed') {
      const error = new Error(`Draft action cannot be applied from status: ${action.status}`);
      error.status = 409;
      throw error;
    }

    const context = { user, requestContext };
    await this.capabilityHarness.assertCanApply(action, context);

    let claimedAction = action;
    if (this.repository.transitionDraftActionStatus) {
      claimedAction = await this.repository.transitionDraftActionStatus({
        id: action.id,
        fromStatuses: ['draft', 'failed'],
        status: 'applying',
        metadata: {
          ...(action.metadata || {}),
          applyingAt: new Date().toISOString(),
          applyingBy: user?.id || null,
        },
      });
      if (!claimedAction) {
        const error = new Error('Draft action is already being processed');
        error.status = 409;
        throw error;
      }
    }

    try {
      const execution = await this.capabilityHarness.executeWriteAction(claimedAction, context);
      const result = execution.result;
      const metadata = {
        ...(claimedAction.metadata || {}),
        appliedAt: new Date().toISOString(),
        appliedBy: user?.id || null,
        applyResult: result || {},
        preview: execution.preview,
        capability: execution.capability,
      };
      const saved = await this.repository.updateDraftActionStatus({
        id: action.id,
        status: 'applied',
        metadata,
      });

      await this.auditLogger({
        user,
        requestContext,
        module: 'assistant',
        action: 'draft_action_apply',
        targetType: 'assistant_draft_action',
        targetId: action.id,
        description: `Applied assistant draft action ${action.type}`,
        metadata: { conversationId: action.conversation_id || action.conversationId, result },
      });

      return { draftAction: serializeDraftAction(saved), result };
    } catch (error) {
      if (action?.id && this.repository.updateDraftActionStatus) {
        await this.repository.updateDraftActionStatus({
          id: action.id,
          status: 'failed',
          metadata: {
            ...(claimedAction?.metadata || action.metadata || {}),
            failedAt: new Date().toISOString(),
            error: error.message,
          },
        }).catch(() => null);
      }

      throw error;
    }
  }

  async rejectDraftAction({ actionId, user, requestContext = {} }) {
    if (!this.repository.getDraftActionForUser || !this.repository.updateDraftActionStatus) {
      const error = new Error('Assistant repository does not support draft action updates');
      error.status = 500;
      throw error;
    }

    const action = await this.repository.getDraftActionForUser(actionId, user);
    if (!action) {
      const error = new Error('Draft action not found');
      error.status = 404;
      throw error;
    }

    if (action.status && action.status !== 'draft' && action.status !== 'failed') {
      const error = new Error(`Draft action cannot be rejected from status: ${action.status}`);
      error.status = 409;
      throw error;
    }

    const update = {
      id: action.id,
      status: 'rejected',
      metadata: {
        ...(action.metadata || {}),
        rejectedAt: new Date().toISOString(),
        rejectedBy: user?.id || null,
      },
    };
    const saved = this.repository.transitionDraftActionStatus
      ? await this.repository.transitionDraftActionStatus({
        ...update,
        fromStatuses: ['draft', 'failed'],
      })
      : await this.repository.updateDraftActionStatus(update);

    if (!saved) {
      const error = new Error('Draft action is already being processed');
      error.status = 409;
      throw error;
    }

    await this.auditLogger({
      user,
      requestContext,
      module: 'assistant',
      action: 'draft_action_reject',
      targetType: 'assistant_draft_action',
      targetId: action.id,
      description: `Rejected assistant draft action ${action.type}`,
      metadata: { conversationId: action.conversation_id || action.conversationId },
    });

    return { draftAction: serializeDraftAction(saved) };
  }
}

export const createAssistantService = (options) => new AssistantService(options);
