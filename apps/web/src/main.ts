import { createApp } from 'vue';
import { createPinia } from 'pinia';
import { createRouter, createWebHistory } from 'vue-router';
import App from './App.vue';
import BoardView from './views/BoardView.vue';
import SettingsView from './views/SettingsView.vue';
import TodoDetailView from './views/TodoDetailView.vue';
import PapierkorbView from './views/PapierkorbView.vue';
import PendingView from './views/PendingView.vue';
import SwarmRunsView from './views/SwarmRunsView.vue';
import SwarmArchitectView from './views/SwarmArchitectView.vue';
import SwarmReplayView from './views/SwarmReplayView.vue';
import SwarmTemplatesView from './views/SwarmTemplatesView.vue';
import { useSettingsStore } from './stores/settings';
import './styles/themes.css';
import './styles/app.css';

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'board', component: BoardView },
    { path: '/todo/new', name: 'todo-new', component: TodoDetailView, props: { id: 'new' } },
    { path: '/todo/:id', name: 'todo', component: TodoDetailView, props: true },
    { path: '/pending', name: 'pending', component: PendingView },
    { path: '/papierkorb', name: 'papierkorb', component: PapierkorbView },
    { path: '/settings', name: 'settings', component: SettingsView },
    { path: '/swarm', name: 'swarm-runs', component: SwarmRunsView },
    { path: '/swarm/architect', name: 'swarm-architect', component: SwarmArchitectView },
    { path: '/swarm/runs/:id', name: 'swarm-replay', component: SwarmReplayView },
    { path: '/swarm/templates', name: 'swarm-templates', component: SwarmTemplatesView },
  ],
});

const app = createApp(App);
app.use(createPinia());
app.use(router);

const settings = useSettingsStore();
settings.applyTheme(settings.theme);

app.mount('#app');
