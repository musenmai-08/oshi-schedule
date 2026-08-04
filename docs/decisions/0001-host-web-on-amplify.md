# ADR 0001: WebをAWS Amplify Hostingへ配置する

## Status

Accepted — 2026-08-04

## Context

WebはNext.js 15 App Router、SSR、middleware、server-side `/auth/callback`、CSPを使うためstatic hostingだけでは動かない。個人開発ではWeb server containerの運用を減らし、staging/productionを低い変動費で分離したい。

## Decision

環境ごとに独立したAWS Amplify Hosting appを使う。Node.js 22でbuildし、公開可能な`NEXT_PUBLIC_*`だけを環境別に渡す。独自domain、HTTPS、SSRをAmplifyで提供する。

## Alternatives

- Vercel: Next.js適合性は最高だが、commercial利用時のPro seat固定費とAWSとの運用分散を避ける。
- ECS Fargate/App Runner: 現行Webには専用container/serviceを運用する利点が小さい。
- static export: middleware、SSR、callback routeを失うため不可。

## Consequences

Web用serverのpatch/scaleを管理しなくてよい。Amplifyが非対応とするEdge API route、streaming、on-demand ISRは使用しない。SecretはWeb buildに渡せず、公開設定だけに限定する。対応機能が増えた時は事前検証が必要になる。

## Revisit conditions

Amplifyで現行Next.js versionがsupportされない、必要機能が非対応、Web月額がVercel Proまたはcontainerより20%以上高い、build/deploy reliabilityがbeta SLOを満たさない場合。
