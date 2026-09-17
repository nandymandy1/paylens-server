import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import type { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import type { RequestWithId } from '../middleware/request-id.middleware.js';
function isEnvelope(value: unknown): value is { success: boolean } {
  return typeof value === 'object' && value !== null && 'success' in value;
}
@Injectable()
export class ResponseEnvelopeInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<RequestWithId>();
    return next
      .handle()
      .pipe(
        map((body: unknown) =>
          isEnvelope(body)
            ? body
            : { success: true, requestId: request.requestId, data: body },
        ),
      );
  }
}
