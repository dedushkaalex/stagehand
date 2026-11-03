# Установка Spec Kit: происхождение и проверка

- Дата: 2026-11-03.
- Официальный пакет: PyPI `specify-cli==1.2.6`; CLI version проверен.
- Источники: [репозиторий](https://github.com/github/spec-kit), [официальная установка](https://github.com/github/spec-kit/blob/main/docs/installation.md).
- Команда генерации в пустом временном каталоге: `specify init <temporary-directory> --integration omp --script sh --non-interactive --ignore-agent-tools`.
- Флаг `--integration omp` подтверждён официальной документацией и фактическим успешным init. Это не выдуманный `--ai omp`.
- В checkout перенесены только сгенерированные `.specify`, `.omp/commands` и русские документы. Скрипты/шаблоны сохранены как выпущены upstream, constitution заполнена под проект. Root LICENSE и AGENTS.md не меняются.
- CLI установлен в облаке; executable не коммитится и не переносится на компьютер пользователя. Для CLI в новой среде: `uv tool install specify-cli==1.2.6`. Уже сохранённые команды и bash scripts доступны из checkout.

## Проверки

`SPECIFY_FEATURE_DIRECTORY=specs/001-jev-decisions bash .specify/scripts/bash/check-prerequisites.sh --json --require-spec --require-tasks --include-tasks` успешно находит спецификацию, план и задачи.

Bash syntax и JSON syntax проверяются перед публикацией. Ссылки в пользовательских документах должны вести на существующие файлы. Ни модельные вызовы, ни browser benchmark, ни функциональные тесты при этой документационной задаче не запускаются. Это проверка установки и полноты handoff, не runtime validation Stagehand или OMP.

Для OMP с этой сессией задайте `SPECIFY_FEATURE_DIRECTORY=specs/001-jev-decisions`; feature pointer локален и gitignored. Git-ветку `feat/jev-decisions` переименовывать не нужно.
