export type Environment = 'development' | 'test' | 'production';
export type ValidatedEnvironment = {
  NODE_ENV: Environment;
  PORT: number;
  DATABASE_URL: string;
  REDIS_URL: string;
  CORS_ORIGINS: string;
};
const environments = new Set<Environment>([
  'development',
  'test',
  'production',
]);

function requireUrl(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value)
    throw new Error(`${name} is required`);
  try {
    new URL(value);
  } catch {
    throw new Error(`${name} must be a valid URL`);
  }
  return value;
}

export function validateEnvironment(
  raw: Record<string, unknown>,
): ValidatedEnvironment {
  const nodeEnv = raw.NODE_ENV ?? 'development';
  if (typeof nodeEnv !== 'string' || !environments.has(nodeEnv as Environment))
    throw new Error('NODE_ENV must be development, test, or production');
  const port = Number(raw.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65_535)
    throw new Error('PORT must be an integer between 1 and 65535');
  const corsOrigins = raw.CORS_ORIGINS;
  if (
    typeof corsOrigins !== 'string' ||
    corsOrigins.split(',').some((origin) => !origin.trim())
  )
    throw new Error('CORS_ORIGINS must be a comma-separated origin allowlist');
  return {
    NODE_ENV: nodeEnv as Environment,
    PORT: port,
    DATABASE_URL: requireUrl(raw.DATABASE_URL, 'DATABASE_URL'),
    REDIS_URL: requireUrl(raw.REDIS_URL, 'REDIS_URL'),
    CORS_ORIGINS: corsOrigins,
  };
}
