import React from 'react';
import AssistantButton from '@oninova/personal-software-assistant/react';
import '@oninova/personal-software-assistant/react/styles.css';
import { assistantApi } from './assistantApi.js';

export default function AssistantAddon({ user, locale = 'en' }) {
  const canUseAssistant = user?.role === 'admin' || user?.role === 'full_admin';

  return (
    <AssistantButton
      api={assistantApi}
      canUseAssistant={canUseAssistant}
      locale={locale}
    />
  );
}
