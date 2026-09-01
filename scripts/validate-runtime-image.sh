#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" == '--' ]]; then
  shift
fi

image="${1:-}"
if [[ -z "$image" ]]; then
  echo 'Usage: validate-runtime-image.sh <image>' >&2
  exit 2
fi

runtime_user="$(docker image inspect --format '{{.Config.User}}' "$image")"
platform="$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$image")"
entrypoint="$(docker image inspect --format '{{json .Config.Entrypoint}}' "$image")"
default_command="$(docker image inspect --format '{{json .Config.Cmd}}' "$image")"

[[ "$runtime_user" == 'node' ]] || {
  echo "Runtime image user must be node, got: ${runtime_user:-unset}" >&2
  exit 1
}
[[ "$platform" == 'linux/amd64' ]] || {
  echo "Runtime image platform must be linux/amd64, got: $platform" >&2
  exit 1
}
[[ "$entrypoint" == '["/opt/oshi-schedule/entrypoint.sh"]' ]] || {
  echo "Unexpected runtime entrypoint: $entrypoint" >&2
  exit 1
}
[[ "$default_command" == '["node","api/dist/server.js"]' ]] || {
  echo "Unexpected API runtime command: $default_command" >&2
  exit 1
}

docker run --rm --platform linux/amd64 --entrypoint /bin/sh "$image" -eu -c '
  fail() { echo "$1" >&2; exit 1; }
  test "$(id -u)" = 1000 || fail "Runtime UID must be 1000"
  test "$(id -un)" = node || fail "Runtime process must run as node"
  test -x /opt/oshi-schedule/api/node_modules/.bin/prisma
  test -f /opt/oshi-schedule/prisma/schema.prisma
  find /opt/oshi-schedule/api/node_modules -name "libquery_engine-rhel-openssl-3.0.x.so.node" -print -quit | grep -q . \
    || fail "Lambda Prisma engine is missing"
  ! find /opt/oshi-schedule/api/node_modules -name "*darwin*" -print -quit | grep -q . \
    || fail "macOS Prisma engine must not be packaged in runtime image"
  cd /opt/oshi-schedule/api
  node -e '\''
    const { Prisma, PrismaClient } = require("@prisma/client");
    if (!Prisma.dmmf?.datamodel?.models?.length)
      throw new Error("Generated Prisma Client data model is missing");
    const client = new PrismaClient();
    client.$disconnect().catch((error) => {
      console.error(error);
      process.exit(1);
    });
  '\''
  node --input-type=module -e '\''
    const { PrismaStore } = await import("./dist/infrastructure/database/prisma-store.js");
    const store = new PrismaStore();
    await store.disconnect();
  '\''
  cd /opt/oshi-schedule/worker
  NODE_ENV=development APP_MODE=fake node --input-type=module -e '\''
    const { createRuntime } = await import("@oshi-schedule/api/runtime");
    const runtime = createRuntime();
    await runtime.disconnect();
  '\''
  cd /opt/oshi-schedule
  /opt/oshi-schedule/api/node_modules/.bin/prisma migrate deploy \
    --schema=/opt/oshi-schedule/prisma/schema.prisma --help >/dev/null
  test -f /opt/oshi-schedule/api/dist/server.js
  test -f /opt/oshi-schedule/worker/dist/index.js
  for tool in npm npx pnpm pnpx yarn yarnpkg corepack; do
    ! command -v "$tool" >/dev/null 2>&1
  done
'

node_version="$(docker run --rm --platform linux/amd64 --entrypoint node "$image" --version)"
[[ "$node_version" == 'v22.23.1' ]] || {
  echo "Runtime Node.js must be v22.23.1, got: $node_version" >&2
  exit 1
}

echo "Runtime image contract validated: platform=$platform, user=$runtime_user, node=$node_version, Prisma=generated/importable/constructable/rhel-engine"
