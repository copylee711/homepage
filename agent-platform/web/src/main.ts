import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import 'katex/dist/katex.min.css';
import './styles/tokens.css';
import './styles/base.css';
import './styles/markdown.css';

const pinia = createPinia();
const app = createApp(App).use(pinia);
if (import.meta.env.DEV) {
  (window as any).__pinia = pinia;
}
app.mount('#app');
