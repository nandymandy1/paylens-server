import { ValidationPipe } from "@nestjs/common";
import { createValidationException } from "./validation-exception.js";

export const createGlobalValidationPipe = (): ValidationPipe =>
  new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    exceptionFactory: createValidationException,
  });
