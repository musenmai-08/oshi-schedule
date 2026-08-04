#!/usr/bin/env bash
set -euo pipefail

: "${AWS_REGION:?AWS_REGION is required}"
family="${1:?task definition family is required}"
image="${2:?image URI with digest is required}"

[[ "$image" == *@sha256:* ]] || { echo 'image must be pinned by sha256 digest' >&2; exit 2; }

work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT

aws ecs describe-task-definition --region "$AWS_REGION" --task-definition "$family" \
  --query taskDefinition --output json > "$work_dir/current.json"
jq --arg image "$image" '
  del(
    .compatibilities,
    .deregisteredAt,
    .registeredAt,
    .registeredBy,
    .requiresAttributes,
    .revision,
    .status,
    .taskDefinitionArn
  )
  | .containerDefinitions |= map(.image = $image)
' "$work_dir/current.json" > "$work_dir/next.json"

aws ecs register-task-definition --region "$AWS_REGION" \
  --cli-input-json "file://$work_dir/next.json" \
  --query 'taskDefinition.taskDefinitionArn' --output text
