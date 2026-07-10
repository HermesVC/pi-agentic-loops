# code-review-loop

Pi-расширение: автоматический цикл код-ревью с саб-агентом.

## Установка

### Способ 1: symlink (локально)
```bash
# Windows
mklink /D "%USERPROFILE%\.pi\agent\extensions\code-review-loop" ^
         "E:\Software\OpenServer\domains\automations\agentic_loops\extensions\code-review-loop"

# Linux/macOS
ln -s ~/.pi/agent/extensions/code-review-loop \
      ~/path/to/agentic_loops/extensions/code-review-loop
```

### Способ 2: через settings.json
Добавь в `~/.pi/settings.json`:
```json
{
  "extensions": ["E:/Software/OpenServer/domains/automations/agentic_loops/extensions/code-review-loop"]
}
```

### Способ 3: npm-пакет
```bash
# Упаковать
cd extensions/code-review-loop
npm pack

# Установить в Pi
pi install ./code-review-loop-1.0.0.tgz
```

## Использование

После установки агент видит инструмент `code_review_loop`:

```
code_review_loop(files: string[], task: string)
```

Примеры:
- `code_review_loop(["src/index.ts"], "добавлена обработка ошибок")`
- `code_review_loop(["package.json", "tsconfig.json"], "обновлены настройки проекта")`

## Как работает

1. Читает указанные файлы
2. Запускает саб-агент с промптом для ревью
3. Повторяет до 3 итераций (пока не найдёт проблемы)
4. Возвращает findings главному агенту

## Конфигурация

Все настройки в `index.ts`:
- `MAX_ITERATIONS` — макс. итераций (дефолт: 3)
- System prompt ревьюера — в `systemPromptOverride`
- Инструменты ревьюера — только `["read"]`
