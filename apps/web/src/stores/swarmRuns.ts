import { defineStore } from 'pinia';
import { ref } from 'vue';
import { api } from '../api';
import type { SwarmRunMeta, SwarmConfigMeta } from '../types';

export const useSwarmRunsStore = defineStore('swarmRuns', () => {
  const runs = ref<SwarmRunMeta[]>([]);
  const configs = ref<SwarmConfigMeta[]>([]);
  const totalRuns = ref(0);
  const loadingRuns = ref(false);
  const loadingConfigs = ref(false);
  const error = ref<string | null>(null);

  async function fetchRuns(params?: { limit?: number; offset?: number; status?: string }) {
    loadingRuns.value = true;
    try {
      const result = await api.swarm.runs.list(params);
      runs.value = result.runs;
      totalRuns.value = result.total;
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e);
    } finally {
      loadingRuns.value = false;
    }
  }

  async function fetchConfigs() {
    loadingConfigs.value = true;
    try {
      const result = await api.swarm.configs.list();
      configs.value = result.configs;
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e);
    } finally {
      loadingConfigs.value = false;
    }
  }

  async function deleteConfig(id: number) {
    await api.swarm.configs.delete(id);
    configs.value = configs.value.filter((c) => c.id !== id);
  }

  return {
    runs, configs, totalRuns,
    loadingRuns, loadingConfigs, error,
    fetchRuns, fetchConfigs, deleteConfig,
  };
});
