import { createApp } from 'vue';
import { createPinia } from 'pinia';
import { createRouter, createWebHistory } from 'vue-router';
import App from './App.vue';
import BoardView from './views/BoardView.vue';
import SettingsView from './views/SettingsView.vue';
import TodoDetailView from './views/TodoDetailView.vue';
import PapierkorbView from './views/PapierkorbView.vue';
import { useSettingsStore } from './stores/settings';
import './styles/themes.css';
import './styles/app.css';

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'board', component: BoardView },
    { path: '/todo/:id', name: 'todo', component: TodoDetailView, props: true },
    { path: '/papierkorb', name: 'papierkorb', component: PapierkorbView },
    { path: '/settings', name: 'settings', component: SettingsView },
  ],
});

const app = createApp(App);
app.use(createPinia());
app.use(router);

const settings = useSettingsStore();
settings.applyTheme(settings.theme);

app.mount('#app');
