---
description: Estrategia de pruebas de CloakBrowser MCP con pruebas unitarias, integración con upstream falso, pruebas smoke de Docker y comprobaciones de paridad con Playwright MCP.
icon: material/test-tube
tags:
  - Pruebas
  - Internos del proyecto
---

# Pruebas

## Pruebas unitarias

```bash
npm run test:unit
```

Las pruebas unitarias cubren el análisis del entorno, la generación de configuración del puente, el manejo de argumentos de lanzamiento y las herramientas locales de introspección de Cloak.

## Pruebas de integración

```bash
npm run test:integration
```

Las pruebas de integración usan un proceso hijo MCP upstream falso y verifican que el puente combine las herramientas locales y reenvíe las llamadas upstream sin cambios.

`npm run check` incluye pruebas unitarias, de integración y de la CLI empaquetada. La suite CLI ejecuta el `dist/cli.js` compilado contra fake upstream MCP; no inicia Chromium. CI ejecuta estas pruebas y la verificación del paquete en Node.js 22 y 24-26 para Linux x64, Linux arm64, macOS arm64, macOS x64 y Windows x64.

## Pruebas con navegador real y distribuciones

```bash
npm run test:e2e
npm run test:e2e:playwright-console
npm run test:e2e:cdp
npm run test:e2e:npm-package
npm run test:e2e:docker
npm run test:e2e:cdp:docker
```

`test:e2e` combina pruebas de CLI con fake upstream y pruebas de consola con Playwright Chromium real. `test:e2e:playwright-console` verifica los métodos de consola en sesiones nuevas. `test:e2e:cdp` verifica el acceso administrado mediante Chrome DevTools Protocol (CDP) con Free CloakBrowser y Playwright Chromium controlado.

`test:e2e:npm-package` empaqueta e instala el paquete en un proyecto temporal. La prueba del contrato de reenvío usa fake upstream; los escenarios de navegador usan CloakBrowser real y páginas locales para verificar herramientas estándar, estado persistente y ambos presets de humanización. Otra prueba verifica descargas concurrentes en una caché vacía y stdout sin texto adicional. Verificar el paquete por sí solo no valida el navegador.

La matriz obligatoria de navegadores en CI ejecuta pruebas de CLI y consola en Node.js 26 para las cinco plataformas anteriores. CDP administrado usa la misma matriz más Linux x64 con Node.js 22. Las pruebas de aceptación de la distribución Docker y de CDP administrado se ejecutan en `linux/amd64` y `linux/arm64`.

El workflow independiente Functional test reporting ejecuta las suites npm-package, proxy/GeoIP, extensions y lifecycle cada semana y por activación manual. Usa Node.js 24 en las mismas cinco plataformas. La suite npm completa de humanización forma parte de este workflow más pesado.

## Informes de pruebas

Cada celda de la matriz CI sube resultados saneados y adjuntos de diagnóstico. El trabajo de agregación los combina en un informe HTML de Allure, conservando las etiquetas de suite y entorno. La falta de productores esperados y las pruebas fallidas hacen fallar la agregación; los resultados originales y el informe HTML quedan disponibles como artefactos de Actions.

Los PR elegibles pueden publicar un enlace al informe mediante el repositorio independiente configurado. La publicación requiere entrega habilitada, evidencia validada de la ejecución y verificación correcta de Pages. El sitio de documentación se despliega por separado. Los informes públicos solo contienen diagnósticos permitidos y saneados de fixtures controlados.

```bash
npm run test:report -- --suite unit --run-id local
npm run test:report:generate -- --input artifacts/test-results --output artifacts/test-report/local
npm run test:report:open -- --report artifacts/test-report/local
```

Usa el directorio de salida real del recolector como entrada del generador. Consulta [Contribuir](contributing.md) para los formatos, adjuntos y entrega por CI.

## Verificación del paquete

```bash
npm run package:verify
```

Esto compila el paquete, ejecuta `npm pack`, comprueba la lista de archivos del tarball, instala el tarball en un proyecto temporal y verifica `--version` y `--help` de la CLI.

La verificación del paquete también valida `server.json` contra el esquema publicado de servidor MCP.

## Prueba smoke de Docker

```bash
npm run docker:build
npm run docker:smoke
```

La prueba smoke verifica que la imagen creada arranque e imprima la ayuda de la CLI. CI ejecuta pruebas smoke de las imágenes Docker para `linux/amd64` y `linux/arm64`.

## Paridad con upstream

```bash
npm run bridge:compare
npm run bridge:compare -- cloakbrowser-mcp:dev --report bridge-parity-report.json
```

El script de paridad inicia la imagen Docker oficial de Playwright MCP y la imagen del puente CloakBrowser, compara los nombres de herramientas upstream, ejercita la superficie predeterminada de herramientas de navegador en una misma página fixture y verifica las herramientas locales de introspección de Cloak.

CI sube el informe JSON de paridad como artefacto para builds Docker y releases. La paridad del navegador se ejecuta en `linux/amd64`; ambas arquitecturas también ejecutan pruebas smoke, de vulnerabilidades, de distribución y de CDP administrado. La paridad valida la versión Docker MCP fijada y no confirma la aceptación de otra versión npm MCP.

## Comprobaciones de seguridad

```bash
npm run audit:prod
npm run server:validate
```

CI también ejecuta CodeQL, Dependency Review, OpenSSF Scorecard, zizmor y Trivy. Estas herramientas son gratuitas para repositorios públicos y no requieren cuentas externas.
