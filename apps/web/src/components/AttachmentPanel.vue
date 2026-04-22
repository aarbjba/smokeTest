<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import { api } from '../api';
import type { Attachment } from '../types';
import AttachmentViewer from './AttachmentViewer.vue';

const props = defineProps<{ todoId: number }>();

const attachments = ref<Attachment[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);
const uploading = ref(false);
const uploadProgress = ref<string | null>(null);
const viewerOpen = ref(false);
const viewerAttachment = ref<Attachment | null>(null);
const fileInput = ref<HTMLInputElement | null>(null);

async function load() {
  loading.value = true;
  error.value = null;
  try { attachments.value = await api.attachments.byTodo(props.todoId); }
  catch (e) { error.value = e instanceof Error ? e.message : String(e); }
  finally { loading.value = false; }
}

onMounted(load);
watch(() => props.todoId, load);

async function onFileInput(ev: Event) {
  const files = (ev.target as HTMLInputElement).files;
  if (!files || files.length === 0) return;
  await uploadFiles(Array.from(files));
  if (fileInput.value) fileInput.value.value = '';
}

async function uploadFiles(files: File[]) {
  if (files.length === 0) return;
  uploading.value = true;
  uploadProgress.value = `Lade ${files.length} Datei${files.length === 1 ? '' : 'en'} hoch…`;
  try {
    const created = await api.attachments.upload(props.todoId, files);
    attachments.value = [...created, ...attachments.value];
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    uploading.value = false;
    uploadProgress.value = null;
  }
}

// Drop files directly onto the panel (convenience: already in detail view).
const dragOver = ref(false);
function onDragOver(ev: DragEvent) {
  if (!ev.dataTransfer?.types.includes('Files')) return;
  ev.preventDefault();
  dragOver.value = true;
}
function onDragLeave() { dragOver.value = false; }
async function onDrop(ev: DragEvent) {
  if (!ev.dataTransfer?.types.includes('Files')) return;
  ev.preventDefault();
  dragOver.value = false;
  const files = ev.dataTransfer.files ? Array.from(ev.dataTransfer.files) : [];
  await uploadFiles(files);
}

async function removeAttachment(id: number) {
  if (!confirm('Anhang wirklich löschen?')) return;
  try {
    await api.attachments.remove(id);
    attachments.value = attachments.value.filter((a) => a.id !== id);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

function openViewer(a: Attachment) {
  viewerAttachment.value = a;
  viewerOpen.value = true;
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function iconFor(kind: string): string {
  switch (kind) {
    case 'image': return '🖼️';
    case 'video': return '🎞️';
    case 'audio': return '🔊';
    case 'pdf':   return '📄';
    case 'text':  return '📝';
    case 'archive': return '📦';
    case 'office':  return '📧';
    default:        return '📎';
  }
}
</script>

<template>
  <div
    class="attachment-panel"
    :class="{ 'drag-over': dragOver }"
    @dragover="onDragOver"
    @dragleave="onDragLeave"
    @drop="onDrop"
  >
    <div class="row" style="justify-content: space-between; align-items: center; margin-bottom: 0.5rem;">
      <h3 style="margin: 0;">📎 Anhänge <span v-if="attachments.length" class="count-chip">{{ attachments.length }}</span></h3>
      <div>
        <input
          ref="fileInput"
          type="file"
          multiple
          style="display:none"
          @change="onFileInput"
        />
        <button class="primary" :disabled="uploading" @click="fileInput?.click()">
          {{ uploading ? 'Lädt…' : '+ Datei hinzufügen' }}
        </button>
      </div>
    </div>

    <div v-if="uploadProgress" class="flash">{{ uploadProgress }}</div>
    <div v-if="error" class="error-banner">{{ error }}</div>

    <div v-if="attachments.length === 0 && !loading" class="empty">
      Noch keine Anhänge. Du kannst Dateien hierhin ziehen.
    </div>

    <ul class="attachment-list">
      <li v-for="a in attachments" :key="a.id" class="attachment-item">
        <div class="a-icon">{{ iconFor(a.kind) }}</div>
        <div class="a-meta">
          <div class="a-name">{{ a.filename }}</div>
          <div class="a-sub">
            <span>{{ humanSize(a.size) }}</span>
            <span>·</span>
            <span>{{ a.mime || a.kind }}</span>
            <span>·</span>
            <span>{{ new Date(a.created_at).toLocaleString() }}</span>
          </div>
        </div>
        <div class="a-actions">
          <button class="ghost" @click="openViewer(a)" title="Öffnen / Vorschau">👁</button>
          <a class="ghost button-like" :href="api.attachments.downloadUrl(a.id)" download>⬇ Download</a>
          <button class="danger" @click="removeAttachment(a.id)" title="Löschen">🗑</button>
        </div>
      </li>
    </ul>

    <AttachmentViewer
      v-if="viewerOpen && viewerAttachment"
      :attachment="viewerAttachment"
      @close="viewerOpen = false"
    />
  </div>
</template>
