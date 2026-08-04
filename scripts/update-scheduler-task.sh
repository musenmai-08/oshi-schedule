#!/usr/bin/env bash
set -euo pipefail

: "${AWS_REGION:?AWS_REGION is required}"
schedule_name="${1:?schedule name is required}"
task_definition_arn="${2:?task definition ARN is required}"

work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT

aws scheduler get-schedule --region "$AWS_REGION" --name "$schedule_name" > "$work_dir/current.json"
jq --arg task "$task_definition_arn" '
  .Target.EcsParameters.TaskDefinitionArn = $task
  | {
      Name,
      Description,
      ScheduleExpression,
      ScheduleExpressionTimezone,
      FlexibleTimeWindow,
      Target,
      State,
      StartDate,
      EndDate,
      KmsKeyArn,
      GroupName
    }
  | with_entries(select(.value != null))
' "$work_dir/current.json" > "$work_dir/update.json"

aws scheduler update-schedule --region "$AWS_REGION" --cli-input-json "file://$work_dir/update.json" >/dev/null
