import { HttpStatus } from '@api/routes/index.router';

export interface MetaErrorResponse {
  status: number;
  error: string;
  message: string;
  details: {
    whatsapp_error: string;
    whatsapp_code: string | number;
    error_user_title: string;
    error_user_msg: string;
    error_type: string;
    error_subcode: number | null;
    fbtrace_id: string | null;
    context: string;
    type: string;
  };
  timestamp: string;
}

/**
 * Creates standardized error response for Meta/WhatsApp API errors
 */
export function createMetaErrorResponse(error: any, context: string): MetaErrorResponse {
  // Extract Meta/WhatsApp specific error fields
  const unavailable = [HttpStatus.SERVICE_UNAVAILABLE, HttpStatus.GATEWAY_TIMEOUT].includes(error?.status);
  const metaError = error.template || error;
  const message = unavailable ? ([] as string[]).concat(error.message).join(' ') : metaError.message;
  const errorUserTitle = metaError.error_user_title || message || 'Unknown error';
  const errorUserMsg = metaError.error_user_msg || message || 'Unknown error';

  return {
    status: unavailable ? error.status : HttpStatus.BAD_REQUEST,
    error: unavailable ? error.error : 'Bad Request',
    message: errorUserTitle,
    details: {
      whatsapp_error: errorUserMsg,
      whatsapp_code: metaError.code || 'UNKNOWN_ERROR',
      error_user_title: errorUserTitle,
      error_user_msg: errorUserMsg,
      error_type: metaError.type || 'UNKNOWN',
      error_subcode: metaError.error_subcode || null,
      fbtrace_id: metaError.fbtrace_id || null,
      context,
      type: 'whatsapp_api_error',
    },
    timestamp: new Date().toISOString(),
  };
}
