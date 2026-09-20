import { Readable } from "node:stream";
import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { FILE_STORAGE_MULTIPART_PART_SIZE } from "@/storage/file-storage.constants.js";
import type {
  SignedDownloadInput,
  SignedUploadInput,
  SignedUrlResult,
  StoredFile,
  StoredFileHead,
  UploadFileInput,
} from "@/storage/file-storage.types.js";

type S3CompatibleStorageConfig = {
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  region: string;
};

export class S3CompatibleStorageProvider {
  private readonly client: S3Client;

  constructor(private readonly config: S3CompatibleStorageConfig) {
    this.client = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      forcePathStyle: false,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    });
  }

  async upload(input: UploadFileInput): Promise<StoredFile> {
    const upload = new Upload({
      client: this.client,
      params: {
        Bucket: this.config.bucket,
        Key: input.key,
        Body: input.body,
        ContentType: input.contentType,
        ContentLength: input.contentLength,
        Metadata: input.metadata,
      },
      partSize: FILE_STORAGE_MULTIPART_PART_SIZE,
      queueSize: 4,
    });
    const result = await upload.done();

    return { key: input.key, etag: result.ETag };
  }

  async downloadStream(key: string): Promise<Readable> {
    const result = await this.client.send(
      new GetObjectCommand({ Bucket: this.config.bucket, Key: key }),
    );

    if (!result.Body || !(result.Body instanceof Readable))
      throw new Error("Storage object body is unavailable");

    return result.Body;
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.head(key);

      return true;
    } catch (error: unknown) {
      if (typeof error === "object" && error && "$metadata" in error) {
        const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata
          ?.httpStatusCode;

        if (status === 404) return false;
      }

      throw error;
    }
  }

  async head(key: string): Promise<StoredFileHead> {
    const result = await this.client.send(
      new HeadObjectCommand({ Bucket: this.config.bucket, Key: key }),
    );

    return { size: result.ContentLength ?? 0, contentType: result.ContentType, etag: result.ETag };
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.config.bucket, Key: key }));
  }

  async deleteMany(keys: string[]): Promise<void> {
    if (!keys.length) return;
    await this.client.send(
      new DeleteObjectsCommand({
        Bucket: this.config.bucket,
        Delete: { Objects: keys.map((Key) => ({ Key })) },
      }),
    );
  }

  async deletePrefix(prefix: string): Promise<void> {
    let continuationToken: string | undefined;

    do {
      const page = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.config.bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        }),
      );

      await this.deleteMany(
        page.Contents?.flatMap((object) => (object.Key ? [object.Key] : [])) ?? [],
      );
      continuationToken = page.NextContinuationToken;
    } while (continuationToken);
  }

  async createSignedUploadUrl(
    input: SignedUploadInput,
    expiresIn: number,
  ): Promise<SignedUrlResult> {
    const url = await getSignedUrl(
      this.client,
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: input.key,
        ContentType: input.contentType,
        ContentLength: input.contentLength,
        Metadata: input.metadata,
      }),
      { expiresIn },
    );

    return { url, expiresAt: new Date(Date.now() + expiresIn * 1_000) };
  }

  async createSignedDownloadUrl(
    input: string | SignedDownloadInput,
    expiresIn: number,
  ): Promise<SignedUrlResult> {
    const key = typeof input === "string" ? input : input.key;
    const contentDisposition = typeof input === "string" ? undefined : input.contentDisposition;
    const url = await getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
        ...(contentDisposition ? { ResponseContentDisposition: contentDisposition } : {}),
      }),
      { expiresIn },
    );

    return { url, expiresAt: new Date(Date.now() + expiresIn * 1_000) };
  }
}
