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
| **ページ取得**（任意） | 文字コード対応の `web_fetch`。BOM → HTTP ヘッダ → `<meta charset>` の順に判定して復号するので、`<meta>` でしか Shift_JIS を宣言していない日本語サイトが `�` にならなくなります。RustXNG は使いません。 |
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
| `webFetch.enabled` | `false` | `web_fetch` を文字コード対応の取得層に差し替える。volatile。 |
| `webFetch.autoSelect` | `true` | `web.fetchProvider = 'rustxng-http'` を自動で書く。volatile。 |
| `autoStart.enabled` | `true`（同梱パッチ） | 応答が無いときバイナリを起動する。volatile。スキーマ既定は false で、バンドルが有効化します。 |
| `autoStart.binaryPath` | `''` | バイナリの明示パス。空なら `$DSH_HOME/bin` → `~/.local/bin` → `PATH`。 |
| `autoStart.idleMinutes` | `60` | 検索が無いままこの分数が過ぎたら、起動したプロセスを停止（`0` で停止しない）。volatile。 |
| `autoStart.download` | `true` | バイナリが無ければ `$DSH_HOME/bin` へ取得（SHA-256 検証）。 |
| `autoStart.version` | `''` | 取得する版を固定（例 `0.20.1`）。空なら最新リリースに追従。 |
| `debug` | `false` | プロバイダの判断をログに出す。 |

## 任意: 文字コード対応のページ取得

内蔵の取得層は `Content-Type` ヘッダの `charset` しか見ません。JRA・自治体・古い企業サイトなどは
`text/html` に charset を付けず、HTML の `<meta charset="Shift_JIS">` でしか宣言しないため、
取得結果が置換文字（`�`）になります。`webFetch.enabled` をオンにすると、
**BOM → HTTP ヘッダ → `<meta>`** の順に判定して `TextDecoder` で復号するプロバイダを登録します
（サイズ上限と html/text の判定は内蔵版と同じ）。

```yaml
- id: dsh-rustxng
  config:
    webFetch:
      enabled: true
      autoSelect: true
- id: web
  config:
    searchProvider: rustxng
    fetchProvider: rustxng-http   # 行ごと置換されるので両方書く
```

RustXNG は使いません（素の HTTP 取得＋復号のみ）。不要ならオフのままで構いません。

> **`web` 行が公開されないホスト（DSH 0.2.0-rc.2）では `autoSelect` が効きません。**
> 0.2.0-rc.2 は volatile フィールドを持つ設定行しか API に出さないため、選択を書き込めません。
> 上のとおり profile patch に `searchProvider` と `fetchProvider` の両方を書いてください
> （カードのスイッチは有効・無効の制御として引き続き機能します）。この状態は
> `rustxng_status` が `Fetch provider: enabled, but the selection was not written (…)` と表示します。

## 初回だけ: まだ何も入っていない状態

本プラグインはバイナリを同梱せず、差し替えも既定オフです。そのため導入直後は次の応答になります
（仕様で、対処方法を明示しています）。

```
RustXNG could not be reached: fetch failed (connect ECONNREFUSED 127.0.0.1:8888)
Start it (for example `rustxng --port 8888`), or point the `baseUrl` setting at your instance.
```

**いちばん簡単:** 同梱バンドルでは「RustXNG を自動で起動する」が最初からオンです。初回の検索時に取得・起動します。次回起動時に
OS に合うリリースを取得（SHA-256 検証、約 22〜27 MB）して `$DSH_HOME/bin` に置き、起動し、
アイドル時間が過ぎれば停止します。他に何も入れる必要はありません。

**手動:** `npx dsh-rustxng-fetch` で同じ場所に取得し、自分で起動（launchd / systemd 等）。
その場合は自動起動をオフのままにしてください。

取得は GitHub の API に依存しません。「最新リリース」の問い合わせがレート制限でも
固定バージョンにフォールバックし、`autoStart.binaryPath` か `--version` を指定すれば
問い合わせ自体が不要です。

## 自動選択（autoSelect）について

`autoSelect` は `web.searchProvider = 'rustxng'` を自動で書きますが、**プラグインのマウント中は
書けません**。ローダーが `apply()` を自身のトランザクション内で実行しており、設定書き込みは
*"HMR transactions cannot be nested"* で拒否されるためです。0.3.0 では、書き込みが許される
文脈——ツール呼び出し（`rustxng_status` / `rustxng_search`）またはカードからの設定変更——で
再試行し、結果を `rustxng_status` に表示します。

それでも書けないホストでは、一度だけ手動で設定してください（以後は記憶されます）。

```yaml
- id: web
  config:
    searchProvider: rustxng
    fetchProvider: http
```

## 任意: プロセスの自動起動と自動終了

RustXNG をサービスとして常駐させたくない場合は、プラグインにプロセスを持たせられます。

```yaml
- id: dsh-rustxng
  config:
    autoStart:
      enabled: true
      binaryPath: /home/you/.dsh/bin/rustxng   # 空なら $DSH_HOME/bin, ~/.local/bin, PATH
      idleMinutes: 60                          # 0 = DSH がプラグインを解放するまで動かす
```

挙動:

- インスタンスが応答しないときだけ起動し、`/healthz` が返るまで待ってから使います。
  同時に複数から呼ばれても起動は 1 回だけ（ポート競合を防ぐ）。
- **このプラグインが起動したプロセスだけ**を停止します。systemd や手動起動のものは触りません。
- プラグインの解放時（DSH の正常終了）は即座に停止します。
- DSH が強制終了された場合はそのクリーンアップが走らないため、**アイドルタイマー**が
  後始末をします。検索が無いまま `idleMinutes` 経過で停止し、次の検索で自動的に再起動します。
  到達性の定期チェックは「使用」に数えません。
- `rustxng_status` に `Auto-start: on — managed (pid …), idle timeout 60 min (12 min idle)` と、
  `Selection: web.searchProvider: rustxng (this plugin), web.fetchProvider: http` が出ます。
- `rustxng_search` ツールも起動します（`web_search` を置き換えずツールだけ使う構成でも初回から動く）。
  `rustxng_status` は起動しません（報告のみ）。
- **取得される版**: 常に最新リリースです。`lib/install-binary.js` の `PINNED_VERSION` は
  GitHub API に届かないときだけ使う**オフライン用のフォールバック**で、意図的に少し古い
  安定版を指しています。版を固定したい場合は `autoStart.version` を指定してください。
- **停止の仕組み**: 3 段構えです。
  1. プラグイン解放時の disposer
  2. 正常終了時の `process.on('exit')`
  3. `SIGTERM` / `SIGINT` / `SIGHUP` のハンドラ — **シグナル終了では `exit` が発火しない**ため、
     子を停止してから既定動作（シグナル）で終了し直します。ただし他にハンドラがある場合は
     再送出せず、ホストの終了処理に委ねます。
  `SIGKILL` された場合はどれも走らないため、**アイドルタイマー**が後始末をします。
  デスクトップアプリや systemd の下では子が同じ cgroup に属し、これらより先に道連れで
  消えることがあります（結果は同じですが、素のシェルでは当てにしないでください）。

サービス管理と併用する場合は `idleMinutes: 0` にしてください（両者は独立です）。

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
| macOS arm64 / x64 | 検証済み: macOS 26.6.2 / M1 Max、DSH 0.2.1-rc.3（Electron デスクトップアプリ）。0.1.3 で ustxng_search が 6〜10 エンジン・約 3 秒で応答。0.2.1 で初回取得と自動起動に対応 |

検証手順・バイナリの置き場所・OS 毎の注意（PATH、サービス登録、WSL、musl）は
[docs/PLATFORMS.md](docs/PLATFORMS.md) にまとめています。

## うまくいかないとき

| 症状 | 対処 |
| :--- | :--- |
| `RustXNG is not answering at …` | インスタンスを起動するか、カードの接続先 URL を直す。`rustxng_status` に probe のエラーが出ます。 |
| 差し替えたのに DeepSeek の 401 が出る | プロバイダが選ばれていません。カードの 1 つ目のスイッチ、または公式の *Web search* ページの `web.searchProvider` を確認。0.2.0-rc.2 ではプラグインからこの値を書けないため、profile patch か `DSH_WEB_SEARCH_PROVIDER=rustxng` を使ってください。 |
| Plugins にカードが出ない | プラグイン行が有効か（Plugin Manager）、DSH のバージョンが `dsh.compatibility` を満たすかを確認。チェックアウト導入ではスキーマを Harness 側から解決します。`rustxng_status` の `Config schema:` 行が `loaded via …` か解決エラーかを示します（0.1.2 で `<prefix>/bin/dsh` のようなシンボリックリンクにも対応）。 |
| `rustxng_status` が実設定と違って `Replace web_search: no (default)` と出る | 0.1.2 で修正済み（live 値の比較漏れ）。旧版でも動作自体は正しく、表示だけの問題です。 |
| 日本語ページが `����` や `�N` になる | 取得先が `<meta>` でしか文字コードを宣言していません。`webFetch.enabled` をオンにするか（[任意: 文字コード対応のページ取得](#任意-文字コード対応のページ取得)）、`curl … \| iconv -f SHIFT_JIS -t UTF-8` で読んでください。 |
| DSH を閉じたのに rustxng が残る | `autoStart.idleMinutes`（既定 60 分）で自動停止します。すぐ止めたい場合は値を小さくするか、`rustxng_status` で managed かどうかを確認してください。`0` にすると停止しません。 |
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
lib/fetch-provider.js   任意の文字コード対応 fetch プロバイダ（BOM → ヘッダ → <meta>）
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
