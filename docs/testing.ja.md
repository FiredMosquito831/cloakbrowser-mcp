---
description: CloakBrowser MCP のテスト戦略。単体テスト、偽 upstream 統合テスト、Docker smoke テスト、Playwright MCP との互換性チェックを扱います。
icon: material/test-tube
tags:
  - テスト
  - プロジェクト内部
---

# テスト

## 単体テスト

```bash
npm run test:unit
```

単体テストは、環境変数の解析、ブリッジ設定の生成、起動引数の処理、ローカル Cloak introspection ツールをカバーします。

## 統合テスト

```bash
npm run test:integration
```

統合テストは偽の upstream MCP 子プロセスを使用し、ブリッジがローカルツールを統合し、upstream 呼び出しを変更せずに転送することを検証します。

`npm run check` は単体、統合、パッケージ済み CLI のチェックを含みます。CLI テストはビルド済み `dist/cli.js` を模擬 upstream MCP に対して実行し、Chromium は起動しません。CI は Node.js 22 および 24-26 の Linux x64、Linux arm64、macOS arm64、macOS x64、Windows x64 でこれらのチェックとパッケージ検証を実行します。

## 実ブラウザと配布物のテスト

```bash
npm run test:e2e
npm run test:e2e:playwright-console
npm run test:e2e:cdp
npm run test:e2e:npm-package
npm run test:e2e:docker
npm run test:e2e:cdp:docker
```

`test:e2e` は模擬 upstream を使う CLI チェックと、実際の Playwright Chromium のコンソールチェックを組み合わせます。`test:e2e:playwright-console` は新しいセッションでコンソールメソッドを検証します。`test:e2e:cdp` は Free CloakBrowser と管理された Playwright Chromium を使い、管理対象の Chrome DevTools Protocol (CDP) アクセスを検証します。

`test:e2e:npm-package` はパッケージを作成して一時プロジェクトへインストールします。転送契約のチェックは模擬 upstream を使用し、ブラウザシナリオは実際の CloakBrowser とローカルページで標準ツール、永続状態、両方の人間らしい操作のプリセットを検証します。別のテストでは空のキャッシュへの同時ダウンロードと、stdout に余計なテキストがないことを確認します。パッケージ検証だけではブラウザの受け入れ確認になりません。

必須のブラウザ CI マトリクスは、上記 5 プラットフォームの Node.js 26 で CLI とコンソールをチェックします。管理対象 CDP は同じマトリクスに Linux x64 の Node.js 22 を追加します。Docker 配布物と管理対象 CDP の受け入れ確認は `linux/amd64` と `linux/arm64` で実行します。

別の Functional test reporting ワークフローは、npm-package、proxy/GeoIP、extensions、lifecycle のテストを毎週または手動で実行します。同じ 5 プラットフォームで Node.js 24 を使います。完全な npm 人間らしい操作のテストは、この重いワークフローに含まれます。

## テストレポート

各 CI マトリクスセルは、機密情報を除去した結果と診断添付をアップロードします。集約ジョブはテスト群と環境のラベルを保持して、1 つの Allure HTML レポートに統合します。必要な結果提供元の不足やテスト失敗で集約は失敗しますが、元の結果と HTML は Actions の成果物として残ります。

条件を満たす PR 実行は、設定された別のレポートリポジトリを通じてリンクを公開できます。公開には配信の有効化、実行証拠の検証、Pages チェックの成功が必要です。ドキュメントサイトは別にデプロイします。公開レポートには、管理されたテストデータから許可され、機密情報を除去した診断のみを含めます。

```bash
npm run test:report -- --suite unit --run-id local
npm run test:report:generate -- --input artifacts/test-results --output artifacts/test-report/local
npm run test:report:open -- --report artifacts/test-report/local
```

収集ツールが実際に出力したディレクトリを生成ツールの入力に指定してください。形式、添付、CI 配信は[貢献ガイド](contributing.md)を参照してください。

## パッケージ検証

```bash
npm run package:verify
```

このコマンドはパッケージをビルドし、`npm pack` を実行し、tarball のファイル一覧を確認し、一時プロジェクトへ tarball をインストールして CLI の `--version` と `--help` を検証します。

パッケージ検証では、公開済み MCP server schema に対して `server.json` も検証します。

## Docker smoke テスト

```bash
npm run docker:build
npm run docker:smoke
```

smoke テストは、ビルド済みイメージが起動して CLI ヘルプを出力することを確認します。CI は `linux/amd64` と `linux/arm64` の Docker イメージで smoke テストを実行します。

## Upstream 互換性

```bash
npm run bridge:compare
npm run bridge:compare -- cloakbrowser-mcp:dev --report bridge-parity-report.json
```

互換性スクリプトは、公式 Playwright MCP Docker イメージと CloakBrowser ブリッジイメージを起動し、upstream ツール名を比較し、同じ fixture ページで既定のブラウザーツール表面を実行し、ローカル Cloak introspection ツールを検証します。

CI は JSON 互換性レポートを Docker ビルドとリリースジョブの成果物としてアップロードします。ブラウザ互換性は `linux/amd64` で実行し、両アーキテクチャで smoke、脆弱性、配布物、管理対象 CDP のチェックも行います。固定された Docker MCP のバージョンを検証するもので、異なる npm MCP の受け入れ確認にはなりません。

## セキュリティチェック

```bash
npm run audit:prod
npm run server:validate
```

CI は CodeQL、Dependency Review、OpenSSF Scorecard、zizmor、Trivy も実行します。これらのツールは公開リポジトリでは無料で、外部アカウントを必要としません。
