import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  OnModuleDestroy,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Pool } from "pg";
import { PinoLogger } from "nestjs-pino";
import type {
  SqlSandboxColumn,
  SqlSandboxReseedResult,
  SqlSandboxResult,
} from "@/modules/sql-sandbox/types/sql-sandbox.types.js";
import {
  formatPostgresError,
  toSingleResult,
  type SandboxRawResult,
} from "@/modules/sql-sandbox/utils/sql-sandbox.utils.js";

const execFileAsync = promisify(execFile);

const MAX_ROWS = 2000;

const RESEED_TIMEOUT_MS = 10 * 60 * 1000;

const roundToTwoDecimals = (value: number): number => Math.round(value * 100) / 100;

/**
 * Local-only unrestricted SQL executor. Runs statements directly through the
 * PostgreSQL driver (bypassing Prisma) so learners see native command,
 * fields, rows, counts, and errors. Never enable outside local development:
 * the database is disposable and destructive SQL is intentionally allowed.
 */
@Injectable()
export class SqlSandboxService implements OnModuleDestroy {
  private readonly pool: Pool;

  constructor(
    private readonly config: ConfigService,
    private readonly logger: PinoLogger,
  ) {
    this.pool = new Pool({
      connectionString: config.getOrThrow<string>("app.databaseUrl"),
      idleTimeoutMillis: 30_000,
      max: 2,
    });

    this.pool.on("error", (error) => {
      this.logger.error(
        { err: error},
        "SQL sandbox pool error"
      );
    });

    this.logger.setContext(SqlSandboxService.name);
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end().catch(() => undefined);
  }

  async execute(rawQuery: string): Promise<SqlSandboxResult> {
    this.assertLocalOnly();

    const query = rawQuery.trim();

    if (!query) {
      throw new BadRequestException({
        code: "SQL_SANDBOX_EMPTY_QUERY",
        message: "Provide a SQL statement to execute.",
      });
    }

    const startedAt = performance.now();

    let result: SandboxRawResult;

    try {
      // Multi-statement input resolves with one result per statement; the
      // final statement's result is what the sandbox reports.
      result = toSingleResult(await this.pool.query(query));
    } catch (error) {
      throw new BadRequestException({
        code: "SQL_SANDBOX_ERROR",
        message: formatPostgresError(error, query),
      });
    }

    const rows = result.rows ?? [];
    const truncated = rows.length > MAX_ROWS;
    const columns: SqlSandboxColumn[] = (result.fields ?? []).map((field) => ({
      dataTypeId: field.dataTypeID,
      name: field.name,
    }));

    return {
      columns,
      command: result.command,
      executionTimeMs: roundToTwoDecimals(performance.now() - startedAt),
      // Utility statements (EXPLAIN, SHOW, ...) return rows with a null row
      // count, so fall back to the returned row length.
      rowCount: result.rowCount ?? rows.length,
      rows: truncated ? rows.slice(0, MAX_ROWS) : rows,
      truncated,
    };
  }

  /**
   * Restores the disposable database through the canonical seed pathway.
   * `migrate deploy` runs first so the seed can recover even after
   * destructive sandbox SQL (e.g. DROP TABLE). Slow by design: reseeding
   * ~30k employees takes minutes, and the frontend uses a long timeout.
   */
  async reseed(): Promise<SqlSandboxReseedResult> {
    this.assertLocalOnly();

    const startedAt = performance.now();

    try {
      await execFileAsync("npx", ["prisma", "migrate", "deploy"], {
        cwd: process.cwd(),
        timeout: RESEED_TIMEOUT_MS,
      });
      const { runSeed } = await import("@/seed/runner.js");
      const { fingerprint } = await runSeed();

      return {
        durationMs: roundToTwoDecimals(performance.now() - startedAt),
        fingerprint,
        reseeded: true,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      this.logger.error({ err: error }, "SQL sandbox reseed failed");
      // 400 (not 500): the global exception filter strips 5xx messages, and
      // this local-only endpoint exists to show actionable diagnostics.
      throw new BadRequestException({
        code: "SQL_SANDBOX_RESEED_FAILED",
        message: `Reseed failed: ${message}`,
      });
    }
  }

  private assertLocalOnly(): void {
    if (this.config.getOrThrow<string>("app.environment") === "production") {
      throw new ForbiddenException({
        code: "SQL_SANDBOX_DISABLED",
        message: "The SQL sandbox is disabled in production.",
      });
    }
  }
}
