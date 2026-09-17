import { createParamDecorator, type ExecutionContext } from "@nestjs/common";
import type { RequestPrincipal } from "@/modules/auth/types/auth.types.js";

export const CurrentPrincipal = createParamDecorator(
  (_data: unknown, context: ExecutionContext): RequestPrincipal => {
    const request = context.switchToHttp().getRequest<{ principal: RequestPrincipal }>();

    return request.principal;
  },
);
