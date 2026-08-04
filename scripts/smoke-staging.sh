#!/usr/bin/env bash
set -euo pipefail

: "${WEB_URL:?WEB_URL is required}"
: "${API_URL:?API_URL is required}"
: "${MIGRATION_VERIFIED:?MIGRATION_VERIFIED must be set by the deploy workflow}"

if [[ "$MIGRATION_VERIFIED" != "true" ]]; then
  echo 'FAIL: migration task success was not verified' >&2
  exit 1
fi
if [[ "${ALLOW_HTTP:-false}" != "true" ]]; then
  [[ "$WEB_URL" == https://* ]] || { echo 'FAIL: WEB_URL must use HTTPS' >&2; exit 1; }
  [[ "$API_URL" == https://* ]] || { echo 'FAIL: API_URL must use HTTPS' >&2; exit 1; }
fi

work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT

web_status="$(curl --silent --show-error --location --output /dev/null --write-out '%{http_code}' "$WEB_URL")"
[[ "$web_status" == 200 || "$web_status" == 3* ]] || {
  echo "FAIL: Web returned HTTP $web_status" >&2
  exit 1
}
echo 'PASS: Web responded'

curl --fail --silent --show-error --dump-header "$work_dir/health.headers" \
  --output "$work_dir/health.json" "$API_URL/health"
grep -q '"service":"oshi-schedule-api"' "$work_dir/health.json" || {
  echo 'FAIL: API health service identity is invalid' >&2
  exit 1
}
echo 'PASS: API liveness'

curl --fail --silent --show-error --output "$work_dir/ready.json" "$API_URL/ready"
grep -q '"status":"ready"' "$work_dir/ready.json" || {
  echo 'FAIL: API is not ready' >&2
  exit 1
}
echo 'PASS: API readiness'

curl --fail --silent --show-error --head "$WEB_URL" > "$work_dir/web.headers"
grep -Eiq '^x-content-type-options:[[:space:]]*nosniff' "$work_dir/web.headers" || {
  echo 'FAIL: Web x-content-type-options header is missing' >&2
  exit 1
}
grep -Eiq '^referrer-policy:' "$work_dir/web.headers" || {
  echo 'FAIL: Web referrer-policy header is missing' >&2
  exit 1
}
grep -Eiq '^x-content-type-options:[[:space:]]*nosniff' "$work_dir/health.headers" || {
  echo 'FAIL: API security headers are missing' >&2
  exit 1
}
echo 'PASS: security headers'

not_found_status="$(curl --silent --show-error --output "$work_dir/not-found.json" \
  --dump-header "$work_dir/not-found.headers" --write-out '%{http_code}' "$API_URL/__smoke-not-found")"
[[ "$not_found_status" == 404 ]] || { echo 'FAIL: API 404 contract changed' >&2; exit 1; }
grep -Eiq '^content-type:[[:space:]]*application/json' "$work_dir/not-found.headers" || {
  echo 'FAIL: API 404 is not JSON' >&2
  exit 1
}
echo 'PASS: JSON 404'

protected_status="$(curl --silent --show-error --output "$work_dir/protected.json" \
  --write-out '%{http_code}' "$API_URL/api/v1/me")"
[[ "$protected_status" == 401 ]] || { echo 'FAIL: unauthenticated route protection changed' >&2; exit 1; }
echo 'PASS: unauthenticated route protection'

if [[ -n "${ECS_CLUSTER:-}" || -n "${WORKER_TASK_DEFINITION:-}" ]]; then
  : "${AWS_REGION:?AWS_REGION is required for ECS verification}"
  : "${ECS_CLUSTER:?ECS_CLUSTER is required for ECS verification}"
  : "${WORKER_TASK_DEFINITION:?WORKER_TASK_DEFINITION is required for ECS verification}"
  aws ecs describe-clusters --region "$AWS_REGION" --clusters "$ECS_CLUSTER" \
    --query 'clusters[0].status' --output text | grep -qx ACTIVE
  aws ecs describe-task-definition --region "$AWS_REGION" \
    --task-definition "$WORKER_TASK_DEFINITION" --query 'taskDefinition.status' --output text | grep -qx ACTIVE
  echo 'PASS: worker task definition is registered'
fi

echo 'PASS: migration was applied by a successful one-off task'
echo 'Smoke test completed successfully'
