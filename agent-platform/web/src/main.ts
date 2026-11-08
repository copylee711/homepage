import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import 'katex/dist/katex.min.css';
import './styles/tokens.css';
import './styles/base.css';
import './styles/markdown.css';

// `?preview=1&path=…` opens a document in its own window without the console.
// The standalone shell is fetched on demand so its Office bundle stays out of
// the console's first load.
const standalone = new URLSearchParams(location.search).get('preview') === '1';
const pinia = createPinia();
if (import.meta.env.DEV) {
  (window as any).__pinia = pinia;
}
if (standalone) {
  void import('./components/OfficeWindow.vue').then(({ default: OfficeWindow }) => {
    createApp(OfficeWindow).use(pinia).mount('#app');
  });
} else {
  createApp(App).use(pinia).mount('#app');
}
