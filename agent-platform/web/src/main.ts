import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import OfficeWindow from './components/OfficeWindow.vue';
import 'katex/dist/katex.min.css';
import './styles/tokens.css';
import './styles/base.css';
import './styles/markdown.css';

// `?preview=1&path=…` opens a document in its own window without the console.
const standalone = new URLSearchParams(location.search).get('preview') === '1';
const pinia = createPinia();
const app = createApp(standalone ? OfficeWindow : App).use(pinia);
if (import.meta.env.DEV) {
  (window as any).__pinia = pinia;
}
app.mount('#app');
