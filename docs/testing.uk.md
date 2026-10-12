---
description: Стратегія тестування CloakBrowser MCP: модульні тести, інтеграційні тести з фальшивим upstream, Docker smoke-тести та перевірки сумісності з Playwright MCP.
icon: material/test-tube
tags:
  - Тестування
  - Внутрішній устрій проекту
---

# Тестування

## Модульні тести

```bash
npm run test:unit
```

Модульні тести покривають розбір змінних середовища, генерацію конфігурації моста, обробку аргументів запуску та локальні інструменти інтроспекції Cloak.

## Інтеграційні тести

```bash
npm run test:integration
```

Інтеграційні тести використовують фальшивий дочірній процес upstream MCP і перевіряють, що міст об'єднує локальні інструменти та пересилає upstream-виклики без змін.

`npm run check` включає модульні, інтеграційні та пакетні перевірки CLI. Набір CLI запускає зібраний `dist/cli.js` із fake upstream MCP і не запускає Chromium. CI виконує ці перевірки та перевірку пакета на Node.js 22 і 24-26 для Linux x64, Linux arm64, macOS arm64, macOS x64 і Windows x64.

## Перевірки справжнього браузера та дистрибутивів

```bash
npm run test:e2e
npm run test:e2e:playwright-console
npm run test:e2e:cdp
npm run test:e2e:npm-package
npm run test:e2e:docker
npm run test:e2e:cdp:docker
```

`test:e2e` об’єднує перевірки CLI із fake upstream і перевірки консолі справжнього Playwright Chromium. `test:e2e:playwright-console` перевіряє методи консолі в нових браузерних сеансах. `test:e2e:cdp` перевіряє керований доступ через Chrome DevTools Protocol (CDP) із Free CloakBrowser і контрольованим Playwright Chromium.

`test:e2e:npm-package` пакує та встановлює пакет у тимчасовий проєкт. Перевірка контракту пересилання використовує fake upstream; браузерні сценарії використовують справжній CloakBrowser і локальні сторінки для перевірки стандартних інструментів, постійного стану та обох пресетів humanize. Окремий тест перевіряє конкурентні завантаження в порожній кеш і відсутність стороннього тексту в stdout. Сама перевірка пакета не підтверджує роботу браузера.

Обов’язкова браузерна матриця CI виконує перевірки CLI та консолі на Node.js 26 для п’яти платформ вище. Керований CDP використовує ту саму матрицю та додаткову комірку Linux x64 із Node.js 22. Перевірки дистрибутива Docker і керованого CDP виконуються для `linux/amd64` та `linux/arm64`.

Окремий workflow Functional test reporting запускає набори npm-package, proxy/GeoIP, extensions і lifecycle щотижня та вручну. Він використовує Node.js 24 для тих самих п’яти платформ. Повний npm-набір humanize входить до цього важчого workflow.

## Звіти про тестування

Кожна комірка матриці CI завантажує очищені результати та діагностичні вкладення. Завдання агрегації об’єднує їх в один HTML-звіт Allure зі збереженням міток набору тестів і середовища. Відсутність очікуваних джерел результатів і падіння тестів спричиняють помилку агрегації; вихідні результати та HTML-звіт залишаються доступними як артефакти Actions.

Відповідні запуски PR можуть публікувати посилання на звіт через налаштований окремий репозиторій звітів. Для публікації потрібні ввімкнена доставка, перевірені дані запуску та успішна перевірка Pages. Сайт документації розгортається окремо. Публічні звіти містять лише дозволену й очищену діагностику з контрольованих тестових даних.

```bash
npm run test:report -- --suite unit --run-id local
npm run test:report:generate -- --input artifacts/test-results --output artifacts/test-report/local
npm run test:report:open -- --report artifacts/test-report/local
```

Використовуйте фактичний вихідний каталог збирача як вхід генератора. Формати звітів, вкладення й доставка через CI описані в розділі [Участь у розробці](contributing.md).

## Перевірка пакета

```bash
npm run package:verify
```

Ця команда збирає пакет, запускає `npm pack`, перевіряє список файлів tarball, встановлює tarball у тимчасовий проект і перевіряє `--version` та `--help` CLI.

Перевірка пакета також валідує `server.json` за опублікованою схемою MCP-сервера.

## Docker smoke-тест

```bash
npm run docker:build
npm run docker:smoke
```

Smoke-тест перевіряє, що зібраний образ запускається та виводить довідку CLI. CI виконує smoke-тести Docker-образів для `linux/amd64` і `linux/arm64`.

## Сумісність з upstream

```bash
npm run bridge:compare
npm run bridge:compare -- cloakbrowser-mcp:dev --report bridge-parity-report.json
```

Скрипт сумісності запускає офіційний Docker-образ Playwright MCP і образ моста CloakBrowser, порівнює імена upstream-інструментів, виконує стандартний набір браузерних інструментів на одній fixture-сторінці та перевіряє локальні інструменти інтроспекції Cloak.

CI завантажує JSON-звіт сумісності як артефакт для Docker-збірок і релізних завдань. Браузерну сумісність перевіряють на `linux/amd64`; обидві архітектури також виконують smoke-перевірки, перевірки вразливостей, дистрибутива та керованого CDP. Це підтверджує закріплену версію Docker MCP, а не іншу версію npm MCP.

## Перевірки безпеки

```bash
npm run audit:prod
npm run server:validate
```

CI також запускає CodeQL, Dependency Review, OpenSSF Scorecard, zizmor і Trivy. Ці інструменти безкоштовні для публічних репозиторіїв і не потребують зовнішніх облікових записів.
