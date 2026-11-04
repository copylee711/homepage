#!/bin/sh
# Build the agent-platform images one at a time (runner -> sandbox -> egress ->
# gateway) from an unpacked source tree, then restart the Compose services.
# Builds run serially on purpose: parallel builds have been OOM-killed on xa.
#
#   REVISION=<40-char sha> sh agent-platform/scripts/deploy-images.sh
#
# Environment (all optional except REVISION):
#   APT_MIRROR, APT_FORCE_IPV4  apt tweaks for Dockerfile.runner/.sandbox; read
#                               from agent-platform/.env when not set (xa: mirrors.aliyun.com / 1)
#   GATEWAY_WEB=build|prebuilt  build: Dockerfile.gateway builds web/ in Docker (default)
#                               prebuilt: Dockerfile.gateway.prebuilt reuses agent-platform/web/dist;
#                               requires .deployed-web-revision to equal REVISION
#   IRIS_PRIVATE_SKILLS_DIR  trusted host directory with docx/pdf/pptx/xlsx skills
#   SANDBOX_PIP_INDEX_URL  optional index URL for hash-verified wheels
#   DEPLOY_UP=1|0               0 only builds and tags; no restart, no markers
#   DRY_RUN=1                   print the commands without running them
#
# Images get :latest and :main-<short sha>; the previous :latest is kept as
# :pre-<short sha> for rollback. Never touches data/, .env or secrets.
set -eu

APP=$(cd "$(dirname "$0")/.." && pwd)
ROOT=$(dirname "$APP")
cd "$APP"

REVISION=${REVISION:-${1:-}}
case "$REVISION" in
  *[!0-9a-f]*|'') echo "REVISION must be the full 40-char commit sha" >&2; exit 2 ;;
esac
[ ${#REVISION} -eq 40 ] || { echo "REVISION must be the full 40-char commit sha" >&2; exit 2; }
SHORT=$(printf %s "$REVISION" | cut -c1-7)

env_value() { # read one non-secret key from .env without sourcing the file
  [ -f .env ] || return 0
  sed -n "s/^$1=//p" .env | tail -n 1 | tr -d '"'"'"'\r'
}
APT_MIRROR=${APT_MIRROR-$(env_value APT_MIRROR)}
APT_FORCE_IPV4=${APT_FORCE_IPV4-$(env_value APT_FORCE_IPV4)}
APT_FORCE_IPV4=${APT_FORCE_IPV4:-0}
GATEWAY_WEB=${GATEWAY_WEB:-build}
DEPLOY_UP=${DEPLOY_UP:-1}
DRY_RUN=${DRY_RUN:-0}

run() {
  echo "+ $*"
  [ "$DRY_RUN" = 1 ] || "$@"
}

case "$GATEWAY_WEB" in
  build) ;;
  prebuilt)
    [ -f web/dist/index.html ] || { echo "GATEWAY_WEB=prebuilt needs web/dist" >&2; exit 2; }
    [ "$(cat .deployed-web-revision 2>/dev/null)" = "$REVISION" ] || {
      echo "web/dist is not marked as built from $REVISION (.deployed-web-revision)" >&2; exit 2; }
    ;;
  *) echo "GATEWAY_WEB must be build or prebuilt" >&2; exit 2 ;;
esac

echo "revision $REVISION  apt_mirror=${APT_MIRROR:-<debian.org>}  force_ipv4=$APT_FORCE_IPV4  gateway_web=$GATEWAY_WEB"

for name in runner sandbox egress gateway; do
  if docker image inspect "copylee-agent-$name:latest" >/dev/null 2>&1; then
    run docker tag "copylee-agent-$name:latest" "copylee-agent-$name:pre-$SHORT"
  fi
done

build() { # build <name> <dockerfile> <context> [extra args...]
  name=$1 file=$2 context=$3; shift 3
  run docker build -f "$file" "$@" \
    -t "copylee-agent-$name:latest" -t "copylee-agent-$name:main-$SHORT" "$context"
}

APT_ARGS="--build-arg APT_MIRROR=$APT_MIRROR --build-arg APT_FORCE_IPV4=$APT_FORCE_IPV4"
# shellcheck disable=SC2086 # APT_ARGS holds separate words; values contain no spaces
build runner "$ROOT/agent-platform/Dockerfile.runner" "$ROOT" $APT_ARGS
# sandbox and egress are FROM copylee-agent-runner:latest, so they must follow it.
# shellcheck disable=SC2086
build sandbox "$ROOT/agent-platform/Dockerfile.sandbox" "$ROOT" $APT_ARGS --build-arg "PIP_INDEX_URL=${SANDBOX_PIP_INDEX_URL:-https://pypi.org/simple}"
build egress "$ROOT/agent-platform/Dockerfile.egress" "$ROOT"

if [ "$GATEWAY_WEB" = prebuilt ]; then
  ctx=$(mktemp -d)
  trap 'rm -rf "$ctx"' EXIT
  mkdir -p "$ctx/agent-platform/web"
  cp gateway.mjs shared.mjs widget-document.mjs cloud-turns.mjs turn-stream.mjs prompt-input.mjs \
    "$ctx/agent-platform/"
  cp -R web/dist "$ctx/agent-platform/web/dist"
  build gateway "$APP/Dockerfile.gateway.prebuilt" "$ctx"
else
  build gateway "$ROOT/agent-platform/Dockerfile.gateway" "$ROOT"
fi

private_skills=${IRIS_PRIVATE_SKILLS_DIR:-/opt/copylee-agent-private/skills}
if [ -d "$private_skills" ]; then
  for skill in docx pdf pptx xlsx; do
    [ -f "$private_skills/$skill/SKILL.md" ] || { echo "Missing private skill: $skill" >&2; exit 1; }
  done
  for name in runner sandbox; do
    printf 'FROM copylee-agent-%s:main-%s\nCOPY --chmod=0555 docx /opt/iris-skills/docx\nCOPY --chmod=0555 pdf /opt/iris-skills/pdf\nCOPY --chmod=0555 pptx /opt/iris-skills/pptx\nCOPY --chmod=0555 xlsx /opt/iris-skills/xlsx\n' "$name" "$SHORT" |
      run docker build -f - -t "copylee-agent-$name:latest" -t "copylee-agent-$name:main-$SHORT" "$private_skills"
  done
fi

[ "$DEPLOY_UP" = 1 ] || { echo "built :main-$SHORT; DEPLOY_UP=0, not restarting"; exit 0; }

run docker compose up -d --no-build egress runner gateway
if [ "$DRY_RUN" != 1 ]; then
  printf '%s\n' "$REVISION" > .deployed-revision
  printf '%s\n' "$REVISION" > RELEASE
  [ "$GATEWAY_WEB" = prebuilt ] || printf '%s\n' "$REVISION" > .deployed-web-revision
fi
run docker compose ps
echo "deployed $REVISION; roll back with: docker tag copylee-agent-<name>:pre-$SHORT copylee-agent-<name>:latest && docker compose up -d --no-build"
