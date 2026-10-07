import { readFileSync, readdirSync } from 'node:fs';
import { sep } from 'node:path';
import { defineConfig } from 'vitepress';

const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
const publishedPages = new Set<string>(pkg.files
  .filter((path: string) => path.startsWith('docs/'))
  .map((path: string) => path.slice('docs/'.length)));

export default defineConfig({
  lang: 'ru-RU',
  title: 'Lab Motion',
  description: 'Анимация веб-интерфейсов: установка, API и примеры интеграции.',
  base: process.env.DOCS_BASE ?? '/',
  lastUpdated: false,
  srcExclude: readdirSync(new URL('../', import.meta.url), { recursive: true })
    .map((path) => path.split(sep).join('/'))
    .filter((path) => path.endsWith('.md') && !publishedPages.has(path)),
  themeConfig: {
    nav: [
      { text: 'Документация', link: '/getting-started' },
      { text: 'API', link: '/api' },
      { text: 'Рецепты', link: '/recipes' },
    ],
    sidebar: [
      { text: 'Начало', items: [
        { text: 'Первый переход', link: '/getting-started' },
        { text: 'Справочник API', link: '/api' },
        { text: 'Рецепты', link: '/recipes' },
        { text: 'Миграция', link: '/migration' },
      ] },
      { text: 'Движение', items: [
        { text: 'Состояние компонента', link: '/bindings' },
        { text: 'Появление и уход', link: '/presence' },
        { text: 'Расположение элементов', link: '/projection' },
        { text: 'Переходы по ключу', link: '/smart' },
        { text: 'Токены', link: '/tokens' },
      ] },
      { text: 'Исполнение', items: [
        { text: 'Compositor', link: '/compositor' },
        { text: 'Компилятор Vite', link: '/compiler' },
        { text: 'Архитектура', link: '/architecture' },
        { text: 'Размер и измерения', link: '/benchmark' },
        { text: 'Коды ошибок', link: '/errors' },
      ] },
    ],
    socialLinks: [{ icon: 'github', link: 'https://github.com/Labpics-Team/lab-motion' }],
    search: { provider: 'local', options: { translations: {
      button: { buttonText: 'Поиск', buttonAriaLabel: 'Поиск по документации' },
      modal: {
        displayDetails: 'Показать подробности',
        resetButtonTitle: 'Сбросить поиск',
        backButtonTitle: 'Закрыть поиск',
        noResultsText: 'Ничего не найдено',
        footer: {
          selectText: 'выбрать', selectKeyAriaLabel: 'Enter',
          navigateText: 'перейти', navigateUpKeyAriaLabel: 'Стрелка вверх',
          navigateDownKeyAriaLabel: 'Стрелка вниз',
          closeText: 'закрыть', closeKeyAriaLabel: 'Escape',
        },
      },
    } } },
    outline: { label: 'На странице', level: [2, 3] },
    skipToContentLabel: 'К содержанию',
    sidebarMenuLabel: 'Разделы',
    returnToTopLabel: 'Наверх',
    darkModeSwitchLabel: 'Тема',
    lightModeSwitchTitle: 'Светлая тема',
    darkModeSwitchTitle: 'Тёмная тема',
    docFooter: { prev: 'Назад', next: 'Далее' },
    footer: { message: 'MIT. Labpics.' },
    notFound: {
      title: 'Страница не найдена',
      quote: 'Перейдите к документации или воспользуйтесь поиском.',
      linkLabel: 'На главную', linkText: 'На главную',
    },
  },
});
