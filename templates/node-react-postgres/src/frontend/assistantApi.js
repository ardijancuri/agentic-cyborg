import { api } from '../services/api.js';

export const assistantApi = {
  chat: (data) => api.post('/assistant/chat', data).then((res) => res.data),
  getContext: () => api.get('/assistant/context').then((res) => res.data),
  refreshContext: () => api.post('/assistant/context/refresh').then((res) => res.data),
  applyDraftAction: (id) => api.post(`/assistant/draft-actions/${id}/apply`).then((res) => res.data),
  rejectDraftAction: (id) => api.post(`/assistant/draft-actions/${id}/reject`).then((res) => res.data),
};
