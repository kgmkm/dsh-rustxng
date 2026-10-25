# dsh-rustxng

自前でホストした [RustXNG](https://github.com/sahenjp/RustXNG) を
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) から使うためのプラグインです。
内蔵の **`web_search`** を RustXNG が答えるように差し替えられます。

RustXNG は Rust 製の SearXNG 互換メタ検索エンジンで、1 回の検索が約 170 の検索サイトへ
fan-out し、重複を除いて結果を返します。広告も追跡もありません。このプラグインは、
自分で動かしている RustXNG（Windows / macOS / Linux）と DSH をつなぎ、次の 4 つを追加します。

| 追加されるもの | 内容 |
| :--- | :--- |
| **検索プロバイダ** | web シームに `rustxng` プロバイダを登録。`web.searchProvider` をそこへ向けると、内蔵 `web_search` が RustXNG 経由になります（DeepSeek の検索 API キー不要）。 |
| **設定カード** | **Plugins** に「RustXNG」カード。スイッチ 2 つと接続先 URL を、再起動なしで変更できます。YAML を手で書く必要はありません。 |
| **ツール** | `rustxng_search`（エンジン・カテゴリ・言語・期間を指定可能）と `rustxng_status`（到達性・バージョン・エンジン数・プロバイダ状態）。 |
| **バイナリ取得** | `node scripts/install-binary.mjs` が OS / CPU に合うリリースを SHA-256 検証付きで取得します。 |

DSH 本体には一切パッチを当てていません。公開 API の `ctx.web.registerSearchProvider()` と、
通常の設定フィールド `web.searchProvider` だけを使うので、Harness を更新しても壊れません。

---

## 必要なもの

- DeepSeek Harness `>= 0.2.0-rc.2 < 0.3.0`（host の `tools` / `web` / `settings` を使用）。
  **0.2.0-rc.2** と **0.2.1-rc.2** で動作確認済み（[docs/PLATFORMS.md](docs/PLATFORMS.md#dsh-versions)）。
- Node.js 20 以上（グローバルの `fetch` を使用）
- 起動中の RustXNG

## 1. RustXNG を用意する

**いちばん簡単な方法**（リリースバイナリを取得）:

```bash
node scripts/install-binary.mjs                 # $DSH_HOME/bin（無ければ ~/.dsh/bin）へ
node scripts/install-binary.mjs --dir ./bin --musl   # glibc の無い Linux 向け
```

プラットフォームに合う資産を選び、公開されている SHA-256 を検証してから配置し、
起動コマンドを表示します。

**手動**でよければ [releases](https://github.com/sahenjp/RustXNG/releases/latest) から取得します。

| プラットフォーム | 資産名 |
| :--- | :--- |
| Windows x64 | `rustxng-v<ver>-x86_64-pc-windows-msvc.exe` |
| macOS arm64 | `rustxng-v<ver>-aarch64-apple-darwin` |
| macOS x64 | `rustxng-v<ver>-x86_64-apple-darwin` |
| Linux x64 (glibc) | `rustxng-v<ver>-x86_64-unknown-linux-gnu` |
| Linux x64 (musl) | `rustxng-v<ver>-x86_64-unknown-linux-musl` |

起動:

```bash
rustxng --port 8888                       # 既定は 127.0.0.1:8888
curl 'http://127.0.0.1:8888/healthz'      # → OK
```

RustXNG 自身の検索画面は <http://127.0.0.1:8888/> にあります。このプラグインはその画面を
置き換えるものではなく、同じ JSON API を利用します。

## 2. プラグインを入れる

```bash
# レジストリから（推奨）
dsh plugin --profile web add dsh-rustxng

# このリポジトリのチェックアウトから
git clone https://github.com/<owner>/dsh-rustxng.git
# その後 Plugin Manager → install bundle → チェックアウトしたディレクトリを指定
```

チェックアウトからの導入はディレクトリが**リンク**され、Node はプラグインの実パス
（`.../dsh-rustxng`）で解決します。そのため `@deepseek-ai/schemastery` が見つからない場合は、
スキーマを黙って捨てず、実行中の Harness のエントリポイント経由で読み込みます。

## 3. 有効にする

**Plugins → RustXNG** を開き「web_search に RustXNG を使う」をオンにします。
プロファイルの patch（`~/.dsh/profiles/<profile>/cordis.patch.yml`）に書いても同じです。

```yaml
- id: dsh-rustxng
  config:
    baseUrl: http://127.0.0.1:8888
    webSearch:
      enabled: true
      autoSelect: true
```

以降 `web_search` は RustXNG が答えます。`enabled` / `autoSelect` / 接続先 URL は
volatile フィールドなので、カードからの変更が即座に効きます。オフにすると
`web.searchProvider` は以前の値に戻ります。

## 設定項目

| キー | 既定値 | 内容 |
| :--- | :--- | :--- |
| `enabled` | `true` | マスタースイッチ。`false` でツール解除＋プロバイダ登録解除。 |
| `baseUrl` | `http://127.0.0.1:8888` | RustXNG の待ち受けアドレス。volatile。 |
| `timeoutMs` | `20000` | 1 検索のタイムアウト。 |
| `defaultLimit` | `12` | `web_search` に渡す件数（1〜50）。 |
| `language` | `''` | 検索言語（`ja` / `en` …）。空ならインスタンス既定。 |
| `timeRange` | `''` | `day` / `week` / `month` / `year`。空なら無指定。 |
| `safeSearch` | `-1` | `-1` はインスタンス既定、それ以外は `0`/`1`/`2`。 |
| `categories` | `[]` | 常に適用するカテゴリ（`general` / `it` …）。 |
| `exposeTools` | `true` | `rustxng_search` / `rustxng_status` を登録。 |
| `webSearch.enabled` | `false` | 内蔵 `web_search` を差し替える。volatile。 |
| `webSearch.autoSelect` | `true` | `web.searchProvider = 'rustxng'` を自動で書く。volatile。 |
| `debug` | `false` | プロバイダの判断をログに出す。 |

## ツール

```jsonc
// rustxng_search
{ "query": "rust async runtime", "limit": 8, "engine": "arxiv", "time_range": "year" }
{ "query": "東京 天気", "category": "news", "language": "ja" }
```

`rustxng_status` は、インスタンスの応答・バージョン・有効エンジン数・プロバイダ登録状況・
`web.searchProvider` の現在値を返します。検索が失敗したらまずこれを実行してください。

## 対応プラットフォーム

| プラットフォーム | 状態 |
| :--- | :--- |
| Windows 10/11 x64 | 検証済み: リリースバイナリ＋本プラグイン（検索・差し替え・設定カード）を DSH 0.2.1-rc.2 で確認 |
| Linux x64（glibc / musl） | 検証済み: 単体 Ubuntu 26.04 サーバ（DSH 0.2.0-rc.2 で差し替え・カード表示）、WSL2（両バイナリ 12/12） |
| macOS arm64 / x64 | 設計上対応（リリース資産あり）。検証は未実施 |

検証手順・バイナリの置き場所・OS 毎の注意（PATH、サービス登録、WSL、musl）は
[docs/PLATFORMS.md](docs/PLATFORMS.md) にまとめています。

## うまくいかないとき

| 症状 | 対処 |
| :--- | :--- |
| `RustXNG is not answering at …` | インスタンスを起動するか、カードの接続先 URL を直す。`rustxng_status` に probe のエラーが出ます。 |
| 差し替えたのに DeepSeek の 401 が出る | プロバイダが選ばれていません。カードの 1 つ目のスイッチ、または公式の *Web search* ページの `web.searchProvider` を確認。0.2.0-rc.2 ではプラグインからこの値を書けないため、profile patch か `DSH_WEB_SEARCH_PROVIDER=rustxng` を使ってください。 |
| Plugins にカードが出ない | プラグイン行が有効か（Plugin Manager）、DSH のバージョンが `dsh.compatibility` を満たすかを確認。チェックアウト導入ではスキーマを Harness 側から解決します。`rustxng_status` の `Config schema:` 行が `loaded via …` か解決エラーかを示します（0.1.2 で `<prefix>/bin/dsh` のようなシンボリックリンクにも対応）。 |
| `rustxng_status` が実設定と違って `Replace web_search: no (default)` と出る | 0.1.2 で修正済み（live 値の比較漏れ）。旧版でも動作自体は正しく、表示だけの問題です。 |
| 結果が少ない | 一部エンジンは IP 単位でレート制限されます。`rustxng_status` や RustXNG の `/stats` で停止中のエンジンを確認。`!engine query` は依然使えます。 |

## 開発

```bash
node tests/apply.test.mjs   # スタブのインスタンスに対してホスト側を検証（実機・ネットワーク不要）
node tests/resolve.test.mjs # シンボリックリンク経由の launcher でもホスト依存を解決できるか（Linux 想定）
node tests/smoke.mjs        # 応答の正規化＋OS 判定（+ 実インスタンスがあれば実検索）
```

構成:

```
index.js                ホスト側: Config、プロバイダ／ツールの配線、選択のハンドオーバ、
                        シンボリックリンク対応のホスト依存解決
lib/rustxng-client.js   HTTP クライアント（クエリ生成・応答正規化・タイムアウト）
lib/web-provider.js     `rustxng` プロバイダと web.searchProvider の受け渡し
lib/tools.js            rustxng_search / rustxng_status
lib/client.js           設定カード（Plugins → RustXNG）
scripts/install-binary.mjs  SHA-256 検証付きのクロスプラットフォーム取得スクリプト
scripts/verify-linux.sh     POSIX 向け 12 項目の検証スクリプト
```

## ライセンスと帰属

MIT（[LICENSE](LICENSE)）。

RustXNG 本体は **AGPL-3.0-or-later** で、本プラグインには同梱していません。プラグインは
別プロセスの HTTP API を叩くだけで、バイナリは `scripts/install-binary.mjs` が
RustXNG 自身のリリースページから取得します。改変した RustXNG を配布・公開する場合の
AGPL 第 13 条はその成果物に適用され、本プラグインには及びません。
