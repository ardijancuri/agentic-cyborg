import { api } from '../services/api.js';

export const assistantApi = {
  chat: (data) => api.post('/assistant/chat', data).then((res) => res.data),
  getConversations: () => api.get('/assistant/conversations').then((res) => res.data),
  getConversation: (id) => api.get(`/assistant/conversations/${id}`).then((res) => res.data),
  getContext: () => api.get('/assistant/context').then((res) => res.data),
  getCapabilities: () => api.get('/assistant/capabilities').then((res) => res.data),
  refreshContext: () => api.post('/assistant/context/refresh').then((res) => res.data),
  applyDraftAction: (id) => api.post(`/assistant/draft-actions/${id}/apply`).then((res) => res.data),
  previewDraftAction: (id) => api.post(`/assistant/draft-actions/${id}/preview`).then((res) => res.data),
  rejectDraftAction: (id) => api.post(`/assistant/draft-actions/${id}/reject`).then((res) => res.data),
};
