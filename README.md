# SpyService

Полноценный MVP панели для поиска и анализа рекламных креативов Meta Ads и TikTok Ads по техническому заданию.

## Что реализовано

- отдельные режимы Meta и TikTok;
- все фильтры из ТЗ, очистка и серверная выдача;
- адаптивная сетка, настройка плотности и количества колонок;
- бесконечная прокрутка и курсорная пагинация;
- карточки Meta с advertiser, датой, географией, плейсментами, текстом, CTA и landing URL;
- вертикальные TikTok-карточки с видео-превью;
- полноэкранный просмотр, открытие оригинала и скачивание прямого видео;
- избранное в MySQL/MariaDB или в памяти без БД;
- реальные адаптеры Meta Ad Library и TikTok Commercial Content API;
- demo-режим, в котором интерфейс запускается без внешних токенов;
- SQL-схема для импорта через phpMyAdmin и production-конфигурация для Ubuntu/HestiaCP.

## Локальный запуск

Требуется Node.js 22+ и pnpm через Corepack.

```bash
corepack enable
pnpm install
pnpm exec playwright install chromium
cp .env.example .env
pnpm dev
```

Откройте <http://localhost:5173>. API работает на <http://localhost:4100>, Vite проксирует `/api` автоматически.

## Проверки

```bash
pnpm typecheck
pnpm test
pnpm build
```

## Конфигурация

- `.env.example` — все переменные среды;
- `db/migrations/001_initial.sql` — MySQL/MariaDB-схема для phpMyAdmin;
- `db/migrations/002_integration_logs.sql` — таблица подробных логов Meta/TikTok;
- `db/migrations/005_review_proxy_settings.sql` — зашифрованные настройки прокси для Trustpilot/Capterra;
- `docs/API_ACCESS.md` — получение и подключение API-токенов;
- `docs/DEPLOY_HESTIA.md` — пошаговое production-развёртывание с объяснением роли каждого компонента.

Никакой API-секрет не попадает в React bundle: внешние запросы выполняются только Express-сервером.

Превью Meta загружаются из официального `ad_snapshot_url` через headless Chromium: сервер перехватывает настоящий JSON-запрос страницы и получает креатив, постер видео, аватар рекламодателя и `link_url` кнопки. Если Chromium установлен отдельно, укажите полный путь в `META_CHROMIUM_EXECUTABLE_PATH`.

## Интеграционные логи

После основной схемы импортируйте `db/migrations/002_integration_logs.sql`. В `integration_logs` сохраняются запрос, ответ, HTTP-метаданные, длительность, ошибка и подробные этапы разбора `parse_attempts`. Токены, Authorization и cookies маскируются.

Сервис при запуске и затем раз в неделю удаляет записи старше семи дней. Последние ошибки можно посмотреть запросом:

```sql
SELECT *
FROM integration_logs
WHERE status = 'error'
ORDER BY created_at DESC
LIMIT 100;
```
