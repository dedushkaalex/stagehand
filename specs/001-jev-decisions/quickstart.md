# Ручное продолжение

Сначала прочитайте [status.md](status.md) и [операционное руководство](../../docs/jev-decisions.ru.md). Работа на локальном компьютере остановлена; команды ниже выполняет пользователь по своему выбору. Ключи задаются безопасным окружением и никогда не коммитятся.

## Spec Kit и OMP

Официальный пакет: `uv tool install specify-cli==1.2.6`. В эту ветку уже добавлены scaffold, bash scripts, шаблоны и `.omp/commands/speckit.*.md`; повторная инициализация не нужна. OMP binary на облачной машине не устанавливался и его UI не проверялся.

Из корня checkout:

```bash
export SPECIFY_FEATURE_DIRECTORY=specs/001-jev-decisions
bash .specify/scripts/bash/check-prerequisites.sh --json --require-spec --require-tasks --include-tasks
```

Затем в OMP можно использовать `/speckit.analyze`, `/speckit.plan`, `/speckit.tasks`. Последние две команды могут переписать артефакты: сначала ознакомьтесь с существующим планом и незавершёнными задачами. Имя Git-ветки менять не нужно. Feature pointer является локальным состоянием и gitignored.

## Что запускать в новой сессии

Сначала попросите агента прочитать этот каталог, `.specify/memory/constitution.md` и `docs/jev-decisions.ru.md`, затем сопоставить задачи с реальным checkout. Не считать неопубликованный OpenCode прототип частью GitHub-ветки и не пытаться получить его по SHA из публичного remote.

Существующие проверки без модели (не запускались заново при этой документационной задаче):

```bash
pnpm exec vitest run packages/sdk-ts/tests/decision-provider.test.ts packages/sdk-ts/tests/decision-act.test.ts
```

После сборки и настройки браузера по операционному руководству:

```bash
pnpm exec vitest run packages/sdk-ts/tests/browser-runtime/decisionActSmoke.test.ts
```

Это MOCK-контракт с реальным браузером, но без реальной модели. В опубликованной ветке нет OpenCode CLI режима, его тестов или безопасного разрешения живого OpenCode benchmark. Параметры `--provider opencode` и `--max-cost-usd` относятся только к неопубликованному прототипу и здесь не должны использоваться. Сначала нужны T006/T011/T012 и отдельное разрешение. Direct benchmark не является эквивалентом выбранной пары через OpenCode и не доказывает контроль потолка $1.
