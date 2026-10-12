---
description: Teststrategie für CloakBrowser MCP mit Unit-Tests, Fake-Upstream-Integrationstests, Docker-Smoke-Tests und Playwright-MCP-Paritätsprüfungen.
icon: material/test-tube
tags:
  - Tests
  - Projektinternes
---

# Tests

## Unit-Tests

```bash
npm run test:unit
```

Unit-Tests decken das Parsen der Umgebung, die Bridge-Konfigurationserzeugung, die Verarbeitung von Startargumenten und lokale Cloak-Introspection-Tools ab.

## Integrationstests

```bash
npm run test:integration
```

Integrationstests verwenden einen gefälschten upstream MCP-Kindprozess und prüfen, dass die Bridge lokale Tools zusammenführt und upstream-Aufrufe unverändert weiterleitet.

`npm run check` umfasst Unit-, Integrations- und paketierte CLI-Prüfungen. Die CLI-Suite führt das gebaute `dist/cli.js` gegen einen simulierten Upstream-MCP aus; sie startet Chromium nicht. CI führt diese Prüfungen und die Paketverifikation auf Node.js 22 und 24-26 unter Linux x64, Linux arm64, macOS arm64, macOS x64 und Windows x64 aus.

## Tests mit echten Browsern und Distributionen

```bash
npm run test:e2e
npm run test:e2e:playwright-console
npm run test:e2e:cdp
npm run test:e2e:npm-package
npm run test:e2e:docker
npm run test:e2e:cdp:docker
```

`test:e2e` kombiniert CLI-Prüfungen mit simuliertem Upstream und Konsolenprüfungen mit echtem Playwright Chromium. `test:e2e:playwright-console` prüft Konsolenmethoden in frischen Sitzungen. `test:e2e:cdp` prüft verwalteten Zugriff über das Chrome DevTools Protocol (CDP) mit Free CloakBrowser und kontrolliertem Playwright Chromium.

`test:e2e:npm-package` packt und installiert das Paket in ein temporäres Projekt. Die Weiterleitungsvertragsprüfung nutzt einen simulierten Upstream; Browserszenarien prüfen Standard-Tools, persistenten Zustand und beide Humanisierungs-Presets mit echtem CloakBrowser und lokalen Seiten. Ein separater Test prüft parallele Downloads in einen leeren Cache und stdout ohne Zusatztext. Paketverifikation allein ist keine Browserabnahme.

Die verpflichtende Browser-CI-Matrix prüft CLI und Konsole auf Node.js 26 für die fünf genannten Plattformen. Verwaltetes CDP nutzt dieselbe Matrix sowie Linux x64 auf Node.js 22. Docker-Distributions- und verwaltete CDP-Abnahmen laufen auf `linux/amd64` und `linux/arm64`.

Der separate Workflow Functional test reporting führt die Suites npm-package, proxy/GeoIP, extensions und lifecycle wöchentlich und bei manueller Auslösung aus. Er verwendet Node.js 24 auf denselben fünf Plattformen. Die vollständige npm-Humanisierungssuite ist Teil dieses umfangreicheren Workflows.

## Testberichte

Jede CI-Matrixzelle lädt bereinigte Ergebnisse und Diagnoseanhänge hoch. Der Aggregationsjob erstellt einen gemeinsamen Allure-HTML-Bericht und erhält Suite- und Umgebungslabels. Fehlende erwartete Produzenten und fehlgeschlagene Tests lassen die Aggregation scheitern; Rohdaten und HTML bleiben als Actions-Artefakte verfügbar.

Geeignete PR-Läufe können einen Link über das konfigurierte separate Berichtsrepository veröffentlichen. Dafür sind aktivierte Bereitstellung, geprüfte Laufnachweise und eine erfolgreiche Pages-Verifikation nötig. Die Dokumentationswebsite wird separat bereitgestellt. Öffentliche Berichte enthalten nur erlaubte, bereinigte Diagnosen aus kontrollierten Testdaten.

```bash
npm run test:report -- --suite unit --run-id local
npm run test:report:generate -- --input artifacts/test-results --output artifacts/test-report/local
npm run test:report:open -- --report artifacts/test-report/local
```

Verwenden Sie das tatsächliche Ausgabeverzeichnis des Collectors als Generatoreingabe. Formate, Anhänge und CI-Bereitstellung beschreibt [Mitwirken](contributing.md).

## Paketverifizierung

```bash
npm run package:verify
```

Dies baut das Paket, führt `npm pack` aus, prüft die Tarball-Dateiliste, installiert den Tarball in ein temporäres Projekt und verifiziert CLI `--version` und `--help`.

Die Paketverifizierung validiert außerdem `server.json` gegen das veröffentlichte MCP-Server-Schema.

## Docker-Smoke-Test

```bash
npm run docker:build
npm run docker:smoke
```

Der Smoke-Test prüft, dass das gebaute Image startet und CLI-Hilfe ausgibt. CI führt Smoke-Tests für Docker-Images auf `linux/amd64` und `linux/arm64` aus.

## Upstream-Parität

```bash
npm run bridge:compare
npm run bridge:compare -- cloakbrowser-mcp:dev --report bridge-parity-report.json
```

Das Paritätsskript startet das offizielle Playwright-MCP-Docker-Image und das CloakBrowser-Bridge-Image, vergleicht upstream-Toolnamen, übt die Standard-Browser-Tooloberfläche auf derselben Fixture-Seite aus und prüft lokale Cloak-Introspection-Tools.

CI lädt den JSON-Paritätsbericht als Artefakt für Docker-Builds und Releases hoch. Browser-Parität läuft auf `linux/amd64`; beide Architekturen führen außerdem Smoke-, Schwachstellen-, Distributions- und verwaltete CDP-Prüfungen aus. Die Parität bestätigt die festgelegte Docker-MCP-Version, nicht eine abweichende npm-MCP-Version.

## Sicherheitsprüfungen

```bash
npm run audit:prod
npm run server:validate
```

CI führt außerdem CodeQL, Dependency Review, OpenSSF Scorecard, zizmor und Trivy aus. Diese Werkzeuge sind für öffentliche Repositorys kostenlos und erfordern keine externen Konten.
