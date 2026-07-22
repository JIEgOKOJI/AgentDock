# План реализации встроенного браузера и автоматического Browser MCP

## 1. Цель и ожидаемое поведение

Добавить в AgentDock встроенный браузер, которым одновременно пользуются человек и запущенные из приложения CLI-агенты.

Целевой сценарий:

1. Пользователь нажимает многоточие справа в верхней панели.
2. Dropdown показывает пункт «Открыть встроенный браузер».
3. В центральной панели появляется браузер с адресной строкой и навигацией.
4. Пользователь может открыть страницу, авторизоваться и работать с ней.
5. Каждый CLI-агент автоматически получает MCP-сервер `agentdock-browser`; ручная настройка Codex, Claude Code или OpenCode не нужна.
6. По фразе «посмотри в открытом браузере» агент читает живое состояние именно той вкладки, которую видит пользователь.
7. Агент может сам открыть браузер, перейти на локальный dev-сервер, проверить вёрстку, сделать screenshot и выполнить допустимые действия.

Ключевой принцип: UI и Browser MCP управляют одним экземпляром Chromium/WebContents. Отдельный Playwright-браузер эту задачу не решает.

## 2. Текущее состояние проекта

- `src/App.tsx` содержит основной React UI. Кнопка `MoreHorizontal` уже есть в `panel-toolbar`, но без обработчика.
- `src/styles.css` содержит shell, toolbar и существующие dropdown-паттерны.
- `electron/main.cjs` создаёт единственный `BrowserWindow`, регистрирует IPC и запускает CLI в `agent:run`.
- `electron/preload.cjs` экспортирует узкий `window.agentDock` через `contextBridge`.
- `src/vite-env.d.ts` описывает renderer-facing API.
- `electron/adapters.cjs` строит argv Codex, Claude Code и OpenCode.
- `electron/permissions.cjs` уже реализует provider-specific argv/env без ручной настройки.
- `loadMcpServers()` только читает постоянные CLI-конфиги; встроенный MCP нужно добавлять отдельно как managed integration.
- MCP SDK и browser-control слой пока отсутствуют.

Перед кодированием проверить MCP-флаги на поддерживаемых версиях всех трёх CLI. Провайдерные детали изолировать в одном модуле и зафиксировать contract tests.

## 3. Архитектура

```text
React renderer
  ├─ dropdown и browser chrome
  ├─ placeholder сообщает bounds области
  └─ browser state/action events через preload
                         │ IPC
                         ▼
Electron main process
  ├─ BrowserManager → один WebContentsView
  ├─ BrowserAutomation → CDP текущего webContents
  ├─ Browser MCP bridge → 127.0.0.1 + случайный token
  └─ Agent runner → ephemeral MCP config для каждого CLI run
                         │ MCP
                         ▼
Codex CLI / Claude Code / OpenCode
  └─ сервер `agentdock-browser`, подключённый автоматически
```

Использовать `WebContentsView`, присоединённый к `BrowserWindow.contentView`, а не iframe: сторонние сайты ограничивают iframe, а отдельный webContents даёт полноценную навигацию, cookies, авторизацию и Chrome DevTools Protocol. Не использовать устаревающий `BrowserView`. Electron и MCP SDK следует закрепить точными версиями вместо `latest`.

Рекомендуемые модули:

- `electron/browser-manager.cjs` — lifecycle, state, navigation, bounds, events.
- `electron/browser-automation.cjs` — CDP, snapshot, screenshot, refs и actions.
- `electron/browser-mcp.cjs` — transport, tool schemas и error mapping.
- `electron/browser-mcp-config.cjs` — автоподключение провайдеров и cleanup.
- `src/components/BrowserView.tsx` — browser chrome и bounds placeholder.
- `src/components/MoreMenu.tsx` — dropdown многоточия.
- `test/browser-*.test.cjs` — unit/contract tests.

`main.cjs` только связывает сервисы, IPC и agent launch; не складывать всю автоматизацию в один файл.

## 4. Состояние браузера

Для MVP одна вкладка, но интерфейс расширяемый:

```ts
interface BrowserTabState {
  id: string
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  visible: boolean
  revision: number
  lastError?: string
}

interface BrowserActionState {
  actor: 'user' | 'agent'
  tool?: string
  status: 'started' | 'completed' | 'failed'
  startedAt: number
  summary: string
}
```

`revision` увеличивается при навигации и смене документа. Element refs из snapshot привязаны к revision, чтобы агент не кликал устаревший элемент.

Браузер общий для chat sessions и провайдеров текущего процесса. Последний URL можно хранить в `settings.json`; DOM, screenshots и историю browser actions в session store не сохранять.

## 5. Пользовательский интерфейс

### 5.1. Dropdown

В `App.tsx` добавить `moreMenuOpen`, контейнер для `MoreHorizontal`, а также `aria-haspopup=menu`, `aria-expanded`, `aria-controls` и `aria-label`. Пункт получает текст «Открыть встроенный браузер», после создания — «Показать встроенный браузер» или status/check.

Меню закрывается по Escape, клику вне, выбору и потере фокуса. Не блокировать доступ к браузеру во время agent run. Стили строить на существующих `provider-menu`, `branch-menu`, `permission-menu`; общую dropdown-базу при необходимости вынести.

### 5.2. Browser view

Добавить `ViewId = 'browser'`. Пункт меню переключает main panel и вызывает `browser.open()`.

Browser chrome содержит:

- back, forward, reload/stop;
- адресную строку и loading/error state;
- открытие текущего URL во внешнем браузере;
- скрытие browser view;
- индикатор «Agent is viewing/controlling» и кнопку отмены.

URL policy: `localhost:5173` → `http://localhost:5173`, домен без схемы → `https://...`; разрешены `http:`/`https:`, а `file:` решается отдельно. Запретить `javascript:`, `data:` и неизвестные схемы. Неверный URL показывает ошибку, не роняя main process.

### 5.3. Bounds `WebContentsView`

`WebContentsView` рисуется поверх renderer DOM. Placeholder использует `ResizeObserver` + `getBoundingClientRect()` и отправляет `browser:set-bounds` с throttling через `requestAnimationFrame`. Обновлять при resize окна, sidebar collapse и смене toolbar. Main валидирует, округляет и ограничивает bounds размерами окна. До получения ненулевых bounds и на других views слой скрыт, иначе он перекроет dropdown и диалоги.

Electron принимает device-independent pixels; не умножать размеры на `devicePixelRatio` без платформенного теста.

## 6. BrowserManager

После `app.whenReady()`:

- лениво создать `WebContentsView` при первом пользовательском или агентском `open`;
- добавить через `window.contentView.addChildView(...)`;
- использовать partition `persist:agentdock-browser`, сохраняя login/cookies;
- не смешивать session с renderer AgentDock;
- при hide скрывать view без уничтожения страницы;
- при shutdown detach debugger, остановить MCP и уничтожить guest webContents;
- вызов агента `browser_open` при скрытом браузере по умолчанию показывает view, чтобы действие было видно.

Guest webContents: `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`, без AgentDock preload. Camera/microphone/geolocation/notifications/clipboard запрещены по умолчанию. Downloads запрещены либо подтверждаются. `window.open` не создаёт неучтённые окна. MCP не получает cookies, storage, password fields и request headers.

Слушать `did-start-loading`, `did-stop-loading`, `did-navigate`, `did-navigate-in-page`, `page-title-updated`, `did-fail-load`, history state и `render-process-gone`. Изменения отправлять renderer событием `browser:state`, без polling.

## 7. Preload и IPC

Добавить типизированный API в `preload.cjs` и `vite-env.d.ts`:

```ts
browser: {
  getState(): Promise<BrowserTabState | null>
  open(url?: string): Promise<BrowserTabState>
  show(): Promise<void>
  hide(): Promise<void>
  navigate(url: string): Promise<BrowserTabState>
  back(): Promise<void>
  forward(): Promise<void>
  reload(): Promise<void>
  stop(): Promise<void>
  setBounds(bounds: Rect): Promise<void>
  openExternal(): Promise<void>
  cancelAgentAction(): Promise<void>
  onState(listener: (state: BrowserTabState) => void): () => void
  onAction(listener: (action: BrowserActionState) => void): () => void
}
```

## 8. Browser automation через CDP

`browser-automation.cjs` лениво подключает `webContents.debugger` к browser view, а не к UI AgentDock. MVP: URL/title/loading, accessibility/DOM snapshot, screenshot, navigation, click, type/fill, select, keyboard, scroll и wait for text/URL/loading.

Предпочитать Accessibility/DOMSnapshot и CDP DOM/Input. Не давать агенту произвольный JavaScript. Snapshot возвращает refs вроде `[e12] button Sign-in`. Внутренний ref: `{ revision, backendNodeId, frameId }`; перед действием проверять revision, существование, видимость и допустимость. Для stale ref предложить новый `browser_snapshot`.

Mutating-команды проходят через async mutex/queue; navigation инвалидирует refs. UI получает started/completed/failed. Кнопка отмены прерывает wait и очередь. У всех tools есть timeout.

## 9. MCP-сервер

Один Streamable HTTP MCP transport работает в Electron main:

- bind только `127.0.0.1`, порт `0`;
- cryptographic bearer token/unguessable endpoint на запуск;
- старт до первого CLI run, stop в `before-quit`;
- endpoint/token только в памяти и временных CLI-конфигах;
- audit содержит tool/time/result/runId, но не ввод, DOM или screenshot.

Если поддерживаемый CLI не умеет HTTP transport, добавить bundled stdio proxy к тому же bridge. Не создавать отдельный BrowserManager на CLI. Использовать официальный MCP SDK фиксированной версии.

Tools MVP:

- `browser_get_state` — URL/title/loading/visibility;
- `browser_open` и `browser_navigate`;
- `browser_snapshot` — живое дерево и refs;
- `browser_screenshot` — PNG viewport с лимитом;
- `browser_click`, `browser_type`, `browser_select`;
- `browser_press_key`, `browser_scroll`, `browser_wait`;
- `browser_back`, `browser_forward`, `browser_reload`.

Descriptions явно сообщают, что это общий видимый браузер AgentDock. Ошибки: `NO_BROWSER`, `INVALID_URL`, `STALE_REF`, `ELEMENT_NOT_FOUND`, `NAVIGATION_FAILED`, `TIMEOUT`, `USER_CANCELLED`, `FORBIDDEN_ACTION`, `BROWSER_CRASHED`.

## 10. Автоподключение MCP к CLI

Не выполнять `mcp add` и не менять global configs. Создать:

```js
browserMcpLaunchOptions(provider, descriptor, runId) => {
  args: string[],
  env: Record<string, string>,
  cleanup: async () => void,
}
```

Результат объединяется с `permissionLaunchOptions` и adapter args. `descriptor` содержит имя `agentdock-browser`, URL и безопасную ссылку на credential.

Compatibility spike подтверждает синтаксис:

- **Codex:** config только для конкретного `codex exec` через `-c mcp_servers.agentdock-browser...` или поддерживаемый ephemeral override; token через env reference, если возможно.
- **Claude Code:** временный JSON MCP config в `app.getPath('temp')/agentdock/<runId>/`, переданный через `--mcp-config`. Не использовать `--strict-mcp-config`, чтобы сохранить пользовательские MCP.
- **OpenCode:** merge server в существующий `OPENCODE_CONFIG_CONTENT`, сохранив все поля и permission config.

Сервер добавляется в каждый `agent:run`; пользовательские MCP сохраняются. Cleanup выполняется на close/error/stop/shutdown. Token не попадает в renderer, transcript, events и логи. Если bridge не готов, run завершается до prompt с понятной ошибкой.

### Browser-awareness prompt

Рядом с `globalSkillPrompt` автоматически добавлять:

```text
<agentdock_browser>
The MCP server agentdock-browser controls AgentDock shared embedded browser.
If the user refers to the open/current/embedded browser, inspect it with
browser_get_state and browser_snapshot before answering or acting.
Use browser_open when inspection of the web part of the project is needed.
The page is visible to the user; require approval for sensitive actions.
</agentdock_browser>
```

Можно добавить текущие URL/title, но не DOM/screenshot: они устаревают. Агент запрашивает live snapshot. Skill и пользовательская настройка не нужны.

## 11. Permissions и безопасность

Browser policy отдельна от `ask/auto/full`, относящихся к shell/filesystem:

- read-only state/snapshot/screenshot разрешены автоматически;
- локальная navigation, scroll и обычные actions видимы;
- submit, download, clipboard, permission prompt, external app и необратимые действия требуют подтверждения;
- password/card/CVV/token/secret fields запрещены для чтения и автозаполнения;
- cookies/localStorage/sessionStorage недоступны MCP;
- UI показывает actor/tool/action и кнопку немедленной отмены.

Для первого релиза допустимо подтверждать всё, кроме чтения и localhost navigation. Не привязывать browser approvals автоматически к `permissionMode: full`.

Approval асинхронный: MCP ждёт решение renderer с timeout, main сверяет action id, закрытие окна возвращает `USER_CANCELLED`.

## 12. Отображение в MCP servers

`loadMcpServers()` всегда добавляет managed-запись `agentdock-browser` с провайдерами Codex, Claude и OpenCode. Статус `Enabled`, когда bridge готов; иначе `Unavailable` с безопасной диагностикой. Gear не должен открывать provider config. Ephemeral server намеренно может отсутствовать в `cli mcp list` вне AgentDock run.

## 13. Этапы реализации

### A. Compatibility spike

1. Зафиксировать Electron/MCP SDK.
2. Проверить `WebContentsView` на целевых платформах.
3. Доказать ephemeral MCP launch для трёх CLI без изменения home config.
4. Зафиксировать config shapes в contract tests.
5. Выбрать HTTP либо HTTP + stdio proxy fallback.

Результат: все CLI видят тестовый `browser_get_state`.

### B. Пользовательский браузер

1. BrowserManager и persistent partition.
2. IPC/preload/types.
3. Dropdown.
4. BrowserView, chrome, navigation, state events, bounds sync.
5. Hide/show, resize, sidebar, shutdown.

### C. Automation

1. CDP lifecycle.
2. State/snapshot/screenshot.
3. Revision-aware refs.
4. Actions и waits.
5. Mutex, timeout, cancellation, action events.

### D. MCP и автоподключение

1. Защищённый loopback bridge.
2. Tools и structured errors.
3. Provider launch options.
4. Prepare/cleanup в `agent:run`/`agent:stop`.
5. Browser-awareness prompt.
6. Managed MCP row.

### E. Approvals и устойчивость

1. Read/write/sensitive classification.
2. Confirmation UI и cancel.
3. Redacted audit.
4. Browser crash, MCP reconnect, CLI cancellation.
5. Лимиты результатов и защита от зависаний.

### F. Полировка

Добавить empty/error states, настройки последнего URL, поведения agent-open и очистки browser data, обновить README/screenshots. Затем возможен multi-tab без изменения основных tool names.

## 14. Тестирование

Unit tests:

- URL normalization/scheme denylist и bounds validation;
- BrowserManager transitions и revision/stale refs;
- MCP schemas/error mapping/redaction;
- mutex/timeout/cancellation;
- merge provider configs без потери MCP/permissions;
- cleanup на success/error/stop;
- browser prompt добавляется ровно один раз.

Integration fixture с button, textbox, select, SPA navigation, iframe и delayed content:

1. открыть fixture из UI;
2. получить snapshot через MCP;
3. выполнить type/click и увидеть изменение в UI;
4. изменить страницу вручную и получить новый snapshot;
5. проверить stale ref после navigation;
6. проверить screenshot;
7. остановить run во время wait;
8. проверить simulated browser crash/recovery.

Provider contract/e2e для каждого CLI:

- builtin server появляется без global config;
- пользовательские MCP сохранены;
- текущий URL доступен агенту;
- temp config удалён;
- token отсутствует в transcript/logs/events;
- unsupported CLI version даёт понятную диагностику.

Real CLI e2e сделать opt-in из-за авторизации; fake CLI harness и config generation включить в `npm test`.

Ручная матрица: Windows DPI 100/125/150%, macOS fullscreen/activate, Linux X11/Wayland, localhost HTTP, внешний HTTPS, cookies после restart, отсутствие перекрытия dropdown слоем WebContentsView.

## 15. Критерии готовности

- Доступный с клавиатуры dropdown открывает браузер.
- HTTP(S)/localhost и back/forward/reload работают.
- Авторизация хранится в изолированной partition.
- Все три CLI автоматически получают `agentdock-browser` в каждом run.
- Global CLI configs не изменяются.
- Фраза о просмотре открытого браузера приводит к чтению живой общей вкладки.
- Агент может сам открыть browser для проверки web UI.
- Пользователь видит и отменяет agent actions.
- Secrets/cookies/passwords не выдаются и не логируются.
- Stale refs, navigation error, crash и stop не зависают.
- Existing build/tests проходят; добавлены unit/integration/provider tests.
- README описывает security model и ограничения.

## 16. Не входит в MVP

- произвольный `evaluateJavaScript`;
- cookies/localStorage/пароли;
- скрытый headless browser;
- полноценные multiple tabs;
- network bodies/auth headers;
- автоматические покупки, публикации, сообщения и иные необратимые действия.

Позже: tabs, DOM highlighting refs, trace, device emulation, responsive presets и browser state per workspace при обратно совместимом MCP API.

## 17. Порядок файловых изменений

1. `package.json`, `package-lock.json` — закрепить Electron/MCP dependencies.
2. `electron/browser-manager.cjs` — lifecycle/state.
3. `electron/browser-automation.cjs` — CDP.
4. `electron/browser-mcp.cjs` — bridge/tools.
5. `electron/browser-mcp-config.cjs` — provider injection.
6. `electron/main.cjs` — wiring, IPC, launch/cleanup и lifecycle.
7. `electron/preload.cjs`, `src/vite-env.d.ts` — renderer contract.
8. `src/components/BrowserView.tsx`, `MoreMenu.tsx`, `src/App.tsx` — UI.
9. `src/styles.css` — dropdown, chrome, actions/approvals.
10. Минимальные совместимые изменения adapters/permissions.
11. Tests и fixture site.
12. `README.md`.

Самая рискованная часть — надёжная ephemeral MCP-конфигурация сразу для трёх CLI, а не отображение WebContentsView. Поэтому compatibility spike и provider contract tests выполняются до полной UI-полировки.

Main проверяет trusted sender, URL и bounds. Renderer не получает `webContentsId`, CDP session, MCP token или arbitrary `executeJavaScript`. Возвращать только сериализуемые DTO; listeners возвращают unsubscribe как `onAgentEvent`.
