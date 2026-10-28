import type { WaBusiness } from '@config/env.config';
import axios from 'axios';

export class OfficialError extends Error {}

export async function validateOfficialCredentials(config: WaBusiness, credentials: any) {
  const token = credentials?.token;
  const wabaId = String(credentials?.waba_id ?? '');
  const phoneNumberId = String(credentials?.phone_number_id ?? '');
  if (typeof token !== 'string' || !token || !/^\d+$/.test(wabaId) || !/^\d+$/.test(phoneNumberId)) {
    throw new OfficialError('Token, WABA ID e Phone Number ID são obrigatórios.');
  }
  if (!config.APP_ID || !config.APP_SECRET || !config.TOKEN_WEBHOOK || !config.VERSION) {
    throw new OfficialError('Configure App ID, App Secret, verify token e versão Graph na Evolution.');
  }
  const base = `${config.URL}/${config.VERSION}`;
  const debug = await axios.get(`${base}/debug_token`, {
    headers: { Authorization: `Bearer ${config.APP_ID}|${config.APP_SECRET}` },
    params: { input_token: token },
    timeout: 15000,
  });
  const details = debug.data.data;
  if (!details?.is_valid || String(details.app_id) !== config.APP_ID) {
    throw new OfficialError('O token precisa ser válido e pertencer ao aplicativo Meta configurado na Evolution.');
  }
  if (
    !['whatsapp_business_management', 'whatsapp_business_messaging'].every((scope) => details.scopes?.includes(scope))
  ) {
    throw new OfficialError('O token precisa das permissões de mensagens e gestão do WhatsApp.');
  }
  const headers = { Authorization: `Bearer ${token}` };
  let after: string;
  let selected: any;
  do {
    const response = await axios.get(`${base}/${wabaId}/phone_numbers`, {
      headers,
      params: { fields: 'id,display_phone_number,verified_name', limit: 100, after },
      timeout: 15000,
    });
    selected = response.data.data?.find((phone: any) => String(phone.id) === phoneNumberId);
    after = response.data.paging?.next ? response.data.paging?.cursors?.after : undefined;
  } while (!selected && after);
  if (!selected) throw new OfficialError('O número informado não pertence à WABA ou não está autorizado.');
  await axios.get(`${base}/${wabaId}/message_templates`, { headers, params: { limit: 1 }, timeout: 15000 });
  return selected;
}
