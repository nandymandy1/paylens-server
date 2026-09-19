# PayLens backend

The backend is an independent NestJS deployment. It listens on port `4000`; `/health` is liveness and `/ready` is dependency readiness.

## Production image

Backend configuration is runtime-injected. Do not copy `.env` files or pass secrets as Docker build arguments.

```bash
docker build -t paylens-server .

docker run --rm -p 4000:4000 \
  -e NODE_ENV=production \
  -e DATABASE_URL=postgresql://... \
  -e REDIS_URL=redis://... \
  -e FRONTEND_URL=https://app.paylens.example \
  -e AUTH_ACCESS_TOKEN_SECRET=replace-with-a-strong-secret \
  -e AUTH_COOKIE_SAME_SITE=lax \
  -e LOG_LEVEL=info \
  -e SMTP_URL=smtp://... \
  -e EMAIL_FROM='PayLens <noreply@paylens.example>' \
  paylens-server
```

Run migrations as an explicit deployment job before rolling out API replicas:

```bash
docker build --target migrate -t paylens-server-migrate .
docker run --rm --env-file /safe/runtime.env paylens-server-migrate
```

The default API image never migrates or seeds at startup. PostgreSQL and Redis are external services; no database or cache containers are bundled. The runtime runs as unprivileged `node`, retains Prisma's generated client/engine, and preserves the OpenTelemetry Node loader.
