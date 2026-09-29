export type SqlSandboxColumn = {
  dataTypeId: number;
  name: string;
};

export type SqlSandboxResult = {
  columns: SqlSandboxColumn[];
  command: string;
  executionTimeMs: number;
  rowCount: number;
  rows: Record<string, unknown>[];
  truncated: boolean;
};

export type SqlSandboxReseedResult = {
  durationMs: number;
  fingerprint: string;
  reseeded: true;
};
