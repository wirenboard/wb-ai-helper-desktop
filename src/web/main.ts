import { createApp } from 'vue'
import App from './App.vue'
import './styles.css'
import './i18n' // side-effect: detect lang, set <html lang>; components import t/plural/fmtSize directly

createApp(App).mount('#app')
