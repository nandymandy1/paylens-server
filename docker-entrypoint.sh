#!/bin/sh
set -eu

echo "Applying Prisma migrations..."
./node_modules/.bin/prisma migrate deploy

# Opt-in reviewer demo bootstrap (narrow create-once seed; never the SEED-R1 dataset).
if [ "${SEED_REVIEWER_DEMO:-false}" = "true" ]; then
  echo "Provisioning reviewer demo account..."
  npm run seed:reviewer-demo:prod
fi

exec "$@"
