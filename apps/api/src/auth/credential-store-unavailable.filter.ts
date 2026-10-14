import { ArgumentsHost, Catch, ExceptionFilter } from '@nestjs/common';
import type { Response } from 'express';
import {
  CREDENTIAL_STORE_RETRY_AFTER_SECONDS,
  CredentialStoreUnavailableException,
} from './credential-store-error';

/** Answers a credential-store outage with 503, its named body and Retry-After. */
@Catch(CredentialStoreUnavailableException)
export class CredentialStoreUnavailableFilter implements ExceptionFilter {
  catch(exception: CredentialStoreUnavailableException, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<Response>();
    response.setHeader(
      'Retry-After',
      String(CREDENTIAL_STORE_RETRY_AFTER_SECONDS),
    );
    response.status(exception.getStatus()).json(exception.getResponse());
  }
}
