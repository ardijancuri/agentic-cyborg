(function () {
  const config = window.PsaAssistantConfig || {};
  const writeActionTypes = new Set(['update_woocommerce_product_price']);
  const closedStatuses = new Set(['applied', 'rejected']);

  const state = {
    open: false,
    conversationId: null,
    messages: [],
    draftActions: [],
    context: null,
    loading: false,
    refreshing: false,
    actionBusy: {},
    error: '',
  };

  const starters = [
    'Show me the most important WooCommerce alerts.',
    'Summarize sales, orders, products, and low stock.',
    'Find products that may need a price review.',
  ];

  const root = document.getElementById('psa-assistant-root') || document.body.appendChild(document.createElement('div'));
  root.classList.add('psa-wc-root');

  function api(path, options) {
    return fetch(config.restUrl + path, {
      method: (options && options.method) || 'GET',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        'X-WP-Nonce': config.nonce,
      },
      body: options && options.body ? JSON.stringify(options.body) : undefined,
    }).then(async function (response) {
      const payload = await response.json().catch(function () { return {}; });
      if (!response.ok) {
        throw new Error(payload.message || payload.error || 'Assistant request failed');
      }
      return payload;
    });
  }

  function escapeHtml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function latestRefresh() {
    const documents = state.context && state.context.documents ? state.context.documents : [];
    return documents.reduce(function (latest, document) {
      if (!document.refreshedAt) return latest;
      if (!latest) return document.refreshedAt;
      return new Date(document.refreshedAt) > new Date(latest) ? document.refreshedAt : latest;
    }, '');
  }

  function renderMessage(message) {
    const isUser = message.role === 'user';
    return [
      '<div class="psa-wc-message-row ', isUser ? 'is-user' : 'is-assistant', '">',
      '<div class="psa-wc-message ', isUser ? 'is-user' : 'is-assistant', '">',
      escapeHtml(message.content),
      '</div></div>',
    ].join('');
  }

  function renderDraft(action) {
    const status = action.status || 'draft';
    const isWriteAction = writeActionTypes.has(action.type);
    const showActions = isWriteAction && !closedStatuses.has(status);
    const busy = state.actionBusy[action.id] || '';

    return [
      '<div class="psa-wc-draft" data-action-id="', action.id, '">',
      '<div class="psa-wc-draft-head"><div>',
      '<div class="psa-wc-draft-title">', escapeHtml(action.title), '</div>',
      '<p class="psa-wc-draft-reason">', escapeHtml(action.reason), '</p>',
      '</div><div>',
      isWriteAction ? '<span class="psa-wc-badge psa-wc-status-' + escapeHtml(status) + '">' + escapeHtml(status) + '</span>' : '',
      '<br><span class="psa-wc-badge">', Math.round((action.confidence || 0) * 100), '%</span>',
      '</div></div>',
      action.targetRoute ? '<a class="psa-wc-link" href="' + escapeHtml(action.targetRoute) + '">Open</a>' : '',
      showActions ? [
        '<div class="psa-wc-draft-actions">',
        '<button type="button" class="button button-primary psa-wc-apply" ', (!config.canApply || busy ? 'disabled' : ''), '>',
        busy === 'apply' ? 'Applying...' : 'Apply',
        '</button>',
        '<button type="button" class="button psa-wc-reject" ', (busy ? 'disabled' : ''), '>',
        busy === 'reject' ? 'Rejecting...' : 'Reject',
        '</button>',
        '</div>',
      ].join('') : '',
      '</div>',
    ].join('');
  }

  function render() {
    const subtitle = latestRefresh()
      ? 'Context: ' + new Date(latestRefresh()).toLocaleString()
      : 'Context not refreshed yet';

    root.innerHTML = [
      '<button type="button" class="psa-wc-fab" aria-label="AI Assistant">', state.open ? 'X' : 'AI', '</button>',
      '<aside class="psa-wc-drawer ', state.open ? 'is-open' : '', '">',
      '<header class="psa-wc-header"><div><h2 class="psa-wc-title">AI Assistant</h2><p class="psa-wc-subtitle">',
      escapeHtml(subtitle),
      '</p></div><button type="button" class="psa-wc-icon-button psa-wc-refresh" title="Refresh context">',
      state.refreshing ? '...' : 'Refresh',
      '</button></header>',
      '<div class="psa-wc-body">',
      state.messages.length === 0 ? '<div class="psa-wc-starters">' + starters.map(function (starter) {
        return '<button type="button" class="psa-wc-starter">' + escapeHtml(starter) + '</button>';
      }).join('') + '</div>' : '',
      state.messages.map(renderMessage).join(''),
      state.loading ? '<div class="psa-wc-loading">Working...</div>' : '',
      state.draftActions.length ? '<div class="psa-wc-drafts">' + state.draftActions.map(renderDraft).join('') + '</div>' : '',
      state.error ? '<div class="psa-wc-error">' + escapeHtml(state.error) + '</div>' : '',
      '</div>',
      '<form class="psa-wc-composer"><textarea class="psa-wc-input" rows="2" placeholder="Ask about your WooCommerce store..."></textarea>',
      '<button type="submit" class="button button-primary" ', state.loading ? 'disabled' : '', '>Send</button></form>',
      '</aside>',
    ].join('');

    bindEvents();
  }

  function bindEvents() {
    const fab = root.querySelector('.psa-wc-fab');
    const form = root.querySelector('.psa-wc-composer');
    const input = root.querySelector('.psa-wc-input');
    const refresh = root.querySelector('.psa-wc-refresh');

    if (fab) {
      fab.addEventListener('click', function () {
        state.open = !state.open;
        render();
        if (state.open && !state.context) loadContext();
      });
    }

    root.querySelectorAll('.psa-wc-starter').forEach(function (button) {
      button.addEventListener('click', function () {
        sendMessage(button.textContent);
      });
    });

    if (refresh) {
      refresh.addEventListener('click', refreshContext);
    }

    if (input) {
      input.addEventListener('keydown', function (event) {
        if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
          event.preventDefault();
          sendMessage(input.value);
        }
      });
    }

    if (form) {
      form.addEventListener('submit', function (event) {
        event.preventDefault();
        if (input) sendMessage(input.value);
      });
    }

    root.querySelectorAll('.psa-wc-draft').forEach(function (card) {
      const id = card.getAttribute('data-action-id');
      const action = state.draftActions.find(function (item) { return String(item.id) === String(id); });
      const apply = card.querySelector('.psa-wc-apply');
      const reject = card.querySelector('.psa-wc-reject');
      if (apply && action) apply.addEventListener('click', function () { applyAction(action); });
      if (reject && action) reject.addEventListener('click', function () { rejectAction(action); });
    });
  }

  function loadContext() {
    api('context').then(function (payload) {
      state.context = payload;
      render();
    }).catch(function (error) {
      state.error = error.message;
      render();
    });
  }

  function refreshContext() {
    if (state.refreshing) return;
    state.refreshing = true;
    state.error = '';
    render();
    api('context/refresh', { method: 'POST' }).then(function (payload) {
      state.context = payload;
    }).catch(function (error) {
      state.error = error.message;
    }).finally(function () {
      state.refreshing = false;
      render();
    });
  }

  function sendMessage(text) {
    const clean = String(text || '').trim();
    if (!clean || state.loading) return;
    state.loading = true;
    state.error = '';
    state.draftActions = [];
    state.messages.push({ role: 'user', content: clean });
    render();

    api('chat', {
      method: 'POST',
      body: {
        conversationId: state.conversationId,
        message: clean,
        locale: config.locale || 'en',
      },
    }).then(function (payload) {
      state.conversationId = payload.conversation && payload.conversation.id ? payload.conversation.id : state.conversationId;
      state.messages.push({ role: 'assistant', content: payload.answer || '' });
      state.draftActions = payload.draftActions || [];
    }).catch(function (error) {
      state.error = error.message;
      state.messages.push({ role: 'assistant', content: error.message });
    }).finally(function () {
      state.loading = false;
      render();
    });
  }

  function replaceAction(nextAction) {
    state.draftActions = state.draftActions.map(function (action) {
      return String(action.id) === String(nextAction.id) ? Object.assign({}, action, nextAction) : action;
    });
  }

  function applyAction(action) {
    state.actionBusy[action.id] = 'apply';
    state.error = '';
    render();
    api('draft-actions/' + action.id + '/apply', { method: 'POST' }).then(function (payload) {
      if (payload.draftAction) replaceAction(payload.draftAction);
    }).catch(function (error) {
      state.error = error.message;
      replaceAction(Object.assign({}, action, { status: 'failed', metadata: { error: error.message } }));
    }).finally(function () {
      delete state.actionBusy[action.id];
      render();
    });
  }

  function rejectAction(action) {
    state.actionBusy[action.id] = 'reject';
    state.error = '';
    render();
    api('draft-actions/' + action.id + '/reject', { method: 'POST' }).then(function (payload) {
      if (payload.draftAction) replaceAction(payload.draftAction);
    }).catch(function (error) {
      state.error = error.message;
    }).finally(function () {
      delete state.actionBusy[action.id];
      render();
    });
  }

  function bindSettingsMode() {
    const settings = document.querySelector('.psa-wc-settings');
    const serviceSettings = document.querySelector('.psa-wc-service-settings');
    if (!settings || !serviceSettings) return;

    function updateVisibility() {
      const selected = settings.querySelector('input[name="assistant_mode"]:checked');
      serviceSettings.style.display = selected && selected.value === 'service' ? '' : 'none';
    }

    settings.querySelectorAll('input[name="assistant_mode"]').forEach(function (input) {
      input.addEventListener('change', updateVisibility);
    });
    updateVisibility();
  }

  bindSettingsMode();
  render();
}());
