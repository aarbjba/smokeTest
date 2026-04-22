<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { marked } from 'marked';
import hljs from 'highlight.js/lib/common';
import 'highlight.js/styles/github-dark.css';
import type { Snippet } from '../types';
import { linkifyStackTrace, linkifyStackTraceInHtml } from '../utils/linkifyStackTrace';

const props = defineProps<{ snippet: Snippet }>();
const emit = defineEmits<{
  (e: 'save', patch: Partial<Snippet>): void;
  (e: 'delete'): void;
}>();

const title = ref(props.snippet.title);
const language = ref(props.snippet.language);
const content = ref(props.snippet.content);
const editing = ref(props.snippet.content.length === 0);
const saving = ref(false);

watch(() => props.snippet.id, () => {
  title.value = props.snippet.title;
  language.value = props.snippet.language;
  content.value = props.snippet.content;
});

const rendered = computed(() => {
  if (language.value === 'markdown') {
    const html = marked.parse(content.value || '', { async: false }) as string;
    // Post-process: wrap stack-trace-style paths in vscode:// links.
    return linkifyStackTraceInHtml(html);
  }
  if (language.value === 'plaintext') {
    // Plaintext: run linkify directly on the raw content (it already escapes),
    // then wrap in a <pre> for monospaced display.
    return `<pre><code class="hljs language-plaintext">${linkifyStackTrace(content.value)}</code></pre>`;
  }
  try {
    const highlighted = hljs.highlight(content.value, { language: language.value }).value;
    const wrapped = `<pre><code class="hljs language-${language.value}">${highlighted}</code></pre>`;
    // Post-process hljs output too — stack traces in code snippets should still linkify.
    return linkifyStackTraceInHtml(wrapped);
  } catch {
    return `<pre><code>${linkifyStackTrace(content.value)}</code></pre>`;
  }
});

function escapeHtml(s: string) {
  return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!));
}

async function save() {
  saving.value = true;
  try {
    emit('save', { title: title.value, language: language.value, content: content.value });
    editing.value = false;
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div class="snippet">
    <div class="head">
      <input v-model="title" type="text" placeholder="Titel (optional)" />
      <select v-model="language" style="max-width: 12rem;">
        <option value="markdown">markdown</option>
        <option value="bash">bash</option>
        <option value="sql">sql</option>
        <option value="javascript">javascript</option>
        <option value="typescript">typescript</option>
        <option value="python">python</option>
        <option value="json">json</option>
        <option value="yaml">yaml</option>
        <option value="html">html</option>
        <option value="css">css</option>
        <option value="plaintext">plaintext</option>
      </select>
      <button class="ghost" @click="editing = !editing">{{ editing ? 'Vorschau' : 'Bearbeiten' }}</button>
      <button class="primary" :disabled="saving" @click="save">Speichern</button>
      <button class="danger" @click="emit('delete')" title="Snippet löschen">🗑</button>
    </div>
    <textarea v-if="editing" v-model="content" spellcheck="false" placeholder="# Notizen oder Code..." />
    <div v-else class="preview" v-html="rendered" />
  </div>
</template>
