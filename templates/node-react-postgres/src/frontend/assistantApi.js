import { api } from '../services/api.js';

export const assistantApi = {
  chat: (data) => api.post('/assistant/chat', data).then((res) => res.data),
  getContext: () => api.get('/assistant/context').then((res) => res.data),
  refreshContext: () => api.post('/assistant/context/refresh').then((res) => res.data),
};
