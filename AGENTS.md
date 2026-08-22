# Repository agent instructions

- staging作業の開始時は[`docs/operations/staging-handoff.md`](docs/operations/staging-handoff.md)を読み、用途に合う`pnpm staging:preflight`を実行する。長い現在状態をプロンプトへ毎回転記しない。
- handoffはsnapshot、preflightはAWS read-onlyの実状態確認として扱う。preflightがFAILした場合はAWS writeへ進まない。
- preflightのPASSはAWS write承認ではない。AWS writeは対象工程ごとのユーザー明示承認を必要とする。
