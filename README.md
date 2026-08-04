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
- `docs/API_ACCESS.md` — получение и подключение API-токенов;
- `docs/DEPLOY_HESTIA.md` — пошаговое production-развёртывание с объяснением роли каждого компонента.

Никакой API-секрет не попадает в React bundle: внешние запросы выполняются только Express-сервером.
