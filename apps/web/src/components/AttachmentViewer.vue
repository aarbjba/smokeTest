<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { marked } from 'marked';
import hljs from 'highlight.js/lib/common';
import 'highlight.js/styles/github-dark.css';
import type { Attachment } from '../types';
import { api } from '../api';

const props = defineProps<{ attachment: Attachment }>();
const emit = defineEmits<{ (e: 'close'): void }>();

const textContent = ref<string | null>(null);
const textLoading = ref(false);
const textError = ref<string | null>(null);

const previewUrl = computed(() => api.attachments.previewUrl(props.attachment.id));
const downloadUrl = computed(() => api.attachments.downloadUrl(props.attachment.id));

function extensionOf(name: string): string {
  const m = name.toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : '';
}

const LANG_BY_EXT: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  py: 'python', rb: 'ruby', go: 'go', rs: 'rust',
  cs: 'csharp', java: 'java', kt: 'kotlin',
  sh: 'bash', bash: 'bash', ps1: 'powershell',
  sql: 'sql', json: 'json', yml: 'yaml', yaml: 'yaml',
  xml: 'xml', html: 'html', css: 'css', vue: 'html',
  md: 'markdown', log: 'plaintext', txt: 'plaintext', eml: 'plaintext',
};

const language = computed(() => LANG_BY_EXT[extensionOf(props.attachment.filename)] ?? 'plaintext');
const isMarkdown = computed(() => extensionOf(props.attachment.filename) === 'md');

const renderedHtml = computed(() => {
  if (textContent.value == null) return '';
  if (isMarkdown.value) return marked.parse(textContent.value, { async: false }) as string;
  try {
    const res = hljs.highlight(textContent.value, { language: language.value, ignoreIllegals: true });
    return `<pre><code class="hljs language-${language.value}">${res.value}</code></pre>`;
  } catch {
    return `<pre><code>${escapeHtml(textContent.value)}</code></pre>`;
  }
});

function escapeHtml(s: string) {
  return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!));
}

async function loadText() {
  textLoading.value = true;
  textError.value = null;
  try {
    const resp = await fetch(previewUrl.value);
    if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText}`);
    textContent.value = await resp.text();
  } catch (e) {
    textError.value = e instanceof Error ? e.message : String(e);
  } finally {
    textLoading.value = false;
  }
}

watch(() => props.attachment.id, () => {
  textContent.value = null;
  if (props.attachment.kind === 'text') void loadText();
});

onMounted(() => {
  if (props.attachment.kind === 'text') void loadText();
  document.addEventListener('keydown', onKey);
});

function onKey(ev: KeyboardEvent) {
  if (ev.key === 'Escape') emit('close');
}

function humanSize(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(2)} MB`;
}

function onBackdropClick(ev: MouseEvent) {
  if (ev.target === ev.currentTarget) emit('close');
}
</script>

<template>
  <div class="viewer-backdrop" @click="onBackdropClick">
    <div class="viewer-modal" role="dialog" aria-modal="true">
      <header class="viewer-header">
        <div class="viewer-title">
          <strong>{{ attachment.filename }}</strong>
          <span class="sub">{{ humanSize(attachment.size) }} · {{ attachment.mime || attachment.kind }}</span>
        </div>
        <div class="viewer-actions">
          <a class="button-like" :href="downloadUrl" download>⬇ Download</a>
          <button @click="emit('close')">✕ Schließen (Esc)</button>
        </div>
      </header>

      <div class="viewer-body">
        <!-- Image -->
        <img
          v-if="attachment.kind === 'image'"
          :src="previewUrl"
          :alt="attachment.filename"
          class="viewer-image"
        />

        <!-- Video -->
        <video
          v-else-if="attachment.kind === 'video'"
          :src="previewUrl"
          controls
          class="viewer-media"
        />

        <!-- Audio -->
        <audio
          v-else-if="attachment.kind === 'audio'"
          :src="previewUrl"
          controls
          class="viewer-audio"
        />

        <!-- PDF (browser's built-in renderer) -->
        <iframe
          v-else-if="attachment.kind === 'pdf'"
          :src="previewUrl"
          class="viewer-iframe"
          :title="attachment.filename"
        />

        <!-- Text / Code / Markdown -->
        <div v-else-if="attachment.kind === 'text'" class="viewer-text">
          <div v-if="textLoading">Lade Inhalt…</div>
          <div v-else-if="textError" class="error-banner">{{ textError }}</div>
          <div v-else class="viewer-code-preview" v-html="renderedHtml" />
        </div>

        <!-- Everything else: metadata card with download -->
        <div v-else class="viewer-nopreview">
          <div class="big-icon">📦</div>
          <p>Keine Vorschau für diesen Dateityp verfügbar.</p>
          <a class="button-like primary" :href="downloadUrl" download>⬇ Herunterladen</a>
        </div>
      </div>
    </div>
  </div>
</template>
