# Knowledge Studio

Инструмент для глубокого изучения любой темы через дерево вопросов.

## Быстрый старт

```bash
npm install
npm start
```

## Структура проекта

```
src/
├── main.js              ← Electron main: окно, IPC, clipboard polling, файловые диалоги
├── preload.js           ← contextBridge: безопасный мост main ↔ renderer
├── index.html           ← скелет UI (все панели, модалы, toast)
├── renderer/
│   ├── index.js         ← инициализация, глобальные бинды, resize handles, хоткеи
│   ├── state.js         ← единое состояние (pub/sub, helpers для тем и узлов)
│   ├── ipc.js           ← обёртки над electronAPI + graceful fallback
│   ├── tree-helpers.js  ← чистые функции: CRUD дерева, flatten, stats, word index
│   ├── render.js        ← отрисовка: сайдбар, дерево, breadcrumb, mode switch
│   ├── answer-panel.js  ← панель ответа + minimal markdown→HTML renderer
│   ├── clipboard.js     ← polling буфера, toast с предложением вставки
│   ├── crossref.js      ← подсветка перекрёстных ссылок, tooltip
│   ├── browser.js       ← встроенный браузер с вкладками (Claude/ChatGPT/Gemini)
│   ├── files.js         ← работа с файлами (stub → следующий этап)
│   ├── export.js        ← генерация HTML-учебника
│   ├── prompt.js        ← шаблоны промптов
│   ├── graph.js         ← граф на Canvas с force-layout
│   └── settings.js      ← тема, persist настроек
└── styles/
    ├── main.css         ← базовые стили, layout, компоненты
    └── themes.css       ← CSS-переменные dark/light
```

## Хоткеи

| Действие              | Хоткей         |
|-----------------------|----------------|
| Новая тема            | Cmd/Ctrl + N   |
| Браузер toggle        | Cmd/Ctrl + B   |
| Экспорт учебника      | Cmd/Ctrl + E   |
| Список (tree)         | Cmd/Ctrl + 1   |
| Граф                  | Cmd/Ctrl + 2   |
| Учебник               | Cmd/Ctrl + 3   |
| Закрыть / Escape      | Esc            |

## Следующие этапы

1. **Дерево** — inline-редактирование узлов, drag-and-drop для перемещения
2. **Ответы** — полная crossref-подсветка, history ответов на узел
3. **Граф** — drag узлов, клик → открыть ответ, zoom wheel
4. **Браузер** — auto-inject вопроса в поле ввода ИИ через executeJavaScript
5. **Файлы** — PDF viewer (pdf.js), скриншот страницы → отправка в ИИ
6. **Авторежим** — последовательный обход дерева, Anthropic API
7. **Persist** — сохранение всего в electron-store, restore при запуске
8. **Учебник** — прогресс чтения, интерактивные карточки, тёмная тема
