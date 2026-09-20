import type { Readable } from "node:stream";

export type UploadFileInput = {
  key: string;
  body: Readable | Buffer | Uint8Array;
  contentType: string;
  contentLength?: number;
  metadata?: Record<string, string>;
};

export type StoredFile = { key: string; size?: number; etag?: string };

export type StoredFileHead = { size: number; contentType?: string; etag?: string };

export type SignedUrlResult = { url: string; expiresAt: Date };

export type SignedDownloadInput = {
  key: string;
  /**
   * Generic passthrough (e.g. attachment filename for transfer downloads).
   * The storage facade never invents business filenames itself.
   */
  contentDisposition?: string;
};

export type SignedUploadInput = {
  key: string;
  contentType: string;
  contentLength?: number;
  metadata?: Record<string, string>;
};
