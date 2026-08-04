# Доступ к рекламным API

Приложение работает в `API_MODE=auto`: если токен площадки заполнен, сервер запрашивает живые данные; если токена нет, используется встроенная демонстрационная коллекция. Секреты никогда не отправляются в браузер.

## Meta Ad Library API

1. Создайте приложение в Meta for Developers.
2. Пройдите процедуру доступа к Ad Library API и получите пользовательский access token.
3. Запишите токен в `META_ACCESS_TOKEN`, а поддерживаемую вашим приложением версию Graph API — в `META_GRAPH_VERSION`.
4. Перезапустите сервис и проверьте `/api/health`.

Адаптер вызывает `/{version}/ads_archive`, передаёт географию, поисковую фразу, диапазон дат и просит нормализованный набор полей. Важное ограничение: официальный endpoint возвращает `ad_snapshot_url`, но не гарантирует прямой URL исходного фото или видео. Поэтому живая Meta-карточка ведёт на оригинальный snapshot, а скачивание доступно только там, где площадка действительно отдала прямой медиа-URL.

Официальная справка: <https://developers.facebook.com/docs/graph-api/reference/ads_archive/>.

## TikTok Commercial Content API

1. Создайте TikTok for Developers account и подайте заявку на Commercial Content API.
2. После одобрения получите client key и client secret.
3. Получите client access token через OAuth endpoint TikTok и запишите его в `TIKTOK_ACCESS_TOKEN`.
4. У токена должен быть scope `research.adlib.basic`.

Адаптер вызывает `POST /v2/research/adlib/ad/query/`, передаёт обязательный диапазон дат, страну, advertiser/search term и `search_id` для следующей страницы. TikTok указывает, что доступность рекламных данных начинается с ЕЭЗ; UK и Швейцария в текущем контракте не входят в поддерживаемую географию.

Официальная справка: <https://developers.tiktok.com/doc/commercial-content-api-query-ads>.

## Проверка переключения

```bash
curl http://127.0.0.1:4100/api/health
curl 'http://127.0.0.1:4100/api/ads?source=meta&country=DE&search=coffee'
curl 'http://127.0.0.1:4100/api/ads?source=tiktok&country=DE&advertiser=coffee'
```

Ответ выдачи содержит `mode: "demo"` или `mode: "live"`. При `API_MODE=live` отсутствие токена считается ошибкой — это удобно для production-мониторинга, потому что проблема не маскируется демо-данными.
