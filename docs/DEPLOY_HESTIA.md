# Развёртывание SpyService на Ubuntu с HestiaCP

Ниже используется схема: интернет → Nginx/HestiaCP → `127.0.0.1:4100` → Node.js/Express → PostgreSQL. Nginx принимает HTTPS и домен, Node.js обслуживает API и собранный React, PostgreSQL хранит заметки и оставляет основу для кеша собранных объявлений.

Подставьте свои значения вместо `HESTIA_USER` и `DOMAIN`.

## 1. Что должно быть на сервере

- Node.js 22 или новее (актуальную LTS-ветку предпочтительнее ставить системно, чтобы путь `/usr/bin/node` был стабилен для systemd).
- Corepack/pnpm для точной установки lock-файла.
- PostgreSQL 14 или новее либо отдельный управляемый PostgreSQL.
- Домен, уже добавленный в HestiaCP, с включённым Let's Encrypt SSL.

Проверка:

```bash
node --version
corepack --version
psql --version
```

`Node.js` исполняет серверный JavaScript. `pnpm` ставит зависимости, зафиксированные в `pnpm-lock.yaml`. `systemd` держит процесс запущенным и автоматически восстанавливает его после сбоя или перезагрузки. `Nginx` завершает TLS и проксирует запросы к закрытому локальному порту приложения.

## 2. Загрузка и сборка

```bash
sudo -u HESTIA_USER mkdir -p /home/HESTIA_USER/web/DOMAIN/nodeapp
sudo -u HESTIA_USER git clone YOUR_REPOSITORY_URL /home/HESTIA_USER/web/DOMAIN/nodeapp
cd /home/HESTIA_USER/web/DOMAIN/nodeapp
sudo -u HESTIA_USER corepack enable
sudo -u HESTIA_USER pnpm install --frozen-lockfile
sudo -u HESTIA_USER pnpm build
sudo -u HESTIA_USER cp .env.example .env
sudo -u HESTIA_USER chmod 600 .env
```

Сборка создаёт `dist/` с браузерными файлами и `dist-server/` с сервером. В production не нужен Vite: Express раздаёт готовый `index.html`, CSS и JavaScript из `dist/`.

## 3. PostgreSQL

Создайте БД и отдельного пользователя. Не используйте суперпользователя приложения.

```bash
sudo -u postgres psql
```

```sql
CREATE ROLE spyservice LOGIN PASSWORD 'LONG_RANDOM_PASSWORD';
CREATE DATABASE spyservice OWNER spyservice;
\q
```

Примените схему:

```bash
PGPASSWORD='LONG_RANDOM_PASSWORD' psql \
  --host=127.0.0.1 --username=spyservice --dbname=spyservice \
  --file=db/migrations/001_initial.sql
```

В `.env`:

```dotenv
NODE_ENV=production
PORT=4100
TRUST_PROXY=true
API_MODE=auto
DATABASE_URL=postgresql://spyservice:URL_ENCODED_PASSWORD@127.0.0.1:5432/spyservice
META_ACCESS_TOKEN=
META_GRAPH_VERSION=v26.0
TIKTOK_ACCESS_TOKEN=
```

`TRUST_PROXY=true` сообщает Express, что реальный IP и протокол приходят от доверенного Nginx. Пароль внутри URL нужно percent-encode, если он содержит `@`, `:`, `/`, `?` или `#`.

## 4. Systemd

Скопируйте `deploy/spyservice.service.example` в `/etc/systemd/system/spyservice.service`, замените `HESTIA_USER` и `DOMAIN`, затем:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now spyservice
sudo systemctl status spyservice
curl http://127.0.0.1:4100/api/health
```

Логи:

```bash
journalctl -u spyservice -n 100 --no-pager
journalctl -u spyservice -f
```

Порт `4100` не нужно открывать в firewall: Nginx обращается к нему через loopback. Это уменьшает поверхность атаки.

## 5. HestiaCP reverse proxy

Hestia генерирует конфигурацию домена из парных шаблонов `.tpl` (HTTP) и `.stpl` (HTTPS). Ручная правка сгенерированного `nginx.conf` ненадёжна: Hestia перезапишет её при следующем rebuild.

Для связки Nginx + Apache разместите шаблоны проекта в каталоге proxy templates:

```bash
sudo cp deploy/hestia/spyservice.tpl /usr/local/hestia/data/templates/web/nginx/spyservice.tpl
sudo cp deploy/hestia/spyservice.stpl /usr/local/hestia/data/templates/web/nginx/spyservice.stpl
sudo chmod 644 /usr/local/hestia/data/templates/web/nginx/spyservice.*tpl
```

В HestiaCP откройте `Web → DOMAIN → Edit`, выберите `spyservice` в поле Proxy Template и сохраните. Через CLI эквивалентная операция:

```bash
sudo /usr/local/hestia/bin/v-change-web-domain-proxy-tpl HESTIA_USER DOMAIN spyservice '' yes
sudo nginx -t
```

Если сервер работает в режиме Nginx standalone, местоположение web template отличается (`.../web/nginx/php-fpm/`). Проверьте тип текущего web stack в `Server → Configure`; не смешивайте два каталога шаблонов.

Пара файлов обязательна: HTTP нужен для ACME challenge и редиректов Hestia, HTTPS — для основного трафика. Заголовки `X-Forwarded-*` сохраняют исходный IP и протокол; `Upgrade`/`Connection` оставлены для совместимости с будущими realtime-функциями.

## 6. SSL и финальная проверка

В настройках домена Hestia включите SSL, Let's Encrypt и перенаправление HTTP → HTTPS. Затем проверьте:

```bash
curl -I https://DOMAIN/
curl https://DOMAIN/api/health
sudo nginx -t
sudo systemctl is-active spyservice
```

Откройте сайт, убедитесь, что в выдаче указан ожидаемый режим `демо-режим` или `живые данные`, добавьте карточку в заметки и обновите страницу. При подключённой БД заметка должна сохраниться.

## 7. Обновление без ручной пересборки конфигурации

```bash
cd /home/HESTIA_USER/web/DOMAIN/nodeapp
sudo -u HESTIA_USER git pull --ff-only
sudo -u HESTIA_USER pnpm install --frozen-lockfile
sudo -u HESTIA_USER pnpm build
sudo systemctl restart spyservice
curl --fail http://127.0.0.1:4100/api/health
```

Сначала собирается новая версия, затем коротко перезапускается процесс. Для полностью безостановочного развёртывания следующим шагом можно добавить два экземпляра приложения и балансировку, но для одной внутренней панели systemd-процесс проще и прозрачнее.

## 8. Резервное копирование

В резервную копию включите `.env` (зашифрованно и отдельно от репозитория) и PostgreSQL:

```bash
PGPASSWORD='LONG_RANDOM_PASSWORD' pg_dump \
  --host=127.0.0.1 --username=spyservice --format=custom \
  --file=/home/HESTIA_USER/backups/spyservice.dump spyservice
```

Медиафайлы площадок приложение не копирует на диск: оно хранит URL и метаданные. Это сознательно уменьшает объём резервных копий и риск нарушения условий API.
