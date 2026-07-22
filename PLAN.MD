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

## 3. Continuation Packets (вместо наивной передачи 8 сообщений)

**Что:** При lane-switch (смена harness/аккаунта) или gap (A→B→A) инжектить только delta-обороты с момента checkpoint'а lane, вербатим до byte-бюджета, далее — cached LLM summary или mechanical one-liners. Пакет пишется в файл (`context/THREAD.md`), промпт ссылается на абсолютный путь — тело не едет в промпте. Typed `session.continuity` event с раскрытием.

**Зачем:** AgentDock передаёт до 8 последних сообщений всем провайдерам при каждом run — это и расточительно (повтор всей истории), и теряет контекст после 8. Continuation packets решают обе проблемы.

**Как:** В `electron/main.cjs` отслеживать per-lane (provider + profile) checkpoint. При смене lane — вычислять delta, писать в temp-файл, добавлять путь в `promptWithAttachments`. Cached summary — лениво через `agent:run` read-only pass.

**Оценка:** Высокая (5-7 дней). Этап: 2.

---

## 4. Durable Per-Lane Homes

**Что:** Каждый (thread + harness + credential) получает свой scoped home вне worktree — native state (plan files, session rollouts, transcripts) не падает в `~`. Durable для thread-оборотов, disposable для one-shot.

**Зачем:** Сейчас AgentDock resume работает только в пределах одного провайдера. Per-lane home делает `codex exec resume` / `claude --resume` достижимым на следующем lane-обороте — native session переживает run.

**Как:** `electron/main.cjs` — каталог `userData/lanes/<sessionId>/<provider>-<profile>/home`, передавать как `HOME`/`CODEX_HOME`/`CLAUDE_CONFIG_DIR` env. Хранить cliSessionId per-lane, а не per-session.

**Оценка:** Средняя (2-3 дня). Этап: 2.

---

## 5. Run Artifacts as Files (events.jsonl, patch.diff, telemetry)

**Что:** Каждый run создаёт файлы: `events.jsonl`, `final/patch.diff`, `final/summary.md`, `final/telemetry.yaml`, `reviews/*.yaml`, `arbitration/decision.yaml`. Файлы — источник истины, UI — проекция.

**Зачем:** AgentDock хранит всё в одном `sessions.json`. Нет способа инспектить конкретный run отдельно, посмотреть чистый diff, экспортировать артефакты. Artifacts-as-files дают аудируемость и recovery.

**Как:** Каталог `userData/runs/<runId>/`. В `agent:run` handler — писать events.jsonl из stdout параллельно, после run — `git diff` в `final/patch.diff`, summary в `final/summary.md`. Session ссылается на runId. UI — Artifacts-таб.

**Оценка:** Средняя (3-4 дня). Этап: 2.

---

## 6. Best-of-N Race с Cross-Family Review & Arbitration

**Что:** `--n N` — N кандидатов в изолированных конвертах, каждый через свой harness. Deterministic gates, review (минимум 2 distinct provider families), synthesis, arbitration — выбор winner, auto-adopt его патча в live tree.

**Зачем:** Главная фишка claudexor, которой нет нигде в тонких обёртках. Для сложных багфиксов — race Claude vs Codex vs OpenCode, pick the best, review другим семейством.

**Как:** Новый IPC `agent:race` — параллельный spawn N процессов, каждый в worktree-копии (или без write, compare output). Review — отдельный run с промптом "review this patch" через другой provider. Arbitration — простая scoring-функция (gates pass + review verdict). UI — Compare-таб с diffs side-by-side.

**Оценка:** Высокая (7-10 дней). Этап: 3.

---

## 7. Plan Lifecycle с Typed Open Questions

**Что:** `plan` run — read-only, оборачивает goal в "plan, do not implement". Завершается `final/plan.md` + structured `## Open Questions` (single/multi/text). Readiness: `ready` | `needs_answers` | `unverified`. Implement — отдельный agent-turn, замораживает plan как content-hashed contract (`context/PLAN.md` вне worktree), верифицирует hash перед spawn.

**Зачем:** AgentDock не различает read-only и write intent — всё один `agent:run`. Plan-mode даёт безопасное исследование перед мутацией, open questions — структурированную двусмысленность.

**Как:** Новый `intent` параметр в run-request (`ask` | `plan` | `agent`). Plan — `adapters.cjs` добавляет префикс промпта "Plan, do not implement." + post-parse `## Open Questions` в `main.cjs`. UI — Plan-режим в composer, вопросник, Implement-кнопка.

**Оценка:** Средняя (3-5 дней). Этап: 3.

---

## 8. Council Planning (параллельные мульти-harness драфты)

**Что:** `plan --council` — N harnesses draft планы параллельно (round 1), drafts как file-backed artifacts (`council/draft-<harness>.md`), primary делает one merge iteration (указывает на файлы по абсолютному пути, не embedит текст) → ONE unified plan. `## Open Questions` парсится на merge output.

**Зачем:** Для сложных архитектурных решений — собрать планы от Codex, Claude, OpenCode, слить в один, ответить на единый набор вопросов. Дешевле и быстрее, чем гонять по очереди.

**Как:** Расширение #7 — параллельный spawn N plan-runs, merge-run с файловыми ссылками. UI — Council toggle в plan-mode.

**Оценка:** Средняя (поверх #7). Этап: 3.

---

## 9. Deterministic Gates + Protected Paths

**Что:** `--test '["npm","test"]'` — точный argv для пост-run верификации. `protected_paths` — globs (`migrations/**`, `**/*.env`), изменение которых эскалирует на human-approval gate, never auto-applied. Externally-granted test commands invalidated при изменении config/argv/executable/script bytes/project/profile.

**Зачем:** AgentDock применяет изменения in-place без верификации. Gates дают confidence-before-apply, protected paths — безопасность для критичных файлов.

**Как:** В `main.cjs` — post-run `git diff` → проверка globs → если match, метка `needs_approval`. Gates — spawn test command, exit code → pass/fail. UI — approval prompt перед show diff, Apply-кнопка только после clean gates.

**Оценка:** Средняя (2-3 дня). Этап: 3.

---

## 10. Repair Loops (--attempts / --until-clean)

**Что:** `--attempts N` — repair loop с хард-капом. `--until-clean` — без фиксированного капа, стоп на clean review/gates, budget/quota exhaust, cancellation, или no-progress stall.

**Зачем:** AgentDock имеет `retry` (re-send last prompt), но не автоматический цикл починки. Для flaky-тестов / неполных фиксов — auto-retry до зелёного gates экономит ручной труд.

**Как:** В run-handler — loop: spawn → parse exit → run gates → если fail и attempts_left > 0, re-spawn с "previous attempt failed because: <gate output>, fix it". Cap + stall detection (same error 3 раза = стоп).

**Оценка:** Низкая (1-2 дня, поверх #9). Этап: 3.

---

## 11. Budget / Cost Accounting (honest)

**Что:** `--max-usd N` — явный cash cap, zero = real zero. Unknown cost никогда не `$0` — run может end `cost_unverifiable` или `exhausted_overshoot`. Per-run spend ledger, per-profile attribution.

**Зачем:** AgentDock показывает token usage, но не cost и не cap. Для race-ов (#6) и repair loops (#10) — критично знать, когда остановиться по деньгам.

**Как:** В `main.cjs` — simple cost model per provider (Claude Pro = 0 marginal, API = per-token price). Accumulate per-run, block at cap. UI — budget field в composer, spend indicator.

**Оценка:** Низкая (1-2 дня). Этап: 3.

---

## 12. Delegation Belt (scoped MCP tools for sub-runs)

**Что:** `agent --delegate` инжектит scoped Claudexor MCP belt в harness sandbox: `claudexor_ask` / `claudexor_plan` / `claudexor_run` / `claudexor_best_of` / `claudexor_run_status` / `claudexor_run_result`. NO apply/decision/thread/settings. Nesting depth 1, sub-run cap 8, budget from parent headroom.

**Зачем:** AgentDock уже инжектит `agentdock-browser` MCP. Тот же механизм для delegation — позволить Claude/Code саму spawn подзадачи (например, "research this file" → ask sub-run), с policy enforcement server-side.

**Как:** Новый `agentdock-delegate` MCP server в `electron/`, инструменты: `delegate_ask` / `delegate_run` (spawn child `agent:run` read-only). Cap в `main.cjs`, parent budget deduction. Только для providers с mcp_injection (claude, codex).

**Оценка:** Высокая (5-7 дней). Этап: 4.

---

## 13. Typed Events + Run Receipts

**Что:** Каждый claim (cost, quota, web evidence, auth route) — typed fact. Run завершается typed outcome (`success` | `blocked` | `needs_human` | `cost_unverifiable` | `exhausted_overshoot`). `session.continuity` event, `route.fallback.*`, `route.profile.rotated`, `web.unsatisfied` — все с structured payload.

**Зачем:** AgentDock парсит JSON/JSONL в `agent-events.mjs`, но без typed lifecycle. Receipts дают машине (и external agents) читаемое состояние вместо vibe-интерпретации вывода.

**Как:** В `agent-events.mjs` — расширить normalizer typed event-ами (`run.outcome`, `session.continuity`, `route.profile.rotated`). UI — outcome-badge на сообщении, expandable evidence panel.

**Оценка:** Средняя (3-4 дня). Этап: 2.

---

## 14. Isolated Git Worktree Envelopes for Write Runs

**Что:** Write-runs выполняются в `~/.claudexor/v3/projects/<sha>/workspaces/<task>/<attempt>/tree` — isolated git worktree. Proven work product = git diff в worktree. Winner auto-adopt через `git apply --check` → apply. Non-git проект auto-init с baseline commit.

**Зачем:** AgentDock спавнит CLI прямо в workspace — агенты мутируют живой проект. Worktree-изоляция даёт: race-кандидаты не мешают друг другу, failed run не оставляет мусор, можно сравнить до/после чисто.

**Как:** В `main.cjs` — pre-run `git worktree add`, post-run `git diff` → `final/patch.diff`, cleanup worktree. Для non-race runs — опционально (по умолчанию in-place, как сейчас). UI — "isolated run" toggle.

**Оценка:** Высокая (4-6 дней). Этап: 3.

---

## 15. Daemon + Control API (durable queue, SSE)

**Что:** Managed daemon — mandatory runtime authority. Durable fsync-acknowledged command queue over Unix socket, idempotency-key retry binding, loopback HTTP/SSE control API. Surfaces — thin viewports.

**Зачем:** AgentDock IPC синхронный — crash main process = потеря run. Durable queue даёт: crash recovery, retry с тем же key, SSE-streaming events в UI (вместо polling), external agent driving через HTTP.

**Как:** Вынести run-execution в дочерний node-process (daemon), IPC main↔daemon через Unix socket/named pipe. Idempotency keys на run-creating IPC. SSE endpoint на loopback для UI. Оставить browser/MCP в main (как сейчас).

**Оценка:** Очень высокая (10+ дней). Этап: 4 (опционально, архитектурный сдвиг).

---

## Этапы

| Этап | Фичи | Фокус |
|------|------|-------|
| 1 | #1 Credential Profiles ✅, #2 Quota Rotation ✅ | Мультиаккаунтность — **этап завершён** |
| 2 | #3 Continuation Packets, #4 Per-Lane Homes, #5 Run Artifacts, #13 Typed Events | Контекст + аудируемость |
| 3 | #6 Best-of-N, #7 Plan Lifecycle, #8 Council, #9 Gates, #10 Repair Loops, #11 Budget, #14 Worktree Envelopes | Оркестрация + безопасность |
| 4 | #12 Delegation Belt, #15 Daemon | Архитектурная эволюция (опционально) |

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