import { readAssistantConfig } from './config.js';
import { buildUnavailableAssistantMessage } from './promptBuilder.js';
import { OpenAIResponsesProvider } from '../providers/OpenAIResponsesProvider.js';
import { refreshAssistantContext } from '../context/contextRefresh.js';

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

    const result = await provider.generate({
      message: cleanMessage,
      contextDocuments,
      conversationMessages,
      locale,
      appName: this.appName,
      extraInstructions: this.extraInstructions,
      pageRegistry: this.pageRegistry,
      fallbackRoute: this.fallbackRoute,
      user,
      requestContext,
    });

    const assistantMessage = await this.repository.addMessage({
      conversationId: conversation.id,
      role: 'assistant',
      content: result.answer,
      metadata: {
        citations: result.citations,
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

    const savedDrafts = await this.repository.addDraftActions({
      conversationId: conversation.id,
      messageId: assistantMessage.id,
      actions: result.draftActions,
    });

    return {
      status: this.getStatus(),
      conversation: serializeConversation(conversation),
      userMessage: serializeMessage(userMessage),
      assistantMessage: serializeMessage(assistantMessage),
      answer: result.answer,
      citations: result.citations,
      draftActions: savedDrafts.map(serializeDraftAction),
    };
  }
}

export const createAssistantService = (options) => new AssistantService(options);
