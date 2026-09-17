import { BullModule } from "@nestjs/bullmq";
import { Global, Module } from "@nestjs/common";
import { EMAIL_QUEUE } from "./email.constants.js";
import { EmailProcessor } from "./email.processor.js";
import { EmailService } from "./email.service.js";

@Global()
@Module({
  imports: [BullModule.registerQueue({ name: EMAIL_QUEUE })],
  providers: [EmailService, EmailProcessor],
  exports: [EmailService],
})
export class EmailModule {}
