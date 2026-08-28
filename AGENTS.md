# Repository agent instructions

## Context and scope

- [`docs/operations/staging-handoff.md`](docs/operations/staging-handoff.md)を現在状態の第一参照先とし、記録済みの完了調査を繰り返さない。長い現在状態をプロンプトへ毎回転記しない。
- 中断後は`git status`、`git diff`、handoffから未完了部分を特定し、既存変更を保持して続きから再開する。
- 通常タスクは依頼に直接関係するファイルと経路へ調査・変更を絞り、repo全体監査や無差別な全体検索をデフォルトで行わない。

## Verification

- テストは関連テストを優先する。全テストやfull buildは、高リスク変更、関連範囲を限定できない変更、またはユーザーの明示指示がある場合だけ実行する。
- CIを最終ゲートとし、同じ検証をローカルで過剰に反復しない。

## AWS safety

- AWS確認は`pnpm staging:preflight`と`pnpm staging:status`を優先する。handoffはsnapshot、これらはAWS read-onlyの実状態確認として扱い、FAIL時はAWS writeへ進まない。
- preflightのPASSはAWS write承認ではない。AWS writeは対象工程ごとのユーザー明示承認を必要とする。

## Reporting

- 終了報告は結果、検証、commit/CI、外部write、残件を中心に5〜7項目へ圧縮する。
