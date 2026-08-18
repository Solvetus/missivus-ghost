#!/usr/bin/env bash
# Missivus for Ghost — smoke run against the official ghost Docker image.
#
# Placeholder credentials only: the tenant does not exist, so Microsoft answers AADSTS90002 and
# the point of the test is that this failure lands LOUDLY in Ghost's own log through the shim.
# Never touches any live server. The one throwaway password below is local to a container that
# is destroyed at the end.
set -euo pipefail
cd "$(dirname "$0")/../.."

NET=missivus-smoke
GHOST=missivus-smoke-ghost
SHIM=missivus-smoke-shim
OWNER_EMAIL="owner@example.com"
OWNER_PASS="Missivus-Smoke-2026-throwaway"

cleanup() {
  docker rm -f "$GHOST" "$SHIM" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
}
cleanup
trap cleanup EXIT

docker network create "$NET" >/dev/null

echo "== starting the Missivus shim (node:22-alpine, repo mounted read-only)"
docker run -d --name "$SHIM" --network "$NET" \
  -v "$PWD":/app:ro -w /app \
  -e MISSIVUS_LISTEN_HOST=0.0.0.0 \
  -e MISSIVUS_LISTEN_PORT=2525 \
  -e mail__options__tenantId=missivus-placeholder-tenant \
  -e mail__options__clientId=00000000-0000-0000-0000-000000000000 \
  -e mail__options__clientSecret=placeholder-not-a-real-secret \
  -e mail__options__sender=noreply@example.com \
  node:22-alpine node packages/ghost/dist/cli.js >/dev/null

echo "== starting the official ghost image, transport configured via env vars only"
docker run -d --name "$GHOST" --network "$NET" -p 2368:2368 \
  -e NODE_ENV=development \
  -e url=http://localhost:2368 \
  -e security__staffDeviceVerification=false \
  -e mail__transport=SMTP \
  -e mail__from="Example Ltd <noreply@example.com>" \
  -e mail__options__host="$SHIM" \
  -e mail__options__port=2525 \
  -e mail__options__tenantId=missivus-placeholder-tenant \
  -e mail__options__clientId=00000000-0000-0000-0000-000000000000 \
  -e mail__options__clientSecret=placeholder-not-a-real-secret \
  -e mail__options__sender=noreply@example.com \
  ghost:latest >/dev/null

echo "== waiting for Ghost to come up"
for i in $(seq 1 60); do
  if curl -sf http://localhost:2368/ghost/api/admin/site/ >/dev/null 2>&1; then break; fi
  sleep 2
done
curl -sf http://localhost:2368/ghost/api/admin/site/ | head -c 200; echo

echo "== setting up the owner account (sends no email)"
curl -sS -X POST http://localhost:2368/ghost/api/admin/authentication/setup \
  -H 'Content-Type: application/json' -H 'Origin: http://localhost:2368' \
  -d "{\"setup\":[{\"name\":\"Smoke Owner\",\"email\":\"$OWNER_EMAIL\",\"password\":\"$OWNER_PASS\",\"blogTitle\":\"Missivus Smoke\"}]}" | head -c 200; echo

echo
echo "== 1) member magic link (members frontend API, with Ghost 6's integrity token)"
IT=$(curl -sS -X GET http://localhost:2368/members/api/integrity-token/ -H 'Origin: http://localhost:2368' -H 'app-pragma: no-cache')
curl -sS -X POST http://localhost:2368/members/api/send-magic-link/ \
  -H 'Content-Type: application/json' -H 'Origin: http://localhost:2368' \
  -d "{\"email\":\"member@example.com\",\"emailType\":\"signup\",\"integrityToken\":\"$IT\"}"; echo

echo
echo "== 2) admin-triggered password reset (admin API; Ghost 6 has no /mail/test route)"
curl -sS -X POST http://localhost:2368/ghost/api/admin/authentication/password_reset \
  -H 'Content-Type: application/json' -H 'Origin: http://localhost:2368' \
  -d "{\"password_reset\":[{\"email\":\"$OWNER_EMAIL\"}]}"; echo

echo
echo "== 3) staff invite (authenticated admin session)"
JAR=$(mktemp)
curl -sS -c "$JAR" -X POST http://localhost:2368/ghost/api/admin/session \
  -H 'Content-Type: application/json' -H 'Origin: http://localhost:2368' \
  -d "{\"username\":\"$OWNER_EMAIL\",\"password\":\"$OWNER_PASS\"}"; echo
ROLE_ID=$(curl -sS -b "$JAR" -H 'Origin: http://localhost:2368' http://localhost:2368/ghost/api/admin/roles/ \
  | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const r=JSON.parse(d).roles.find(r=>r.name==="Contributor");console.log(r.id)})')
echo "Contributor role: $ROLE_ID"
curl -sS -b "$JAR" -X POST http://localhost:2368/ghost/api/admin/invites/ \
  -H 'Content-Type: application/json' -H 'Origin: http://localhost:2368' \
  -d "{\"invites\":[{\"email\":\"invitee@example.com\",\"role_id\":\"$ROLE_ID\"}]}"; echo
rm -f "$JAR"

sleep 3
echo
echo "===================== GHOST LOG (mail lines) ====================="
docker logs "$GHOST" 2>&1 | grep -iE 'missivus|failed to send|email|AADSTS' | grep -v 'GET\|POST\|PUT' | tail -40
echo
echo "===================== SHIM LOG ====================="
docker logs "$SHIM" 2>&1 | tail -20
