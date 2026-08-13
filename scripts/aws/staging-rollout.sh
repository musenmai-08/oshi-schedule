#!/usr/bin/env bash
set -euo pipefail

phase="${1:-}"
if [[ "$phase" != "phase1" && "$phase" != "phase2" ]]; then
  echo 'Usage: staging-rollout.sh <phase1|phase2> <synth|diff|deploy> [CDK options]' >&2
  exit 2
fi
shift
if [[ "${1:-}" == "--" ]]; then
  shift
fi
command="${1:-}"
if [[ "$command" != "synth" && "$command" != "diff" && "$command" != "deploy" ]]; then
  echo 'Usage: staging-rollout.sh <phase1|phase2> <synth|diff|deploy> [CDK options]' >&2
  exit 2
fi
shift

for argument in "$@"; do
  case "$argument" in
    *apiDesiredCount*|*syncPipeDesiredState*|*applicationActivated*)
      echo 'Rollout safety contexts are owned by the selected phase preset.' >&2
      exit 2
      ;;
  esac
done

if [[ "$phase" == "phase1" ]]; then
  safety_context=(
    -c apiDesiredCount=0
    -c syncPipeDesiredState=STOPPED
    -c applicationActivated=false
  )
else
  safety_context=(
    -c apiDesiredCount=1
    -c syncPipeDesiredState=RUNNING
    -c applicationActivated=true
  )
fi

exec bash scripts/aws/with-project-node.sh \
  pnpm --filter @oshi-schedule/infra cdk "$command" "$@" "${safety_context[@]}"
