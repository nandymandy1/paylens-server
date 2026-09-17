import { Injectable } from "@nestjs/common";
import * as argon2 from "argon2";
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
} from "@/modules/auth/constants/auth.constants.js";

@Injectable()
export class PasswordService {
  assertPolicy(password: string): void {
    if (
      typeof password !== "string" ||
      password.length < PASSWORD_MIN_LENGTH ||
      password.length > PASSWORD_MAX_LENGTH
    ) {
      throw new Error(
        `Password must be between ${PASSWORD_MIN_LENGTH} and ${PASSWORD_MAX_LENGTH} characters`,
      );
    }
  }

  async hash(password: string): Promise<string> {
    this.assertPolicy(password);

    return argon2.hash(password, { type: argon2.argon2id });
  }

  async verify(passwordHash: string, password: string): Promise<boolean> {
    try {
      return await argon2.verify(passwordHash, password);
    } catch {
      return false;
    }
  }
}
