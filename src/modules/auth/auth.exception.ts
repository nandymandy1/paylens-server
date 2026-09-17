import { HttpException, HttpStatus } from "@nestjs/common";

export class AuthException extends HttpException {
  readonly code: string;

  constructor(code: string, message: string, status: HttpStatus = HttpStatus.BAD_REQUEST) {
    super({ code, message }, status);
    this.code = code;
  }
}
