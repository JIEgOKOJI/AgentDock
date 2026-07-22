# PLAN.MD — Перенос идей из claudexor в AgentDock

> Источник: [razzant/claudexor](https://github.com/razzant/claudexor) v3.0 — local-first control plane для AI coding agents.
> Целевой проект: AgentDock v0.2.0 — Electron-обёртка над Codex CLI / Claude Code / OpenCode.

## Контекст

**AgentDock** — тонкая GUI-обёртка: единая сессия, каталог MCP, шаринг Skills, встроенный браузер, resume/restart/retry. Сессии — локальный JSON, контекст-передача — последние 8 сообщений.

**claudexor** — полноценный control-plane: демон с durable-очередью, оркестратор с режимами (ask/plan/agent), квоты, бюджеты, race-ы, review, изолированные worktree-конверты, credential profiles, typed events/artifacts. Файлы — источник истины, UI — проекция.

Ниже — топ-15 идей claudexor, отсортированных по соотношению ценность/усилия в рамках Electron-архитектуры AgentDock. Каждая запись: что это, зачем, как адаптировать, оценка, этап.

---

## 1. Credential Profiles — мультиаккаунтные подписки ✅ DONE

**Что:** Несколько Claude/Codex подписок бок о бок, каждая в своём изолированном config-dir (`CLAUDE_CONFIG_DIR` / `CODEX_HOME`). Per-harness ladder аккаунтов с Enabled-тогглом, без понятия "активный аккаунт" — только pin или rotation.

**Зачем:** Пользователь с work + personal Claude Pro не хочет логаут/логин в `~/.claude` каждый раз. AgentDock сейчас использует одну вендорную авторизацию.

**Как:** Расширить `electron/main.cjs` — хранить profiles в `settings.json`, при spawn передавать `env.CLAUDE_CONFIG_DIR` / `env.CODEX_HOME` для пина. UI — chips в composer для выбора аккаунта на поток. Симетричные строки с Enabled-тогглом. Login — через вендорный `claude auth login` / `codex login`, scoped в profile-dir.

**Оценка:** Средняя (3-5 дней). Этап: 1.

---

## 2. Subscription Quota Tracking + Auto-Rotation ✅ DONE

**Что:** Per-profile квота из вендорного `oauth/usage`: 5-час/7-днев/по-модели проценты. Opt-in `limit_action: fail|ask|rotate` — вращение на следующий ready аккаунт только по typed vendor-limit signal, не по network error.

**Зачем:** AgentDock уже читает `getClaudeRateLimits()` / `getCodexRateLimits()`, но без multi-account контекста. С профилями — показывать per-account quota-чипы и авто-переключаться, когда аккаунт исчерпан.

**Оценка:** Средняя (зависит от #1). Этап: 1.

---

## 3. Continuation Packets (вместо наивной передачи 8 сообщений) ✅ DONE

**Что:** При lane-switch (смена harness/аккаунта) или gap (A→B→A) инжектить только delta-обороты с момента checkpoint'а lane, вербатим до byte-бюджета, далее — cached LLM summary или mechanical one-liners. Пакет пишется в файл (`context/THREAD.md`), промпт ссылается на абсолютный путь — тело не едет в промпте. Typed `session.continuity` event с раскрытием.

**Зачем:** AgentDock передаёт до 8 последних сообщений всем провайдерам при каждом run — это и расточительно (повтор всей истории), и теряет контекст после 8. Continuation packets решают обе проблемы.

**Как:** В `electron/main.cjs` отслеживать per-lane (provider + profile) checkpoint. При смене lane — вычислять delta, писать в temp-файл, добавлять путь в `promptWithAttachments`. Cached summary — лениво через `agent:run` read-only pass.

**Оценка:** Высокая (5-7 дней). Этап: 2.

---

## 4. Durable Per-Lane Homes ✅ DONE

**Что:** Каждый (thread + harness + credential) получает свой scoped home вне worktree — native state (plan files, session rollouts, transcripts) не падает в `~`. Durable для thread-оборотов, disposable для one-shot.

**Зачем:** Сейчас AgentDock resume работает только в пределах одного провайдера. Per-lane home делает `codex exec resume` / `claude --resume` достижимым на следующем lane-обороте — native session переживает run.

**Как:** `electron/main.cjs` — каталог `userData/lanes/<sessionId>/<provider>-<profile>/home`, передавать как `HOME`/`CODEX_HOME`/`CLAUDE_CONFIG_DIR` env. Хранить cliSessionId per-lane, а не per-session.

**Оценка:** Средняя (2-3 дня). Этап: 2.

---

## 5. Run Artifacts as Files (events.jsonl, patch.diff, telemetry) ✅ DONE

**Что:** Каждый run создаёт файлы: `events.jsonl`, `final/patch.diff`, `final/summary.md`, `final/telemetry.yaml`, `reviews/*.yaml`, `arbitration/decision.yaml`. Файлы — источник истины, UI — проекция.

**Зачем:** AgentDock хранит всё в одном `sessions.json`. Нет способа инспектить конкретный run отдельно, посмотреть чистый diff, экспортировать артефакты. Artifacts-as-files дают аудируемость и recovery.

**Как:** Каталог `userData/runs/<runId>/`. В `agent:run` handler — писать events.jsonl из stdout параллельно, после run — `git diff` в `final/patch.diff`, summary в `final/summary.md`. Session ссылается на runId. UI — Artifacts-таб.

**Оценка:** Средняя (3-4 дня). Этап: 2.

---

## 6. Best-of-N Race с Cross-Family Review & Arbitration ✅ DONE

**Что:** `--n N` — N кандидатов в изолированных конвертах, каждый через свой harness. Deterministic gates, review (минимум 2 distinct provider families), synthesis, arbitration — выбор winner, auto-adopt его патча в live tree.

**Зачем:** Главная фишка claudexor, которой нет нигде в тонких обёртках. Для сложных багфиксов — race Claude vs Codex vs OpenCode, pick the best, review другим семейством.

**Как:** Новый IPC `agent:race` — параллельный spawn N процессов, каждый в worktree-копии (или без write, compare output). Review — отдельный run с промптом "review this patch" через другой provider. Arbitration — простая scoring-функция (gates pass + review verdict). UI — Compare-таб с diffs side-by-side.

**Оценка:** Высокая (7-10 дней). Этап: 3.

---

## 7. Plan Lifecycle с Typed Open Questions ✅ DONE

**Что:** `plan` run — read-only, оборачивает goal в "plan, do not implement". Завершается `final/plan.md` + structured `## Open Questions` (single/multi/text). Readiness: `ready` | `needs_answers` | `unverified`. Implement — отдельный agent-turn, замораживает plan как content-hashed contract (`context/PLAN.md` вне worktree), верифицирует hash перед spawn.

**Зачем:** AgentDock не различает read-only и write intent — всё один `agent:run`. Plan-mode даёт безопасное исследование перед мутацией, open questions — структурированную двусмысленность.

**Как:** Новый `intent` параметр в run-request (`ask` | `plan` | `agent`). Plan — `adapters.cjs` добавляет префикс промпта "Plan, do not implement." + post-parse `## Open Questions` в `main.cjs`. UI — Plan-режим в composer, вопросник, Implement-кнопка.

**Оценка:** Средняя (3-5 дней). Этап: 3.

---

## 8. Council Planning (параллельные мульти-harness драфты) ✅ DONE

**Что:** `plan --council` — N harnesses draft планы параллельно (round 1), drafts как file-backed artifacts (`council/draft-<harness>.md`), primary делает one merge iteration (указывает на файлы по абсолютному пути, не embedит текст) → ONE unified plan. `## Open Questions` парсится на merge output.

**Зачем:** Для сложных архитектурных решений — собрать планы от Codex, Claude, OpenCode, слить в один, ответить на единый набор вопросов. Дешевле и быстрее, чем гонять по очереди.

**Как:** Расширение #7 — параллельный spawn N plan-runs, merge-run с файловыми ссылками. UI — Council toggle в plan-mode.

**Оценка:** Средняя (поверх #7). Этап: 3.

---

## 9. Deterministic Gates + Protected Paths ✅ DONE

**Что:** `--test '["npm","test"]'` — точный argv для пост-run верификации. `protected_paths` — globs (`migrations/**`, `**/*.env`), изменение которых эскалирует на human-approval gate, never auto-applied. Externally-granted test commands invalidated при изменении config/argv/executable/script bytes/project/profile.

**Зачем:** AgentDock применяет изменения in-place без верификации. Gates дают confidence-before-apply, protected paths — безопасность для критичных файлов.

**Как:** В `main.cjs` — post-run `git diff` → проверка globs → если match, метка `needs_approval`. Gates — spawn test command, exit code → pass/fail. UI — approval prompt перед show diff, Apply-кнопка только после clean gates.

**Оценка:** Средняя (2-3 дня). Этап: 3.

---

## 10. Repair Loops (--attempts / --until-clean) ✅ DONE

**Что:** `--attempts N` — repair loop с хард-капом. `--until-clean` — без фиксированного капа, стоп на clean review/gates, budget/quota exhaust, cancellation, или no-progress stall.

**Зачем:** AgentDock имеет `retry` (re-send last prompt), но не автоматический цикл починки. Для flaky-тестов / неполных фиксов — auto-retry до зелёного gates экономит ручной труд.

**Как:** В run-handler — loop: spawn → parse exit → run gates → если fail и attempts_left > 0, re-spawn с "previous attempt failed because: <gate output>, fix it". Cap + stall detection (same error 3 раза = стоп).

**Оценка:** Низкая (1-2 дня, поверх #9). Этап: 3.

---

## 11. Budget / Cost Accounting (honest) ✅ DONE

**Что:** `--max-usd N` — явный cash cap, zero = real zero. Unknown cost никогда не `$0` — run может end `cost_unverifiable` или `exhausted_overshoot`. Per-run spend ledger, per-profile attribution.

**Зачем:** AgentDock показывает token usage, но не cost и не cap. Для race-ов (#6) и repair loops (#10) — критично знать, когда остановиться по деньгам.

**Как:** В `main.cjs` — simple cost model per provider (Claude Pro = 0 marginal, API = per-token price). Accumulate per-run, block at cap. UI — budget field в composer, spend indicator.

**Оценка:** Низкая (1-2 дня). Этап: 3.

---

## 12. Delegation Belt (scoped MCP tools for sub-runs) ✅ DONE

**Что:** `agent --delegate` инжектит scoped Claudexor MCP belt в harness sandbox: `claudexor_ask` / `claudexor_plan` / `claudexor_run` / `claudexor_best_of` / `claudexor_run_status` / `claudexor_run_result`. NO apply/decision/thread/settings. Nesting depth 1, sub-run cap 8, budget from parent headroom.

**Зачем:** AgentDock уже инжектит `agentdock-browser` MCP. Тот же механизм для delegation — позволить Claude/Code саму spawn подзадачи (например, "research this file" → ask sub-run), с policy enforcement server-side.

**Как:** Новый `agentdock-delegate` MCP server в `electron/`, инструменты: `delegate_ask` / `delegate_plan` / `delegate_run` / `delegate_best_of` / `delegate_run_status` / `delegate_run_result` (spawn child `agent:run` read-only / worktree-scoped). Cap в `main.cjs`, parent budget deduction. Реализовано для всех трёх providers — `electron/mcp-injection.cjs` объединяет browser + delegate дескрипторы в один injection per run (Claude — единый `--mcp-config` файл; Codex — несколько `-c mcp_servers.X=`; OpenCode — merge в `OPENCODE_CONFIG_CONTENT.mcp`).

**OpenCode feasibility:** Изначально план указывал «только для providers с mcp_injection (claude, codex)», но проверка `browser-mcp-config.cjs` показала, что OpenCode уже поддерживает MCP injection через `OPENCODE_CONFIG_CONTENT` env (remote-тип серверов). Delegation Belt работает идентично для всех трёх — OpenCode получает `agentdock-delegate` как `remote` MCP сервер в том же env-merge.

**Оценка:** Высокая (5-7 дней). Этап: 4 — **этап завершён**.

---

## 13. Typed Events + Run Receipts ✅ DONE

**Что:** Каждый claim (cost, quota, web evidence, auth route) — typed fact. Run завершается typed outcome (`success` | `blocked` | `needs_human` | `cost_unverifiable` | `exhausted_overshoot`). `session.continuity` event, `route.fallback.*`, `route.profile.rotated`, `web.unsatisfied` — все с structured payload.

**Зачем:** AgentDock парсит JSON/JSONL в `agent-events.mjs`, но без typed lifecycle. Receipts дают машине (и external agents) читаемое состояние вместо vibe-интерпретации вывода.

**Как:** В `agent-events.mjs` — расширить normalizer typed event-ами (`run.outcome`, `session.continuity`, `route.profile.rotated`). UI — outcome-badge на сообщении, expandable evidence panel.

**Оценка:** Средняя (3-4 дня). Этап: 2.

---

## 14. Isolated Git Worktree Envelopes for Write Runs ✅ DONE

**Что:** Write-runs выполняются в `~/.claudexor/v3/projects/<sha>/workspaces/<task>/<attempt>/tree` — isolated git worktree. Proven work product = git diff в worktree. Winner auto-adopt через `git apply --check` → apply. Non-git проект auto-init с baseline commit.

**Зачем:** AgentDock спавнит CLI прямо в workspace — агенты мутируют живой проект. Worktree-изоляция даёт: race-кандидаты не мешают друг другу, failed run не оставляет мусор, можно сравнить до/после чисто.

**Как:** В `main.cjs` — pre-run `git worktree add`, post-run `git diff` → `final/patch.diff`, cleanup worktree. Для non-race runs — опционально (по умолчанию in-place, как сейчас). UI — "isolated run" toggle.

**Оценка:** Высокая (4-6 дней). Этап: 3.

---

## Этапы

| Этап | Фичи | Фокус |
|------|------|-------|
| 1 | #1 Credential Profiles ✅, #2 Quota Rotation ✅ | Мультиаккаунтность — **этап завершён** |
| 2 | #3 Continuation Packets ✅, #4 Per-Lane Homes ✅, #5 Run Artifacts ✅, #13 Typed Events ✅ | Контекст + аудируемость — **этап завершён** |
| 3 | #6 Best-of-N ✅, #7 Plan Lifecycle ✅, #8 Council ✅, #9 Gates ✅, #10 Repair Loops ✅, #11 Budget ✅, #14 Worktree Envelopes ✅ | Оркестрация + безопасность — **этап завершён** |
| 4 | #12 Delegation Belt ✅ | Архитектурная эволюция — **этап завершён** |
| 5 | #5.1 RunOrchestrator ✅, #5.2 Worktree+adopt ✅, #5.3 Read-only+plan hash ✅, #5.4 Repair loop ✅, #5.5 Budget+receipt ✅ | P0 — восстановление корректности и гарантий безопасности — **этап завершён** |
| 6 | #6.1 Artifact schema ✅, #6.2 Best-of-N ✅, #6.3 Council ✅, #6.4 Delegation ✅, #6.5 Quota+continuity ✅ | P1 — доведение заявленных фич до полного контракта — **этап завершён** |

> **Уточнение статуса после аудита:** отметка `✅ DONE` у этапов 1–4 означает, что основной код и unit-тесты добавлены. Она не означает, что все заявленные гарантии уже подтверждены интеграционными тестами. На 23.07.2026 `npm test` проходит (351/351), `npm run build` проходит. Этап 5 (P0 hardening) завершён — исправлены контракты read-only intent, isolated worktree lifecycle, repair loop и budget hard cap. Этап 6 (P1 feature closure) завершён — каноническая схема artifacts с manifest/crash-safe, Best-of-N с fail-closed envelope/cross-family review/arbitration, Council с preflight/draft hashes/merge open questions, Delegation Belt с async subRunId/artifact recovery, quota rotation по typed vendor-limit signal и delta continuation packets с byte budget. Этап 7 (UI closure) реализован 23.07.2026 — все workflows доступны из renderer на реальных IPC; Playwright/Electron e2e-покрытие из критериев приёмки ещё не написано (перенесено в этап 8.3.5). Этап 8 остаётся обязательным closure-планом.

---

## Этап 5. P0 — восстановление корректности и гарантий безопасности ✅ DONE

**Цель:** устранить случаи, когда реализация формально существует, но нарушает ключевые контракты: read-only intent может писать в workspace, isolated-run фактически не изолируется, patch применяется до gates, а repair-loop не является циклом.

### 5.1. Выделить единый `RunOrchestrator` и сделать завершение run ожидаемым

**Проблема:** `agent:run` запускает процесс и возвращает `runId`, а вся финализация находится в глубоко вложенных `close` callbacks. Логика первого запуска, repair-попытки, race, council и delegate расходится и частично дублируется. Это уже привело к разному порядку capture → gates → apply → receipt и к тому, что повторная repair-попытка не может перейти к третьей.

**Шаги:**

1. Вынести общий исполнитель в новый модуль `electron/run-orchestrator.cjs` с явными фазами `prepare → spawn → collect → capture → verify → decide → adopt → finalize → cleanup`.
2. Каждая фаза возвращает typed-результат; ошибки не проглатываются пустыми `catch {}`, а превращаются в `run.warning`/`run.error` и отражаются в receipt.
3. Сделать `executeAttempt()` Promise-based и использовать его для обычного run, каждой repair-попытки, race-кандидата, council draft/merge и delegate sub-run.
4. В `running` хранить не только child, но и `AbortController`, workspace envelope, cleanup stack и текущую фазу.
5. Гарантировать ровно один terminal event и ровно один финальный receipt на run, включая spawn error, cancellation и crash cleanup.

**Критерии приёмки:**

- последовательность фаз проверяется интеграционным тестом на fake adapter;
- `agent:stop` завершает процесс, дочерние процессы и cleanup, после чего receipt имеет outcome `cancelled`;
- terminal event не дублируется при одновременных `error` и `close`;
- ни один финализатор не зависит от вложенного `child.on('close', ...)` другого финализатора.

### 5.2. Исправить lifecycle isolated worktree и безопасное применение патча

**Найденные дефекты:**

- в `agent:run` `runId` используется при `createWorktree(...)` до его объявления; исключение ловится, поэтому isolated-run молча выполняется без изоляции;
- при ошибке создания worktree обычный run, race-кандидат и delegate write-run откатываются к live workspace, хотя пользователь запросил изоляцию;
- isolated patch применяется автоматически сразу после завершения агента — до test gates и protected-path approval;
- `captureWorktreeDiff()` через `git diff HEAD` не включает untracked files;
- non-git workspace не получает обещанный baseline envelope;
- cleanup не удаляет созданную ветку и не оставляет recoverable metadata при неуспехе.

**Шаги:**

1. Генерировать `runId` до любых операций run setup.
2. Ввести fail-closed правило: если `isolated=true`, ошибка envelope завершает run outcome `blocked`; запуск в live tree запрещён.
3. Снимать полный patch из tracked, staged, deleted, renamed и untracked файлов; добавить бинарный-safe путь либо явный unsupported outcome.
4. Зафиксировать порядок: `capture patch → protected paths → tests в worktree → arbitration/human decision → git apply --check → apply в live tree`.
5. Никогда не применять patch при failed gates, `needs_approval`, cancellation, unverifiable base или изменившемся live tree.
6. Перед adopt сохранять base commit/tree hash и проверять, что live workspace совместим с ним; при конфликте возвращать `adoption_conflict`, сохраняя patch.
7. Реализовать non-git envelope без скрытой мутации пользовательского проекта: временная копия + synthetic baseline внутри envelope. Не выполнять `git init`, `git add` или baseline commit в live workspace.
8. Удалять worktree и временную ветку в `finally`; при cleanup failure писать recoverable path в receipt.

**Критерии приёмки:**

- isolated agent не может изменить live workspace до явного adopt;
- test gate запускается внутри candidate worktree и видит новые untracked files;
- protected file никогда не auto-adopt'ится;
- failed worktree setup не запускает provider CLI;
- параллельные race-кандидаты не видят изменения друг друга;
- сценарии dirty tree, detached HEAD, nested workspace, rename/delete/untracked и non-git покрыты integration tests.

### 5.3. Обеспечить реальный read-only для `ask` и `plan`

**Проблема:** сейчас read-only задаётся в основном текстом промпта. Процесс всё равно может получить write permission и запускается в live workspace. Это не соответствует контракту «plan, do not implement».

**Шаги:**

1. Для `intent=ask|plan` принудительно выбирать read-only permission mapping независимо от UI `permissionMode`.
2. Запускать read-only intent в read-only envelope/snapshot либо проверять workspace fingerprint до/после и считать любую мутацию нарушением контракта с откатом из disposable copy.
3. Запретить auto-apply, repair write-attempts и write-capable delegate tools внутри plan/ask.
4. Писать результат plan-run одновременно в `runs/<runId>/final/plan.md` и в immutable session contract только после принятия пользователем.
5. Заменить эвристический парсер вопросов на versioned structured schema: `id`, `kind`, `text`, `options`, `required`, `answer`; сохранить fallback для старого Markdown.
6. При `Implement` пересчитывать hash содержимого plan + answers, а не сравнивать только hash из заголовка файла. Перед spawn передавать ожидаемый hash и повторно проверять bytes контракта.

**Критерии приёмки:**

- malicious test adapter не может изменить live workspace в plan/ask;
- ручное редактирование тела `PLAN.md` при сохранённом старом заголовке обнаруживается;
- implement заблокирован при unanswered required questions и `readiness != ready`;
- принятие ответов создаёт новый hash и неизменяемую ревизию контракта.

### 5.4. Переписать repair loop как настоящий цикл попыток

**Проблема:** текущий код поддерживает только исходный запуск и одну вложенную repair-попытку; дальнейший `shouldContinue()` уже не вызывает следующую попытку. Для isolated-run worktree удаляется до gates, поэтому следующая попытка может получить несуществующий `cwd`.

**Шаги:**

1. Реализовать `for/while` поверх `executeAttempt()`, без рекурсивных event callbacks.
2. Сохранять один envelope на всю repair-серию либо создавать новый attempt-envelope из результата предыдущей попытки по явной стратегии.
3. После каждой попытки повторять полный capture и все gates, включая protected paths.
4. Stall fingerprint строить из нормализованного gate failure + patch hash, чтобы одинаковый текст при реальном прогрессе не считался stall.
5. Останавливать loop по success, max attempts, stall, cancel, quota, budget, protected approval и unrecoverable spawn/gate error.
6. Писать `attempts/<n>/events.jsonl`, patch, gate result и usage; top-level receipt содержит причину остановки.

**Критерии приёмки:** тесты подтверждают 1, 2, 3 и N попыток, `untilClean`, stall, cancel, budget exhaustion и сохранение всех attempt artifacts.

### 5.5. Сделать бюджет hard cap, а receipt — итоговой истиной

**Найденные дефекты:** `maxUsd=0` сейчас отключает бюджет; unknown usage записывается как нулевая стоимость; проверка происходит только после run; receipt записывается до замены outcome на `exhausted_overshoot`; race/council/review и часть delegate расходов не участвуют в едином preflight.

**Шаги:**

1. Развести состояния `budget omitted` и `maxUsd=0`; ноль должен запрещать любой run с потенциальной ненулевой или неизвестной стоимостью.
2. Добавить reservation ledger: reserve перед spawn, settle после usage, release при нестарте.
3. При неизвестной цене/usage использовать outcome `cost_unverifiable`, а не `$0`; политика `deny|allow_with_warning` задаётся явно.
4. Один parent budget делится между candidates, reviews, merge, repair и delegate sub-runs; конкурентные reservations атомарны.
5. Формировать receipt только после budget settlement либо атомарно переписывать его с финальным outcome, usage и cost evidence.
6. Убрать hard-coded цены без версии: хранить versioned pricing snapshot и источник/дату; subscription помечать как `marginal_subscription`, а не как универсально бесплатную операцию.

**Критерии приёмки:** ни один новый child не стартует при отсутствии headroom; параллельные reservations не превышают cap; receipt, telemetry и ledger содержат одинаковые итоговые значения.

---

## Этап 6. P1 — доведение заявленных фич до полного контракта ✅ DONE

### 6.1. Каноническая схема artifacts и crash-safe запись ✅ DONE

**Расхождение:** план и README обещают `final/telemetry.yaml`, `final/plan.md`, `reviews/*.yaml`, `arbitration/decision.yaml`; текущая реализация в основном создаёт `receipt.json`, часть путей отличается, пустые patch/summary не создаются, а `readArtifact` использует небольшой статический allow-list.

**Шаги:**

1. Утвердить `artifacts.schema.json` с версией и обязательными файлами для каждого kind: run/plan/council/race/delegate.
2. Всегда создавать terminal artifacts, включая пустой `patch.diff` и summary с объяснением отсутствия результата.
3. Добавить `final/telemetry.yaml`, `final/plan.md`, `reviews/<candidate>-<reviewer>.yaml`, `arbitration/decision.yaml`, `attempts/` и `manifest.json` с hashes/sizes/content types.
4. Записывать через temp file + fsync + atomic rename; JSONL восстанавливать до последней полной строки.
5. Читать артефакты по manifest и safe path resolution, а не по неполному hard-coded списку; запретить traversal и symlink escape.
6. Выполнять startup recovery: незавершённый run получает outcome `interrupted`, orphan worktree — запись для cleanup/recovery.

**Критерии приёмки:** UI восстанавливается только из файлов после удаления проекции из `sessions.json`; manifest hashes проверяются; crash между фазами не оставляет run в неопределённом состоянии.

### 6.2. Завершить Best-of-N: реальные gates, cross-family review и безопасная arbitration ✅ DONE

**Найденные дефекты:** список «установленных» providers строится из ключей adapters без проверки CLI; ошибка worktree ведёт к запуску кандидата в live tree; gates для кандидатов не исполняются; review выполняется максимум одним другим provider, а требование — минимум две разные семьи; profile credentials для reviewer не выбираются; auto-adopt не учитывает approvals и изменение base.

**Шаги:**

1. Делать preflight доступности executable/profile/model и не подменять отсутствующий provider дубликатом молча.
2. Каждый кандидат — только fail-closed envelope, собственный run receipt, budget reservation и deterministic gates.
3. Требовать настроенное число независимых reviewers и минимум две provider families, либо завершать arbitration как `unverified`.
4. Хранить review evidence отдельно; scoring не должен выбирать failed/blocked/needs_human кандидата только из-за суммы баллов.
5. Добавить tie-break policy, minimum score, no-winner outcome и synthesis как отдельную опциональную фазу.
6. Adopt выполнять через общий безопасный pipeline этапа 5.2, никогда напрямую из race handler.

**Критерии приёмки:** race с отсутствующим CLI, failed candidate, conflicting patch, protected path, no winner, two-family review и live-tree drift покрыт e2e tests.

### 6.3. Завершить Council lifecycle ✅ DONE

**Шаги:**

1. Проверять доступность всех council providers и явно показывать partial council вместо тихой подмены.
2. Каждый draft сохранять как самостоятельный child run с receipt, usage и provenance.
3. Merge-run получает только абсолютные ссылки на immutable draft artifacts и их hashes.
4. Merge failure не перезаписывает последнюю принятую plan revision.
5. Open Questions объединяются в typed schema с дедупликацией по смысловому/стабильному id, а не случайному UUID при каждом parse.
6. Council учитывает общий budget, cancel и timeout; все children завершаются при остановке parent.

### 6.4. Исправить Delegation Belt до заявленной семантики ✅ DONE

**Найденные дефекты:** MCP-описание обещает немедленный `subRunId`, но handler ожидает завершения child; registry живёт только в памяти; `delegate_best_of` проходит через обычный single-run путь и не запускает настоящий race; budget check использует статический snapshot и неизвестную оценку как ноль; при отказе worktree delegate write-run может писать в live workspace.

**Шаги:**

1. `spawnSubRun` должен регистрировать и вернуть `subRunId` сразу, а выполнение продолжать асинхронно.
2. Статус/result восстанавливаются из artifacts после рестарта, а не только из `Map`.
3. `delegate_best_of` вызывает общий race orchestrator с `autoAdopt=false` и собственными child receipts.
4. Любой delegate write fail-closed при ошибке envelope; ask/plan используют enforced read-only.
5. Budget headroom проверяется атомарно перед каждым child, а не один раз при старте parent MCP.
6. Cap считать по фактически зарезервированным child runs; failed validation не должна безусловно съедать слот.
7. Ограничить provider/profile allow-list родительской политикой и не разрешать delegate выбрать произвольный credential context.

**Критерии приёмки:** MCP tool отвечает до окончания fake child; polling показывает `queued → running → completed`; restart сохраняет result; best-of создаёт N кандидатов; sub-run не может применить patch.

### 6.5. Довести quota rotation и lane continuity ✅ DONE

**Шаги:**

1. Ротацию разрешать только по распознанному typed vendor-limit signal; ненулевой exit code сам по себе не является quota exhaustion.
2. Реализовать `limit_action=ask` как durable pending decision с UI approval, а не только настройку.
3. При rotate повторять run только после явной политики и учитывать idempotency/write envelope.
4. Выбирать следующий профиль по свежим per-profile limits; не считать profile ready при unavailable/stale usage без policy.
5. Continuation packet строить из delta после checkpoint, а не из полного массива сообщений; ввести byte budget, deterministic truncation и cached/mechanical summary fallback.
6. Checkpoint обновлять только после terminal receipt и хранить last delivered message/event id для каждой target lane.
7. Не смешивать provider credential home с lane metadata: документировать, какие native state paths реально изолируются для Codex/Claude/OpenCode, не ломая login.

**Критерии приёмки:** network/auth/model errors не вызывают rotation; A→B→A передаёт только недоставленный delta; повтор после crash не дублирует уже доставленный контекст.

---

## Этап 7. P1 — завершение пользовательских сценариев в UI ✅ UI DONE (e2e pending)

**Цель:** IPC без доступного UI не считается завершённой пользовательской фичей. Сейчас renderer использует intent и просмотр части artifacts, но не предоставляет полноценные workflows race/council/adopt/gates/repair/budget/delegation.

**Статус:** 7.1–7.4 реализованы как настоящий UI поверх существующих IPC (плюс несколько точечных IPC/схемных добавлений: `plan:read` теперь возвращает `openQuestions`/`readiness`, race-кандидаты и council-drafts получили `parentRunId` и `baseTreeHash`, добавлены `runs:adopt-patch` / `runs:reject-approval` для approval-инбокса и ручного adopt кандидата). Новые компоненты: `PlanPanel`, `OrchestrationControls`, `CompareView`, `ApprovalInbox`, `RunTree`, `ArtifactsPanel` — все на реальных IPC-вызовах, без моков. `npm test` (351/351) и `npm run build` зелёные; renderer проверен вручную через dev-сервер и реальный Electron-процесс (без вывода JS-ошибок, startup recovery отработал). **Не сделано:** Playwright/Electron e2e-сценарии из критериев приёмки — критерий "проходят Playwright/Electron e2e" из этапа 7 остаётся открытым и вынесен в этап 8 (8.3.5).

### 7.1. Plan → Questions → Implement

1. Показать typed controls для single/multi/text questions, required validation и сохранение ответов.
2. Добавить `Accept plan` и `Implement`; перед implement показывать hash/revision и выполнять server-side verify.
3. Блокировать implement для stale plan, unanswered required questions и mutated contract; предлагать re-plan.
4. Отображать историю plan revisions и связь implement-run с конкретным contract hash.

### 7.2. Composer orchestration controls

1. Добавить отдельные opt-in controls: isolated, council providers, race N/providers/reviewers/auto-adopt, gates argv, protected paths, attempts/until-clean, max USD и delegation limits.
2. Валидировать несовместимые комбинации до IPC: plan+write permissions, auto-adopt без gates, until-clean без stop policy, race без двух доступных providers.
3. Сохранять presets на workspace, но показывать эффективную policy перед запуском.

### 7.3. Approval, Compare и Artifacts

1. Добавить durable approval inbox для protected paths и adopt; approve привязан к patch hash/base hash и инвалидируется при изменении любого из них.
2. Compare view: candidate summary, diff, gates, reviews, score evidence и выбор winner человеком.
3. Artifacts view строить из manifest, поддержать council/race/delegate/attempt tree, raw/pretty view и export directory.
4. Показать typed outcome, cost evidence, quota rotation, cleanup warning и recovery actions без необходимости читать raw stdout.

### 7.4. Управление parent/child runs

1. Отображать дерево parent → attempts/candidates/reviews/delegates.
2. Stop parent отменяет всех children; отдельно разрешить stop безопасного child.
3. После перезапуска UI восстанавливает running/interrupted/completed state из durable artifacts.

**Критерии приёмки этапа 7:** все публичные IPC workflows достижимы из UI; основные сценарии проходят Playwright/Electron e2e без ручного вызова preload API.

---

## Этап 8. P2 — эксплуатационная надёжность, security и релизная приёмка

### 8.1. Durable queue и восстановление

1. Ввести append-only run index/queue со статусами `queued|running|waiting_approval|completed|failed|cancelled|interrupted`.
2. Ограничить глобальную и per-provider concurrency; добавить fair scheduling и backpressure для race/council/delegate fan-out.
3. На startup сверять queue, PID/process state, worktrees и manifests; не перезапускать write-run автоматически без idempotency policy.
4. Добавить retention/cleanup policy с preview и защитой pinned runs.

### 8.2. Security hardening

1. Проверить все IPC handlers на schema validation, sender/frame authorization и path containment.
2. Не сохранять bearer tokens, auth paths и credential env в events, prompts, receipts или renderer payloads; добавить redaction tests.
3. Gate command хранить как argv; на Windows убрать `shell: true`, чтобы исключить shell reinterpretation.
4. Проверять executable/script/config bytes в approval fingerprint и инвалидировать внешнее разрешение при изменениях.
5. Ограничить размер stdout/events/artifacts, количество concurrent children и lifetime локальных MCP servers.

### 8.3. Тестовая матрица

1. Unit: schema normalization, path safety, receipt state machine, reservation ledger, typed limit detection.
2. Integration с fake CLI: success/failure/spawn error/hang/cancel, multi-attempt repair, race/council/delegate, plan tampering, quota rotation.
3. Git integration: clean/dirty repo, staged/untracked/binary/rename/delete, branch collision, detached HEAD, live drift, apply conflict, non-git.
4. Crash tests: kill Electron в каждой фазе, затем проверить recovery, единственный terminal receipt и отсутствие live mutations.
5. E2E renderer: plan-to-implement, approval, compare, artifacts restore, stop tree и restart recovery.
6. Реальные smoke tests для Codex/Claude/OpenCode под opt-in env; они не входят в обязательный offline CI.

### 8.4. Документация и release gate

1. Исправить README так, чтобы он различал implemented, experimental и verified; убрать обещания, не подтверждённые acceptance tests.
2. Добавить migration notes для artifact schema, lanes и settings.
3. Публиковать compatibility matrix по ОС/provider CLI/version.
4. Release gate: `npm test`, `npm run build`, integration suite, Electron e2e, `git diff --check`, security checklist и ручной smoke одного isolated adopt.

**Definition of Done этапов 5–8:** все P0/P1 пункты закрыты; P2 release gate зелёный; ни один read-only или isolated сценарий не мутирует live workspace до разрешённого adopt; все terminal outcomes восстанавливаются из файлов; budget/quota/approval решения имеют typed evidence; README соответствует фактическому поведению.

## Обновлённая последовательность работ

| Порядок | Блок | Зависимости | Результат |
|---------|------|-------------|-----------|
| 1 | 5.1 RunOrchestrator ✅ | — | единая state machine запуска |
| 2 | 5.2 Worktree + adopt ✅ | 5.1 | fail-closed изоляция и безопасное применение |
| 3 | 5.3 Read-only + plan hash ✅ | 5.1 | enforceable ask/plan contract |
| 4 | 5.4 Repair loop ✅ | 5.1, 5.2 | настоящий N-attempt lifecycle |
| 5 | 5.5 Budget + final receipt ✅ | 5.1 | hard cap и согласованные итоги |
| 6 | 6.1 Artifact schema ✅ | 5.1, 5.5 | файловый источник истины и recovery |
| 7 | 6.2–6.5 Feature closure ✅ | 5.*, 6.1 | race/council/delegate/quota/continuity по полному контракту |
| 8 | 7.* UI closure ✅ | 6.* | все сценарии доступны пользователю (e2e-тесты ещё не написаны) |
| 9 | 8.* Reliability/release | 5–7 | подтверждённая production-ready реализация |

## Принципы адаптации

1. **Не тащить monorepo/packages** — AgentDock остаётся single-repo Electron + Vite. claudexor-пакеты → модули в `electron/`.
2. **Файлы — источник истины** — run artifacts в `userData/runs/`, не в `sessions.json` blob.
3. **Surfaces — тонкие** — UI только отображает проекции, routing/гейты/бюджеты — в main/daemon.
4. **Typed披露 (disclosure)** — каждый lane-switch, rotation, gate-fail = typed event в UI, не silent.
5. **Opt-in complexity** — race/council/delegate — explicit flags/toggles, дефолт = текущее поведение.

## Что НЕ переносить (уже есть или не нужно)

- Browser MCP — уже есть, лучше реализация (CDP + security model).
- Skills discovery/sharing — уже есть.
- MCP manager — уже есть, включая import/sync/health/conflicts.
- Telemetry-free policy — AgentDock тоже локальный, ничего не отправляет.
- Cursor CLI adapter — нет смысла, Cursor не headless-CLI-first.
- Raw API adapters — AgentDock идеологически работает через установленные CLI.

---

*PLAN.MD — живой документ. Обновлять по мере завершения этапов.*
