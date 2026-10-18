---
title: "永続ログインプロファイル"
description: 永続プロファイルディレクトリで CloakBrowser cookies、local storage、キャッシュ、拡張機能状態を再利用します。
icon: material/account-key
tags:
  - User Guide
---

# 永続ログインプロファイル

永続プロファイルはブラウザーセッション間でログイン状態を保持します。

## npm

```bash
mkdir -p .profiles/default

PLAYWRIGHT_MCP_USER_DATA_DIR="$PWD/.profiles/default" \
  npx -y cloakbrowser-mcp@latest
```

同じコマンドで MCP クライアントを設定します。1 つのプロファイルディレクトリを複数のアクティブサーバーで共有しないでください。

異常終了後、ブリッジは記録されたプロセス ID が有効で、そのプロセスが存在しないことを確認できた場合にのみ `.cloakbrowser-mcp-profile.lock` を削除します。所有者が動作中の場合、内容が読み取れないか無効な場合、またはプロセスの状態を確認できない場合は、引き続き起動を拒否します。この復旧処理は、残っている Chromium プロセスを終了したり、Chromium 自身のロックを削除したりしません。

同じプロファイルでは、一度に 1 つのサーバーだけを再起動してください。古いロックの再確認と削除はアトミックな操作ではありません。新規作成したロックファイルへの書き込みに失敗した場合、ブリッジはファイル記述子を閉じ、そのパスが引き続き同じファイルを指している場合にのみ削除します。

## Docker

```bash
docker run --rm -i \
  -e PLAYWRIGHT_MCP_USER_DATA_DIR=/data/profiles/default \
  -v "$PWD/artifacts:/data" \
  swimmwatch/cloakbrowser-mcp:latest
```

環境変数ではコンテナパスを使います。ホストパスは volume mount にだけ指定します。

## 確認

1. MCP クライアントにログインページを開かせてログインしてください。
2. サーバーを正常に停止してください。
3. 同じ `PLAYWRIGHT_MCP_USER_DATA_DIR` で再び起動してください。
4. クライアントにサイトを再訪させ、ログイン状態が残っていることを確認してください。

## 関連

- [設定](../configuration.md#streamable-http-runtime-metadata)
- [Docker](../docker.md#persistent-profiles)
- [Chrome 拡張機能を読み込む](load-chrome-extension.md)

## CloakBrowser 0.6.0

CloakBrowser の stealth が有効な場合、明示的に設定された永続プロファイルは指紋シードを `.cloakbrowser-seed` に保存します。更新後の初回起動時にファイルがなければシードを割り当てます。`--fingerprint=off` を含む明示的な `--fingerprint` が優先され、ファイルは変更されません。stealth が無効な場合も変更されません。破損したファイルは警告とともに再生成され、ファイルへのアクセスに失敗すると起動を中止します。
