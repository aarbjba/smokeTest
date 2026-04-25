import { ref } from 'vue';
import { defineStore } from 'pinia';
import { api } from '../api';
import type { CoordinatorTemplate, SubagentTemplate } from '../types';

export const useSwarmTemplatesStore = defineStore('swarmTemplates', () => {
  const coordinatorTemplates = ref<CoordinatorTemplate[]>([]);
  const subagentTemplates    = ref<SubagentTemplate[]>([]);
  const loading              = ref(false);
  const error                = ref<string | null>(null);

  async function fetchCoordinators() {
    try {
      const d = await api.swarm.templates.coordinators.list();
      coordinatorTemplates.value = d.templates;
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e);
    }
  }

  async function fetchSubagents() {
    try {
      const d = await api.swarm.templates.subagents.list();
      subagentTemplates.value = d.templates;
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e);
    }
  }

  async function fetchAll() {
    loading.value = true;
    error.value = null;
    try {
      await Promise.all([fetchCoordinators(), fetchSubagents()]);
    } finally {
      loading.value = false;
    }
  }

  async function createCoordinator(data: Partial<CoordinatorTemplate>): Promise<CoordinatorTemplate | null> {
    try {
      const d = await api.swarm.templates.coordinators.create(data);
      coordinatorTemplates.value.unshift(d.template);
      return d.template;
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e);
      return null;
    }
  }

  async function updateCoordinator(id: number, data: Partial<CoordinatorTemplate>): Promise<CoordinatorTemplate | null> {
    try {
      const d = await api.swarm.templates.coordinators.update(id, data);
      const idx = coordinatorTemplates.value.findIndex((t) => t.id === id);
      if (idx >= 0) coordinatorTemplates.value[idx] = d.template;
      return d.template;
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e);
      return null;
    }
  }

  async function deleteCoordinator(id: number) {
    try {
      await api.swarm.templates.coordinators.delete(id);
      coordinatorTemplates.value = coordinatorTemplates.value.filter((t) => t.id !== id);
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e);
    }
  }

  async function createSubagent(data: Partial<SubagentTemplate>): Promise<SubagentTemplate | null> {
    try {
      const d = await api.swarm.templates.subagents.create(data);
      subagentTemplates.value.unshift(d.template);
      return d.template;
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e);
      return null;
    }
  }

  async function updateSubagent(id: number, data: Partial<SubagentTemplate>): Promise<SubagentTemplate | null> {
    try {
      const d = await api.swarm.templates.subagents.update(id, data);
      const idx = subagentTemplates.value.findIndex((t) => t.id === id);
      if (idx >= 0) subagentTemplates.value[idx] = d.template;
      return d.template;
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e);
      return null;
    }
  }

  async function deleteSubagent(id: number) {
    try {
      await api.swarm.templates.subagents.delete(id);
      subagentTemplates.value = subagentTemplates.value.filter((t) => t.id !== id);
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e);
    }
  }

  return {
    coordinatorTemplates,
    subagentTemplates,
    loading,
    error,
    fetchCoordinators,
    fetchSubagents,
    fetchAll,
    createCoordinator,
    updateCoordinator,
    deleteCoordinator,
    createSubagent,
    updateSubagent,
    deleteSubagent,
  };
});
