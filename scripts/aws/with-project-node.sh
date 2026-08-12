#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
project_root="$(cd "${script_dir}/../.." && pwd)"
expected_version="$(tr -d '[:space:]' < "${project_root}/.nvmrc")"

if [[ ! "${expected_version}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo 'Invalid Node.js version in .nvmrc' >&2
  exit 1
fi

node_candidates=()
if [[ -n "${NVM_DIR:-}" ]]; then
  node_candidates+=("${NVM_DIR}/versions/node/v${expected_version}/bin/node")
fi
if [[ -n "${HOME:-}" ]]; then
  node_candidates+=("${HOME}/.nvm/versions/node/v${expected_version}/bin/node")
fi
if current_node="$(command -v node 2>/dev/null)"; then
  node_candidates+=("${current_node}")
fi

project_node=''
for candidate in "${node_candidates[@]}"; do
  if [[ -x "${candidate}" ]] && [[ "$("${candidate}" -p 'process.versions.node' 2>/dev/null || true)" == "${expected_version}" ]]; then
    project_node="${candidate}"
    break
  fi
done

if [[ -z "${project_node}" ]]; then
  echo "Node.js ${expected_version} is required; install it with nvm before running AWS commands" >&2
  exit 1
fi

export PATH="$(dirname "${project_node}"):${PATH}"
if [[ "$(node -p 'process.versions.node')" != "${expected_version}" ]]; then
  echo "Failed to select Node.js ${expected_version}" >&2
  exit 1
fi
if [[ "$#" -eq 0 ]]; then
  echo 'Usage: with-project-node.sh <command> [args...]' >&2
  exit 2
fi

exec "$@"
