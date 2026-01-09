import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import Icons from 'unplugin-icons/vite'
import Components from 'unplugin-vue-components/vite'
import IconsResolver from 'unplugin-icons/resolver'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  base: '/EnglishWriter/',
  plugins: [
    vue(),
    tailwindcss(),
    Icons(),
    Components({
      resolvers: [IconsResolver()],
    }),
  ],
})