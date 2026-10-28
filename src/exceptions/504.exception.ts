import { HttpStatus } from '@api/routes/index.router';

export class GatewayTimeoutException {
  constructor(...objectError: any[]) {
    throw {
      status: HttpStatus.GATEWAY_TIMEOUT,
      error: 'Gateway Timeout',
      message: objectError.length > 0 ? objectError : undefined,
    };
  }
}
