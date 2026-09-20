import { Global, Module } from "@nestjs/common";
import { FileStorageService } from "@/storage/file-storage.service.js";

@Global()
@Module({ providers: [FileStorageService], exports: [FileStorageService] })
export class FileStorageModule {}
