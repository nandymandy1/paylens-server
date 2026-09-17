import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from "@nestjs/common";
import type { Observable } from "rxjs";
import { map } from "rxjs/operators";
import type { RequestWithId } from "@/common/middleware/request-id.middleware.js";

@Injectable()
export class ResponseEnvelopeInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<RequestWithId>();

    return next.handle().pipe(
      map((body: unknown) => ({
        success: true,
        requestId: request.requestId,
        data: body,
      })),
    );
  }
}
