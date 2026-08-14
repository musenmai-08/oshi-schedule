#!/usr/bin/env bash
set -euo pipefail

exec bash scripts/aws/with-project-node.sh node scripts/aws/staging-rollout.mjs "$@"
