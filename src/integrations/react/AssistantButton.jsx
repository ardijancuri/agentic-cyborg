import React, { useEffect, useRef, useState } from 'react';
import MarkdownMessage from './MarkdownMessage';

const defaultLabels = {
  title: 'AI Assistant',
  context: 'Context',
  noContext: 'No context yet',
  notConfigured: 'OPENAI_API_KEY is not configured',
  refreshContext: 'Refresh context',
  businessQuestions: 'Business questions',
  draftActions: 'Draft actions',
  working: 'Working...',
  open: 'Open',
  send: 'Send',
  apply: 'Apply',
  applying: 'Applying...',
  reject: 'Reject',
  rejecting: 'Rejecting...',
  draft: 'Draft',
  applied: 'Applied',
  rejected: 'Rejected',
  failed: 'Failed',
  applyNotAllowed: 'Only authorized users can apply',
  placeholder: 'Ask about the business...',
  loadContextError: 'Could not load assistant context',
  assistantError: 'Assistant request failed',
  refreshError: 'Could not refresh context',
  applyError: 'Could not apply draft action',
  rejectError: 'Could not reject draft action',
};

const defaultStarterMessages = [
  'Show me the most important business alerts.',
  'Summarize sales, stock, and unpaid invoices.',
  'What should the owner review today?',
];

const formatFreshness = (value) => {
  if (!value) {
    return defaultLabels.noContext;
  }

  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
};

const mergeLabels = (labels) => ({ ...defaultLabels, ...(labels || {}) });

function MessageBubble({ message }) {
  const isUser = message.role === 'user';

  return (
    <div className={`psa-flex ${isUser ? 'psa-justify-end' : 'psa-justify-start'}`}>
      <div className={`psa-message ${isUser ? 'psa-message-user' : 'psa-message-assistant'}`}>
        {isUser ? (
          <div className="psa-whitespace">{message.content}</div>
        ) : (
          <MarkdownMessage content={message.content} />
        )}
      </div>
    </div>
  );
}

const defaultWriteActionTypes = [
  'update_product_price',
  'bulk_update_product_prices',
  'update_woocommerce_product_price',
  'bulk_update_woocommerce_product_prices',
];

const formatProductTarget = (item = {}) => {
  const parts = [];
  if (item.productId || item.stockItemId || item.id) {
    parts.push(`Product ${item.productId || item.stockItemId || item.id}`);
  }
  if (item.variationId) {
    parts.push(`variation ${item.variationId}`);
  }
  if (item.priceField) {
    parts.push(item.priceField);
  }
  if (item.newPrice !== undefined && item.newPrice !== null) {
    parts.push(`to ${item.newPrice}`);
  }
  return parts.join(' - ');
};

const summarizePricePayload = (action) => {
  const payload = action?.payload || {};
  const items = Array.isArray(payload.items) ? payload.items : [];

  if (items.length > 0) {
    const preview = items.slice(0, 5).map(formatProductTarget).filter(Boolean);
    return [
      `${items.length} product${items.length === 1 ? '' : 's'} selected`,
      payload.priceField ? `Field: ${payload.priceField}` : '',
      payload.currency ? `Currency: ${payload.currency}` : '',
      ...preview,
      items.length > preview.length ? `+${items.length - preview.length} more` : '',
    ].filter(Boolean);
  }

  const single = formatProductTarget(payload);
  return [
    single,
    payload.currentPrice !== undefined && payload.currentPrice !== null ? `Current: ${payload.currentPrice}` : '',
    payload.currency ? `Currency: ${payload.currency}` : '',
  ].filter(Boolean);
};

function DraftActionCard({
  action,
  labels,
  isWriteAction,
  canApplyActions,
  busyState,
  onApply,
  onReject,
}) {
  const status = action.status || 'draft';
  const isClosed = status === 'applied' || status === 'rejected';
  const canShowControls = isWriteAction && !isClosed;
  const statusLabel = labels[status] || status;
  const payloadSummary = isWriteAction ? summarizePricePayload(action) : [];

  return (
    <div className="psa-draft-card">
      <div className="psa-draft-head">
        <div>
          <div className="psa-draft-title">{action.title}</div>
          <p className="psa-draft-reason">{action.reason}</p>
        </div>
        <div className="psa-draft-badges">
          {isWriteAction && <span className={`psa-status psa-status-${status}`}>{statusLabel}</span>}
          <span className="psa-confidence">{Math.round((action.confidence || 0) * 100)}%</span>
        </div>
      </div>
      {payloadSummary.length > 0 && (
        <ul className="psa-draft-payload">
          {payloadSummary.map((line, index) => (
            <li key={`${line}-${index}`}>{line}</li>
          ))}
        </ul>
      )}
      {action.targetRoute && (
        <a className="psa-link" href={action.targetRoute}>
          {labels.open}
        </a>
      )}
      {canShowControls && (
        <div className="psa-draft-actions">
          <button
            type="button"
            className="psa-action-apply"
            onClick={() => onApply(action)}
            disabled={!canApplyActions || busyState === 'apply' || busyState === 'reject'}
            title={!canApplyActions ? labels.applyNotAllowed : labels.apply}
          >
            {busyState === 'apply' ? labels.applying : labels.apply}
          </button>
          <button
            type="button"
            className="psa-action-reject"
            onClick={() => onReject(action)}
            disabled={busyState === 'apply' || busyState === 'reject'}
          >
            {busyState === 'reject' ? labels.rejecting : labels.reject}
          </button>
        </div>
      )}
    </div>
  );
}

export default function AssistantButton({
  api,
  canUseAssistant = true,
  canApplyActions = true,
  locale = 'en',
  labels: providedLabels,
  starterMessages = defaultStarterMessages,
  writeActionTypes = defaultWriteActionTypes,
  onDraftActionApplied,
  onDraftActionRejected,
}) {
  const labels = mergeLabels(providedLabels);
  const [isOpen, setIsOpen] = useState(false);
  const [contextState, setContextState] = useState(null);
  const [conversationId, setConversationId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [draftActions, setDraftActions] = useState([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [actionBusy, setActionBusy] = useState({});
  const endRef = useRef(null);

  useEffect(() => {
    if (!isOpen || !canUseAssistant || !api?.getContext) {
      return;
    }

    let mounted = true;

    api.getContext()
      .then((data) => {
        if (mounted) {
          setContextState(data);
        }
      })
      .catch(() => {
        if (mounted) {
          setError(labels.loadContextError);
        }
      });

    return () => {
      mounted = false;
    };
  }, [api, canUseAssistant, isOpen, labels.loadContextError]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, draftActions, loading]);

  if (!canUseAssistant) {
    return null;
  }

  const latestRefresh = contextState?.documents?.reduce((latest, document) => {
    if (!document.refreshedAt) return latest;
    if (!latest) return document.refreshedAt;
    return new Date(document.refreshedAt) > new Date(latest) ? document.refreshedAt : latest;
  }, null);

  const sendMessage = async (text = input) => {
    const clean = text.trim();
    if (!clean || loading || !api?.chat) {
      return;
    }

    setInput('');
    setError('');
    setLoading(true);
    setDraftActions([]);
    setMessages((current) => [...current, { role: 'user', content: clean }]);

    try {
      const data = await api.chat({ conversationId, message: clean, locale });
      setConversationId(data.conversation?.id || conversationId);
      setMessages((current) => [
        ...current,
        { role: 'assistant', content: data.answer || data.assistantMessage?.content || '' },
      ]);
      setDraftActions(data.draftActions || []);
      if (data.status) {
        setContextState((current) => ({ ...(current || {}), status: data.status }));
      }
    } catch (requestError) {
      const message = requestError?.message || labels.assistantError;
      setError(message);
      setMessages((current) => [...current, { role: 'assistant', content: message }]);
    } finally {
      setLoading(false);
    }
  };

  const refreshContext = async () => {
    if (refreshing || !api?.refreshContext) {
      return;
    }

    setRefreshing(true);
    setError('');

    try {
      const data = await api.refreshContext();
      setContextState(data);
    } catch (requestError) {
      setError(requestError?.message || labels.refreshError);
    } finally {
      setRefreshing(false);
    }
  };

  const replaceDraftAction = (nextAction) => {
    if (!nextAction?.id) {
      return;
    }

    setDraftActions((current) => current.map((action) => (
      action.id === nextAction.id ? { ...action, ...nextAction } : action
    )));
  };

  const applyDraftAction = async (action) => {
    if (!api?.applyDraftAction || !action?.id) {
      return;
    }

    setError('');
    setActionBusy((current) => ({ ...current, [action.id]: 'apply' }));

    try {
      const data = await api.applyDraftAction(action.id);
      if (data?.draftAction) {
        replaceDraftAction(data.draftAction);
      }
      onDraftActionApplied?.(data);
    } catch (requestError) {
      const message = requestError?.message || labels.applyError;
      setError(message);
      if (requestError?.status !== 403) {
        replaceDraftAction({
          ...action,
          status: 'failed',
          metadata: { ...(action.metadata || {}), error: message },
        });
      }
    } finally {
      setActionBusy((current) => {
        const next = { ...current };
        delete next[action.id];
        return next;
      });
    }
  };

  const rejectDraftAction = async (action) => {
    if (!api?.rejectDraftAction || !action?.id) {
      return;
    }

    setError('');
    setActionBusy((current) => ({ ...current, [action.id]: 'reject' }));

    try {
      const data = await api.rejectDraftAction(action.id);
      if (data?.draftAction) {
        replaceDraftAction(data.draftAction);
      }
      onDraftActionRejected?.(data);
    } catch (requestError) {
      setError(requestError?.message || labels.rejectError);
    } finally {
      setActionBusy((current) => {
        const next = { ...current };
        delete next[action.id];
        return next;
      });
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setIsOpen((value) => !value)}
        className="psa-fab"
        aria-label={labels.title}
        title={labels.title}
      >
        {isOpen ? 'x' : 'AI'}
      </button>

      {isOpen && (
        <aside className="psa-drawer">
          <header className="psa-header">
            <div>
              <h2 className="psa-title">{labels.title}</h2>
              <p className="psa-subtitle">
                {contextState?.status?.configured
                  ? `${labels.context}: ${formatFreshness(latestRefresh)}`
                  : labels.notConfigured}
              </p>
            </div>
            <button
              type="button"
              onClick={refreshContext}
              disabled={refreshing}
              className="psa-icon-button"
              title={labels.refreshContext}
              aria-label={labels.refreshContext}
            >
              {refreshing ? '...' : '↻'}
            </button>
          </header>

          <div className="psa-body">
            {messages.length === 0 && (
              <div className="psa-card">
                <div className="psa-card-title">{labels.businessQuestions}</div>
                <div className="psa-starters">
                  {starterMessages.map((starter) => (
                    <button
                      key={starter}
                      type="button"
                      onClick={() => sendMessage(starter)}
                      className="psa-starter"
                    >
                      {starter}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {messages.map((message, index) => (
              <MessageBubble key={`${message.role}-${index}`} message={message} />
            ))}

            {loading && <div className="psa-loading">{labels.working}</div>}

            {draftActions.length > 0 && (
              <div className="psa-drafts">
                <div className="psa-section-label">{labels.draftActions}</div>
                {draftActions.map((action) => (
                  <DraftActionCard
                    key={action.id || action.title}
                    action={action}
                    labels={labels}
                    isWriteAction={writeActionTypes.includes(action.type)}
                    canApplyActions={canApplyActions}
                    busyState={actionBusy[action.id]}
                    onApply={applyDraftAction}
                    onReject={rejectDraftAction}
                  />
                ))}
              </div>
            )}

            {error && <div className="psa-error">{error}</div>}

            <div ref={endRef} />
          </div>

          <form
            className="psa-composer"
            onSubmit={(event) => {
              event.preventDefault();
              sendMessage();
            }}
          >
            <textarea
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  sendMessage();
                }
              }}
              rows={2}
              className="psa-textarea"
              placeholder={labels.placeholder}
            />
            <button type="submit" disabled={loading || !input.trim()} className="psa-send">
              {labels.send}
            </button>
          </form>
        </aside>
      )}
    </>
  );
}
