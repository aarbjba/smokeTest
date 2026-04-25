import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { api } from '../api';

export interface ArchitectMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

export const useSwarmArchitectStore = defineStore('swarmArchitect', () => {
  const todoId = ref<number | null>(null);
  const messages = ref<ArchitectMessage[]>([]);
  const liveConfig = ref<unknown>(null);
  const finalizedConfigId = ref<number | null>(null);
  const loading = ref(false);
  const error = ref<string | null>(null);
  const streaming = ref(false);

  let eventSource: EventSource | null = null;
  let currentAssistantMsg: ArchitectMessage | null = null;

  const isActive = computed(() => todoId.value !== null);

  function subscribeStream(id: number) {
    if (eventSource) { eventSource.close(); eventSource = null; }
    currentAssistantMsg = null;
    const url = api.swarm.architect.streamUrl(id);
    eventSource = new EventSource(url);

    eventSource.addEventListener('chunk', (e: MessageEvent) => {
      const data = JSON.parse(e.data) as { text: string };
      if (!currentAssistantMsg) {
        currentAssistantMsg = { role: 'assistant', content: '', timestamp: Date.now() };
        messages.value.push(currentAssistantMsg);
        streaming.value = true;
      }
      currentAssistantMsg.content += data.text ?? '';
    });

    eventSource.addEventListener('propose-config', (e: MessageEvent) => {
      const data = JSON.parse(e.data) as { config: unknown };
      liveConfig.value = data.config;
    });

    eventSource.addEventListener('finalize-config', () => {
      // Config was submitted; SwarmArchitectView will refetch configs to get the new id.
      // We set a sentinel so the view knows to poll.
      finalizedConfigId.value = -1;
    });

    eventSource.addEventListener('turn-end', () => {
      streaming.value = false;
      currentAssistantMsg = null;
    });

    eventSource.addEventListener('end', () => {
      streaming.value = false;
      currentAssistantMsg = null;
    });

    eventSource.onerror = () => {
      streaming.value = false;
      currentAssistantMsg = null;
    };
  }

  async function start(goal?: string) {
    if (loading.value) return;
    loading.value = true;
    error.value = null;
    try {
      const result = await api.swarm.architect.start(goal);
      todoId.value = result.todoId;
      messages.value = [];
      liveConfig.value = null;
      finalizedConfigId.value = null;
      if (goal?.trim()) {
        messages.value.push({ role: 'user', content: goal, timestamp: Date.now() });
      }
      subscribeStream(result.todoId);
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e);
    } finally {
      loading.value = false;
    }
  }

  async function send(message: string) {
    if (!todoId.value || !message.trim()) return;
    messages.value.push({ role: 'user', content: message, timestamp: Date.now() });
    currentAssistantMsg = null;
    streaming.value = true;
    try {
      await api.swarm.architect.send(todoId.value, message);
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e);
      streaming.value = false;
    }
  }

  async function clear() {
    if (eventSource) { eventSource.close(); eventSource = null; }
    if (todoId.value !== null) {
      try { await api.swarm.architect.clearSession(todoId.value); } catch { /* ignore */ }
    }
    todoId.value = null;
    messages.value = [];
    liveConfig.value = null;
    finalizedConfigId.value = null;
    streaming.value = false;
    currentAssistantMsg = null;
    error.value = null;
  }

  return {
    todoId, messages, liveConfig, finalizedConfigId,
    loading, error, streaming, isActive,
    start, send, clear,
  };
});
