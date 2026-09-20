import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { FILE_STORAGE_SIGNED_URL_TTL_SECONDS } from "@/storage/file-storage.constants.js";
import { S3CompatibleStorageProvider } from "@/storage/providers/s3-compatible-storage.provider.js";
import type {
  SignedDownloadInput,
  SignedUploadInput,
  SignedUrlResult,
  StoredFile,
  StoredFileHead,
  UploadFileInput,
} from "@/storage/file-storage.types.js";

@Injectable()
export class FileStorageService {
  private readonly provider: S3CompatibleStorageProvider;

  constructor(config: ConfigService) {
    this.provider = new S3CompatibleStorageProvider({
      bucket: config.getOrThrow<string>("app.fileStorageBucket"),
      region: config.getOrThrow<string>("app.fileStorageRegion"),
      endpoint: config.getOrThrow<string>("app.fileStorageEndpoint"),
      accessKeyId: config.getOrThrow<string>("app.fileStorageAccessKeyId"),
      secretAccessKey: config.getOrThrow<string>("app.fileStorageSecretAccessKey"),
    });
  }

  upload(input: UploadFileInput): Promise<StoredFile> {
    return this.provider.upload(input);
  }

  downloadStream(key: string) {
    return this.provider.downloadStream(key);
  }

  exists(key: string): Promise<boolean> {
    return this.provider.exists(key);
  }

  head(key: string): Promise<StoredFileHead> {
    return this.provider.head(key);
  }

  delete(key: string): Promise<void> {
    return this.provider.delete(key);
  }

  deleteMany(keys: string[]): Promise<void> {
    return this.provider.deleteMany(keys);
  }

  deletePrefix(prefix: string): Promise<void> {
    return this.provider.deletePrefix(prefix);
  }

  createSignedUploadUrl(input: SignedUploadInput): Promise<SignedUrlResult> {
    return this.provider.createSignedUploadUrl(input, FILE_STORAGE_SIGNED_URL_TTL_SECONDS);
  }

  createSignedDownloadUrl(input: string | SignedDownloadInput): Promise<SignedUrlResult> {
    return this.provider.createSignedDownloadUrl(input, FILE_STORAGE_SIGNED_URL_TTL_SECONDS);
  }
}
