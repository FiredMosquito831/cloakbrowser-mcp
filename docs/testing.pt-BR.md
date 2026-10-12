---
description: Estratégia de testes do CloakBrowser MCP com testes unitários, integração com upstream falso, smoke tests de Docker e verificações de paridade com Playwright MCP.
icon: material/test-tube
tags:
  - Testes
  - Internos do projeto
---

# Testes

## Testes unitários

```bash
npm run test:unit
```

Os testes unitários cobrem análise de ambiente, geração da configuração da ponte, tratamento de argumentos de inicialização e ferramentas locais de introspecção do Cloak.

## Testes de integração

```bash
npm run test:integration
```

Os testes de integração usam um processo filho MCP upstream falso e verificam que a ponte mescla ferramentas locais e encaminha chamadas upstream sem alterações.

`npm run check` inclui testes unitários, de integração e da CLI empacotada. A suite CLI executa o `dist/cli.js` compilado contra fake upstream MCP; ela não inicia Chromium. O CI executa esses testes e a verificação do pacote no Node.js 22 e 24-26 para Linux x64, Linux arm64, macOS arm64, macOS x64 e Windows x64.

## Testes com navegador real e distribuições

```bash
npm run test:e2e
npm run test:e2e:playwright-console
npm run test:e2e:cdp
npm run test:e2e:npm-package
npm run test:e2e:docker
npm run test:e2e:cdp:docker
```

`test:e2e` combina testes de CLI com fake upstream e testes de console com Playwright Chromium real. `test:e2e:playwright-console` verifica métodos de console em sessões novas. `test:e2e:cdp` verifica acesso gerenciado por Chrome DevTools Protocol (CDP) com Free CloakBrowser e Playwright Chromium controlado.

`test:e2e:npm-package` empacota e instala o pacote em um projeto temporário. O teste do contrato de encaminhamento usa fake upstream; os cenários de navegador usam CloakBrowser real e páginas locais para verificar ferramentas padrão, estado persistente e ambos os presets de humanização. Outro teste verifica downloads concorrentes em um cache vazio e stdout sem texto adicional. A verificação do pacote, sozinha, não valida o navegador.

A matriz obrigatória de navegadores no CI executa testes de CLI e console no Node.js 26 nas cinco plataformas acima. O CDP gerenciado usa a mesma matriz e Linux x64 com Node.js 22. A aceitação da distribuição Docker e do CDP gerenciado roda em `linux/amd64` e `linux/arm64`.

O workflow separado Functional test reporting executa as suites npm-package, proxy/GeoIP, extensions e lifecycle semanalmente e por acionamento manual. Ele usa Node.js 24 nas mesmas cinco plataformas. A suite npm completa de humanização faz parte desse workflow mais pesado.

## Relatórios de testes

Cada célula da matriz CI envia resultados sanitizados e anexos de diagnóstico. O job de agregação combina tudo em um relatório HTML do Allure, mantendo as etiquetas de suite e ambiente. Produtores esperados ausentes e testes com falha fazem a agregação falhar; os resultados originais e o HTML continuam disponíveis como artefatos do Actions.

PRs elegíveis podem publicar um link por meio do repositório separado de relatórios configurado. A publicação exige entrega habilitada, evidências validadas da execução e verificação bem-sucedida do Pages. O site de documentação é implantado separadamente. Relatórios públicos contêm apenas diagnósticos permitidos e sanitizados de fixtures controladas.

```bash
npm run test:report -- --suite unit --run-id local
npm run test:report:generate -- --input artifacts/test-results --output artifacts/test-report/local
npm run test:report:open -- --report artifacts/test-report/local
```

Use o diretório real de saída do coletor como entrada do gerador. Consulte [Contribuindo](contributing.md) para formatos, anexos e entrega pelo CI.

## Verificação do pacote

```bash
npm run package:verify
```

Isso compila o pacote, executa `npm pack`, verifica a lista de arquivos do tarball, instala o tarball em um projeto temporário e valida `--version` e `--help` da CLI.

A verificação do pacote também valida `server.json` contra o esquema publicado de servidor MCP.

## Smoke test de Docker

```bash
npm run docker:build
npm run docker:smoke
```

O smoke test verifica que a imagem criada inicia e imprime a ajuda da CLI. O CI executa smoke tests das imagens Docker para `linux/amd64` e `linux/arm64`.

## Paridade com upstream

```bash
npm run bridge:compare
npm run bridge:compare -- cloakbrowser-mcp:dev --report bridge-parity-report.json
```

O script de paridade inicia a imagem Docker oficial do Playwright MCP e a imagem da ponte CloakBrowser, compara os nomes das ferramentas upstream, exercita a superfície padrão de ferramentas de navegador em uma mesma página fixture e verifica as ferramentas locais de introspecção do Cloak.

O CI envia o relatório JSON de paridade como artefato para builds Docker e releases. A paridade do navegador roda em `linux/amd64`; ambas as arquiteturas também executam smoke tests, verificações de vulnerabilidades, distribuição e CDP gerenciado. A paridade valida a versão Docker MCP fixada e não comprova a aceitação de outra versão npm MCP.

## Verificações de segurança

```bash
npm run audit:prod
npm run server:validate
```

O CI também executa CodeQL, Dependency Review, OpenSSF Scorecard, zizmor e Trivy. Essas ferramentas são gratuitas para repositórios públicos e não exigem contas externas.
