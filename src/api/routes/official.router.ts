import { OfficialError, validateOfficialCredentials } from '@api/integrations/channel/meta/official-credentials';
import { prismaRepository, waMonitor } from '@api/server.module';
import { Auth, configService, WaBusiness } from '@config/env.config';
import { Logger } from '@config/logger.config';
import { Instance } from '@prisma/client';
import axios from 'axios';
import { Request, Response, Router } from 'express';

export const officialRouter = Router();

const logger = new Logger('OfficialRouter');
const MAX_SAMPLE_BYTES = 16 * 1024 * 1024;

officialRouter.use((req, res, next) => {
  const key = configService.get<Auth>('AUTHENTICATION').API_KEY.KEY;
  if (!key || req.get('apikey') !== key) {
    return res.status(401).json({ message: 'Global service key required' });
  }
  next();
});

const graph = () => {
  const config = configService.get<WaBusiness>('WA_BUSINESS');
  return { config, base: `${config.URL}/${config.VERSION}` };
};

const fail = (res: Response, action: string, error: any, fallback: string) => {
  if (error instanceof OfficialError) return res.status(422).json({ message: error.message });
  const meta = axios.isAxiosError(error);
  logger.error(
    `Official ${action} failed: reason=${meta ? `meta_status=${error.response?.status}` : error?.code || error?.name}`,
  );
  if (meta) return res.status(422).json({ message: fallback });
  return res.status(500).json({ message: 'Falha interna na Evolution.' });
};

const withInstance =
  (action: string, fallback: string, handler: (instance: Instance, req: Request, res: Response) => Promise<unknown>) =>
  async (req: Request, res: Response) => {
    try {
      const instance = await prismaRepository.instance.findUnique({ where: { name: req.params.instanceName } });
      if (instance?.integration !== 'WHATSAPP-BUSINESS') {
        return res.status(404).json({ message: 'Conexão oficial não encontrada na Evolution.' });
      }
      await handler(instance, req, res);
    } catch (error) {
      fail(res, action, error, fallback);
    }
  };

const setState = async (instance: Instance, state: 'open' | 'close') => {
  await prismaRepository.instance.update({ where: { id: instance.id }, data: { connectionStatus: state } });
  const channel = waMonitor.waInstances[instance.name];
  if (channel) channel.stateConnection = { state };
};

officialRouter.post('/validate', async (req, res) => {
  try {
    const phone = await validateOfficialCredentials(graph().config, req.body);
    res.json({ valid: true, phone_number: phone.display_phone_number, verified_name: phone.verified_name });
  } catch (error) {
    fail(res, 'validate', error, 'A Meta recusou a validação das credenciais.');
  }
});

officialRouter.put(
  '/:instanceName/credentials',
  withInstance('credentials', 'A Meta recusou a atualização das credenciais.', async (instance, req, res) => {
    const phone = await validateOfficialCredentials(graph().config, {
      token: req.body.token,
      waba_id: instance.businessId,
      phone_number_id: instance.number,
    });
    await prismaRepository.instance.update({ where: { id: instance.id }, data: { token: req.body.token } });
    const channel = waMonitor.waInstances[instance.name];
    if (channel) channel.token = req.body.token;
    res.json({ valid: true, phone_number: phone.display_phone_number });
  }),
);

officialRouter.post(
  '/:instanceName/activate',
  withInstance('activate', 'A Meta recusou a assinatura dos eventos da WABA.', async (instance, _req, res) => {
    const conflict = await prismaRepository.instance.findFirst({
      where: {
        id: { not: instance.id },
        number: instance.number,
        integration: 'WHATSAPP-BUSINESS',
        connectionStatus: { not: 'close' },
      },
    });
    if (conflict) throw new OfficialError('Este Phone Number ID já está ativo em outra conexão da Evolution.');
    await axios.post(
      `${graph().base}/${instance.businessId}/subscribed_apps`,
      {},
      { headers: { Authorization: `Bearer ${instance.token}` }, timeout: 15000 },
    );
    await setState(instance, 'open');
    res.json({ activated: true });
  }),
);

officialRouter.post(
  '/:instanceName/deactivate',
  withInstance('deactivate', 'Não foi possível desativar a conexão oficial.', async (instance, _req, res) => {
    await setState(instance, 'close');
    res.json({ deactivated: true });
  }),
);

officialRouter.post(
  '/:instanceName/sample',
  withInstance('sample', 'A Meta recusou o upload da amostra.', async (instance, req, res) => {
    const { config, base } = graph();
    if (!config.APP_ID) throw new OfficialError('WA_BUSINESS_APP_ID não configurado.');
    const file = Buffer.from(String(req.body.base64 || ''), 'base64');
    if (!file.length || file.length > MAX_SAMPLE_BYTES) throw new OfficialError('Envie uma amostra de até 16 MB.');
    const upload = await axios.post(`${base}/${config.APP_ID}/uploads`, null, {
      headers: { Authorization: `Bearer ${instance.token}` },
      params: { file_length: file.length, file_type: req.body.mime_type, file_name: req.body.filename },
      timeout: 15000,
    });
    const response = await axios.post(`${base}/${upload.data.id}`, file, {
      headers: {
        Authorization: `OAuth ${instance.token}`,
        file_offset: '0',
        'Content-Type': 'application/octet-stream',
      },
      timeout: 40000,
    });
    if (!response.data?.h) throw new OfficialError('A Meta não devolveu o identificador da amostra.');
    res.json({ handle: response.data.h });
  }),
);
