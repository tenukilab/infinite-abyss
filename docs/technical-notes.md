# 技術設計・セーブ・検証（v0.20）

> この文書は開発者／Codex向け。ソースの真実はルート `index.html`。変更時に差分を確認して更新する。

## 1. 実行アーキテクチャ

- **[実装済]** フロントエンドのみ。依存サービス・ビルド手順なし。**`index.html` 1ファイルにHTML/CSS/JavaScript** を実装。
- GitHub Pagesで公開： https://tenukilab.github.io/infinite-abyss/
- 主な対象端末：iPhone Safari。ブラウザの `localStorage` にセーブ（端末とブラウザに依存）。
- サーバーやユーザー認証は**未実装**。ブラウザ別・端末別のセーブは自動共有されない。JSONのエクスポート／インポートは利用可能。
- アプリ本体以外の別ゲーム（例：昔のFFA復元プロジェクト）とコード・仕様を混同しない。

## 2. ソース内の主な境界

| 構成 | 関数・定数 | 用途 |
| --- | --- | --- |
| 各種マスターデータ | `jobs` / `levelGrowth` / `skills` / `jobRequirements` | ジョブ・成長・条件 |
| 装備・魔法 | `shopCatalog` / `MAGIC_CATALOG` / `masteryTechnique` / `powerValues` | 装備、熟練、効果 |
| ダンジョン | `floors` / `FOREST_BOSSES` / `ISEKAI_BOSSES` / `PEELUNA_BOSS` | 敵データ |
| 戦闘 | `fightOne()` | 3ダンジョン共通の戦闘ループ |
| 図鑑 | `CODEX_MONSTERS` / `normalizeCodex()` / `markCodexBattle()` / `codexHTML()` | 56種のID、旧セーブの復元、戦績累積、図鑑表示 |
| 経験値 | `gainExperience()` | 総合Lv・現ジョブLv・永久能力値加算 |
| 自動周回 | `startAutoRun()` / `runAutoStep()` / `finishAutoRun()` | 逐次戦闘・停止条件 |
| 手動戦闘 | `run()` | 指定回数の戦闘／記録 |
| データ初期化 | `createState()` / `makeForest()` / `makeIsekai()` | 初期セーブ |
| 移行・読み込み | `upgradeState()` / `valid()` / `readState()` | 旧セーブ互換性 |
| 書き込み | `save()` | `localStorage` 保存 |
| 画面 | `render()` / `renderHero()` 等 | 現在の画面を再構築 |
| 開発時の確認 | `window.ABYSS_DEBUG` | テスト用の各種公開メソッド |

## 3. セーブ構造

- 現行セーブキー：**`infinite-abyss-save-v5`**、`VERSION=5`。画面のプロトタイプ版数（v0.18）とは別。
- 主なフィールド：
  - キャラ：`activeJob`、`level`、`xp`、`baseStats`、`hpGrowth`、`hp`。
  - 職業：`jobProgress`（ジョブIDごとのLvとEXP）、`loadouts`（互換目的で保持）。
  - 装備：`inventory`、`equipped`（6スロット）、`ore`。
  - 魔法：`magics`、`equippedMagic`、魔法器ごとの `spellIds` / `containerId`。
  - 通貨：`gold`、`medals`。
  - 通常迷宮：`floor`、`unlocked`、`kills`、`bossDefeated`。
  - 魔の森：`forest.floor`、`forest.unlocked`、`forest.kills`、`forest.bossesDefeated`、`forest.battleRecords`。
  - 異世界：`isekai.wins`、`losses`、`retreats`、`encounters`、`magicDrops`、`battleRecords`、`pendingBossId`。
  - 共通：`history`、`battleCount`、`rng`、`nextId`、`location`。
  - 自動周回：`autoRunProgress`（最後の進捗スナップショット）、`lastAutoRun`（停止結果）。
- `upgradeState` はフィールド不足・旧セーブを補完し、状態変更を伴うため、移行前データのコピーでテストすること。
- 既存ID：下級魔法使い **`mage`** と上級魔術師 **`sorcerer`**、下級弓使い **`archer`** と上級アーチャー **`elite_archer`** を混同しない。

### v0.20 図鑑の移行

- 旧セーブに `codex` がなければ、魔の森・異世界の直近30戦と通常迷宮の残存ログから**特定可能な戦績だけ**復元する。
- `state.kills` の階層別合計を敵種別に推測配分しない。旧セーブ以前の戦績は完全に復元できない。
- 旧セーブで所持していた魔法は発見済み。ドロップ数は記録が残る分だけ復元。
- `codex.schema=1` を持つセーブを毎回再集計しない（二重カウント防止）。`isekai.pendingBossId` は未戦闘でも遭遇済み。
- 詳細は [図鑑仕様書](encyclopedia.md) を参照。

**図鑑のセーブ：** `state.codex={schema:1,monsters:{},magics:{}}` を既存の `infinite-abyss-save-v5` に追加。モンスターごとの遭遇・戦績・ドロップ数、魔法ごとの発見状況と累計ドロップ/購入数を永続保存。

## 4. 旧セーブの扱い

**最重要：既存の総合Lv・能力値・職業EXP・装備・熟練・魔法・ダンジョン進行を消さない。**

- セーブキーは今もv5。外観のv0.18と無関係に勝手に変えない。
- 新ジョブの追加時は不足する `jobProgress` を**Lv1/EXP0**で追加し、既存のジョブを上書きしない。
- ジョブ変更時に `baseStats` を再計算しない。装備のジョブ切替も行わない。
- 開発用贈呈装備（レーヴァテイン・玄武の鎧・オーラの結晶）とウォールは、**特定の古いセーブからの移行時**に一度付与する処理。新規セーブや既存ユーザー全員への一律配布に変更しない。
- 魔の森の記録は直近30、異世界の記録も直近30。各ターンログが大きくなるため保存容量の検証を継続。
- JSONインポートには上書き確認がある。新形式の開発時にも安全なまま保持。

## 5. 自動周回のライフサイクル

- ランタイムの `autoSession` はブラウザ内の一時状態。**保存されるのは戦闘の成果と進捗スナップショット**。
- 戦闘エンジン `fightOne` をそのまま使用し、**1戦終わるごとにセーブ**してから次の処理へ進む。一定戦闘数で画面の統計だけ更新。
- ページ非表示や閉じた際は停止。再読み込み時は `upgradeState` で保存中のrunning状態を停止結果へ変換。**自動再開しない**。
- 停止条件：手動、HP割合、MASTER到達、戦闘数到達、敗北、150ターン撤退、異世界の任意のぴーるな遭遇停止。
- `isekai.pendingBossId` はぴーるな遭遇停止で保持し、次の手動挑戦に再利用。再抽選しない。
- 通常迷宮のボスは再戦不可。魔の森のボスは再戦可能。異世界は毎戦1体を再抽選。
- 自動宿屋・自動転職・オフライン経過時間による報酬計算は**未実装**。

## v0.19 状態異常の実装境界

- 耐性アクセサリーはアイテム個別の `resist` に効果ごとの**0〜1の確率**を格納。新しい共有商品は `STATUS_RESIST_ITEMS` → `accessoryShopCatalog`、従来13職×5商品と結合。
- `effectResistance()` を敵の状態異常発動後に判定。**魔の森50階の麻痺も同じキー `paralysis`** を使う。
- `fightOne()` のキュアは状態異常発動後・プレイヤー攻撃前に既存状態を解除。リレイズは戦闘中1回だけ有効で猫パンチは例外。
- 魔法定義 `MAGIC_CATALOG` は現在6種のspell＋2種のvessel。異世界ドロップは**勝利時1%を維持し、6魔法の均等抽選**。
- 全効果と対象ボスは[特殊効果管理表](status-effects.md)に保存。新効果追加時は**コードと表を同時更新**。

## 6. 回帰テストの最低ライン

次の変更時には、可能な限り**Node構文検査 + Playwright/Chromium（iPhone幅）**で確認すること。

| 分野 | 回帰テスト |
| --- | --- |
| セーブ | 既存v0.18セーブを読込→再保存→再読込で、装備・ジョブ・6能力値・魔法・ダンジョン進行が一致 |
| 転職 | 戦士↔上級職などでもHP・装備・永続能力値不変。MASTER条件の2職AND判定 |
| 熟練 | 熟練2000のレーヴァテイン攻撃22,000、玄武防御4,500、オーラの結晶で技15%→45% |
| 魔法 | 太陽石の複数独立抽選、1ターン1発、ウォール最大HP×3、残799以下の店回復不可 |
| 戦闘 | 150ターン撤退EXP70%・G0・死亡なし、HP0なら敗北処理 |
| 状態異常 | 装備耐性の成功・失敗、原初王と異世界の麻痺、毒/出血の事後解除、魔法封印下のキュア不可 |
| リレイズ | 毒・直接HP攻撃・致死通常攻撃で1回だけ復活、2回目は敗北、ねこパンチは例外 |
| 異世界 | 通常25体が均等、猫0.01%、命中0.001%、ねこパンチ0.05%、魔法ドロップ1% |
| 自動周回 | 1,000戦完走、手動停止、時間切れ停止、HP停止、MASTER停止、ぴーるな遭遇保持、リロード停止 |
| UI | iPhoneの画面幅で操作でき、ターン記録を開閉できる |
| 図鑑 | 56種の未知表示と発見数、6魔法、異世界遭遇停止、通常/自動戦闘の戦績加算、再読込時の二重加算防止 |

このリポジトリに自動テストスクリプトは現状コミットされていない。READMEのテスト実績は過去の確認記録であり、**すべての変更について継続的にCIテストが自動実行されているわけではない**。将来の優先改善候補。

## 7. リリース手順

1. 旧セーブを壊さない変更を優先して `index.html` を修正。
2. 対象の `docs/*.md` とリリース `README.md` を更新。曖昧な数値は「暫定」と明記。
3. JavaScript構文、操作、各種レグレッションを確認。
4. GitHub `main` にコミットし、Pagesの最新デプロイ状態を確認。
5. 既存セーブと互換性が必要な変更は、JSON書き出し／読み込みの両方を試す。
