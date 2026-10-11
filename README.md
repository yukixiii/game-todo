# Game ToDo

原神・鳴潮のイベント／任務／日課・週課を Obsidian で管理するプラグイン。
前提任務・締切・1日のプレイ時間から優先順位と完了予定を計算し、期限切れで実行できなくなったタスクを削除できます。

## インストール

### 開発する PC

```sh
npm install
npm run build   # または npm run dev（watch）
```

ビルドのたびに、この PC の Obsidian に登録された Vault のうち `.obsidian/plugins/game-todo/` フォルダがあるものへ
`main.js` / `manifest.json` / `styles.css` だけをコピーします（`data.json` は上書きしません）。
使いたい Vault にはそのフォルダを一度作ってください。`OBSIDIAN_VAULTS`（Windows は `;` 区切り）で明示指定もできます。

### 他の PC（BRAT）

```sh
npm version patch   # package.json / manifest.json / versions.json を更新してタグ作成（v なし）
git push --follow-tags
```

タグの push で `.github/workflows/release.yml` がテスト・ビルドし、GitHub Release に3ファイルを添付します。
各 Vault では BRAT プラグインにリポジトリを登録してインストール・更新します。

## タスクノート

1タスク = 1ノート。frontmatter に `gtodo: task` があるノートをどこからでも読み込みます。

```yaml
---
gtodo: task
game: genshin            # genshin | wuwa
kind: event              # event | quest | daily | weekly | periodic | other
start: 2026-10-15T11:00+09:00     # 任意。これより前には予定しない
deadline: 2026-11-04T04:59+09:00  # 任意。日付のみ (2026-11-04) は当日 23:59:59
estimate: 90             # 分。空欄なら Inbox（スケジュール対象外）
remaining: 30            # 任意。残り分（estimate より優先）
prereqs:
  - "[[魔神任務 第五章 第三幕]]"
status: todo             # todo | doing | done
---
```

## 繰り返しテンプレート

```yaml
---
gtodo: recurring
game: genshin
rule: weekly             # daily / weekly / weekly:thu / monthly:16 / interval:28@2026-09-01
estimate: 30
---
```

起動時と1時間ごとに、現在の期間のインスタンスを `GameTodo/Tasks/<ゲーム>/<テンプレ名> <期間開始日>.md` に作成します。
リセット時刻・UTC オフセット・週リセット曜日は設定でゲームごとに変更できます（既定: UTC+8, 4時, 月曜）。
期限切れの未完了インスタンスは自動でゴミ箱へ移動します（設定でオフ可）。

## 優先順位の計算

1. 前提任務の締切を逆算（`前提の実効締切 = min(自分の締切, 後続の実効締切 − 後続の所要時間)`）
2. 毎日の「プレイ開始時刻 + 平日/休日の分数」の枠に、実効締切が早い順で割り当て（開始前のイベントは待つ・途中で切り替え可）
3. 完了予定・余裕（slack）を計算し、締切に間に合わないものを赤で表示

両ゲームは同じプレイ時間を共有するものとして計算します（ビューのフィルタは表示のみ）。

## 状態

| 状態 | 意味 | 表示タブ |
|---|---|---|
| active | 予定可能 | 次の枠 / 優先度順 |
| inbox | 所要時間が未設定 | Inbox（その場で分数を入力可） |
| cycle | 前提が循環 | Inbox |
| expired | 期限切れ | 期限切れ（削除可） |
| unreachable | 前提が期限切れ等で実行不能 | 期限切れ（削除可） |
| done | 完了 | 優先度順の「完了」 |

## イベント取り込み

- 原神: HoYoverse のゲーム内お知らせ API（非公式、`getAnnList`）の「イベント」グループ。除外キーワード（既定: 祈願, チャージ, アンケート）で絞り込み。
- 鳴潮など: 設定の JSON フィード URL（`[{"id","title","start","end","url"}]` または `{"events":[...]}`）。

取り込んだイベントは `GameTodo/Inbox/` に作成され、所要時間を入れるとスケジュール対象になります。
同じ `source` のノートは重複作成せず、期限が変わっていれば更新します。

## 開発

```sh
npm test       # vitest（スケジューラ・繰り返し・取り込みパーサ・モックVaultでの統合テスト）
npm run dev    # watch ビルド
```
