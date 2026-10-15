#!/usr/bin/env sh
set -eu

VERSION="${VERSION:-latest}"
PROTECT="${PROTECT:-true}"
RULES="${RULES:-false}"

case "$VERSION" in
  ''|*[!A-Za-z0-9._-]*) echo "[nofly] version must be an npm dist-tag or an exact version, got: ${VERSION}" >&2; exit 1 ;;
esac
for value in "$PROTECT" "$RULES"; do
  case "$value" in
    true|false) ;;
    *) echo "[nofly] protect and rules must be true or false, got: ${value}" >&2; exit 1 ;;
  esac
done

if ! command -v node >/dev/null 2>&1; then
  echo "[nofly] Node is not present in this image. Add the Node feature (or a Node base image) before this one." >&2
  echo "[nofly]   \"ghcr.io/devcontainers/features/node:1\": {}" >&2
  exit 1
fi

echo "[nofly] installing @nofly/agent@${VERSION}"
npm install -g "@nofly/agent@${VERSION}"

mkdir -p /usr/local/share/nofly
cat > /usr/local/share/nofly/post-create.sh <<POSTCREATE
#!/usr/bin/env sh
set -u

echo "[nofly] \$(nofly --version 2>/dev/null || echo 'not on PATH')"

if [ "${PROTECT}" = "true" ]; then
  nofly protect || echo "[nofly] protect failed (non-fatal) - run 'nofly protect' by hand"
fi

if [ "${RULES}" = "true" ]; then
  nofly rules --write || echo "[nofly] rules --write failed (non-fatal)"
fi

nofly doctor || true
POSTCREATE
chmod +x /usr/local/share/nofly/post-create.sh

echo "[nofly] installed; protect=${PROTECT} rules=${RULES}"
