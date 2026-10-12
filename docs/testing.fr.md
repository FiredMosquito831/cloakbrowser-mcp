---
description: Stratégie de test de CloakBrowser MCP avec tests unitaires, tests d'intégration avec upstream factice, smoke tests Docker et contrôles de parité Playwright MCP.
icon: material/test-tube
tags:
  - Tests
  - Internes du projet
---

# Tests

## Tests unitaires

```bash
npm run test:unit
```

Les tests unitaires couvrent l'analyse de l'environnement, la génération de configuration du pont, la gestion des arguments de lancement et les outils locaux d'introspection Cloak.

## Tests d'intégration

```bash
npm run test:integration
```

Les tests d'intégration utilisent un processus enfant MCP upstream factice et vérifient que le pont fusionne les outils locaux et transmet les appels upstream sans modification.

`npm run check` comprend les tests unitaires, d’intégration et de CLI empaquetée. La suite CLI exécute le `dist/cli.js` compilé contre un upstream MCP simulé ; elle ne lance pas Chromium. CI exécute ces contrôles et la vérification du paquet sur Node.js 22 et 24-26 pour Linux x64, Linux arm64, macOS arm64, macOS x64 et Windows x64.

## Tests avec navigateur réel et distributions

```bash
npm run test:e2e
npm run test:e2e:playwright-console
npm run test:e2e:cdp
npm run test:e2e:npm-package
npm run test:e2e:docker
npm run test:e2e:cdp:docker
```

`test:e2e` combine les contrôles CLI avec upstream simulé et les contrôles de console avec Playwright Chromium réel. `test:e2e:playwright-console` vérifie les méthodes de console dans des sessions neuves. `test:e2e:cdp` vérifie l’accès géré via Chrome DevTools Protocol (CDP) avec Free CloakBrowser et Playwright Chromium contrôlé.

`test:e2e:npm-package` empaquette et installe le paquet dans un projet temporaire. Le contrôle du contrat de transfert utilise un upstream simulé ; les scénarios navigateur vérifient les outils standard, l’état persistant et les deux préréglages d’humanisation avec CloakBrowser réel et des pages locales. Un autre test vérifie les téléchargements concurrents dans un cache vide et l’absence de texte supplémentaire dans stdout. La vérification du paquet seule ne constitue pas une validation du navigateur.

La matrice navigateur CI obligatoire contrôle la CLI et la console sur Node.js 26 pour les cinq plateformes ci-dessus. Le CDP géré utilise la même matrice avec, en plus, Linux x64 sur Node.js 22. Les validations de distribution Docker et de CDP géré s’exécutent sur `linux/amd64` et `linux/arm64`.

Le workflow séparé Functional test reporting exécute les suites npm-package, proxy/GeoIP, extensions et lifecycle chaque semaine ou sur déclenchement manuel. Il utilise Node.js 24 sur les mêmes cinq plateformes. La suite npm complète d’humanisation fait partie de ce workflow plus lourd.

## Rapports de tests

Chaque cellule de la matrice CI téléverse des résultats assainis et des pièces jointes de diagnostic. L’agrégation les combine en un rapport HTML Allure en conservant les étiquettes de suite et d’environnement. L’absence de producteurs attendus et les tests échoués font échouer l’agrégation ; les résultats bruts et le HTML restent disponibles comme artefacts Actions.

Les exécutions PR admissibles peuvent publier un lien via le dépôt de rapports séparé configuré. La publication exige une livraison activée, des preuves d’exécution validées et une vérification Pages réussie. Le site documentaire est déployé séparément. Les rapports publics contiennent uniquement des diagnostics autorisés et assainis issus de données de test contrôlées.

```bash
npm run test:report -- --suite unit --run-id local
npm run test:report:generate -- --input artifacts/test-results --output artifacts/test-report/local
npm run test:report:open -- --report artifacts/test-report/local
```

Utilisez le répertoire de sortie réel du collecteur comme entrée du générateur. Voir [Contribuer](contributing.md) pour les formats, les pièces jointes et la livraison CI.

## Vérification du paquet

```bash
npm run package:verify
```

Cette commande construit le paquet, exécute `npm pack`, vérifie la liste des fichiers du tarball, installe le tarball dans un projet temporaire et valide `--version` et `--help` de la CLI.

La vérification du paquet valide aussi `server.json` avec le schéma publié de serveur MCP.

## Smoke test Docker

```bash
npm run docker:build
npm run docker:smoke
```

Le smoke test vérifie que l'image construite démarre et affiche l'aide de la CLI. CI exécute des smoke tests des images Docker pour `linux/amd64` et `linux/arm64`.

## Parité avec upstream

```bash
npm run bridge:compare
npm run bridge:compare -- cloakbrowser-mcp:dev --report bridge-parity-report.json
```

Le script de parité démarre l'image Docker officielle Playwright MCP et l'image du pont CloakBrowser, compare les noms d'outils upstream, exerce la surface d'outils navigateur par défaut sur une même page fixture et vérifie les outils locaux d'introspection Cloak.

CI téléverse le rapport JSON de parité comme artefact pour les builds Docker et les releases. La parité navigateur s’exécute sur `linux/amd64` ; les deux architectures exécutent aussi les contrôles smoke, de vulnérabilités, de distribution et de CDP géré. La parité valide la version Docker MCP fixée et non une version npm MCP différente.

## Contrôles de sécurité

```bash
npm run audit:prod
npm run server:validate
```

CI exécute également CodeQL, Dependency Review, OpenSSF Scorecard, zizmor et Trivy. Ces outils sont gratuits pour les dépôts publics et ne nécessitent pas de comptes externes.
