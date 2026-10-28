import { equalMetaToken, MetaAppService } from '@api/integrations/channel/meta/meta-app.service';
import {
  metaUnavailableStatus,
  OfficialError,
  validateOfficialCredentials,
} from '@api/integrations/channel/meta/official-credentials';
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
  if (!key || !equalMetaToken(req.get('apikey'), key)) {
    return res.status(401).json({ message: 'Global service key required' });
  }
  next();
});

const graph = () => {
  const config = configService.get<WaBusiness>('WA_BUSINESS');
  return { config, base: `${config.URL}/${config.VERSION}` };
};

let appService: MetaAppService;
const apps = () => (appService ??= new MetaAppService(prismaRepository, graph().config, waMonitor));

const fail = (res: Response, action: string, error: any, fallback: string) => {
  if (error instanceof OfficialError) return res.status(422).json({ message: error.message });
  const meta = axios.isAxiosError(error);
  const status = error?.response?.status;
  const code = error?.response?.data?.error?.code;
  const reason = meta ? `meta_status=${status} meta_code=${code} network=${error.code}` : error?.code || error?.name;
  logger.error(`Official ${action} failed: reason=${reason}`);
  if (metaUnavailableStatus(error)) {
    return res.status(503).json({
      message: 'A Meta está indisponível no momento. Tente novamente em alguns minutos.',
    });
  }
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

const setState = async (
  instance: Instance,
  state: 'open' | 'close',
  data: { metaAppId?: string; token?: string } = {},
) => {
  await prismaRepository.instance.update({ where: { id: instance.id }, data: { ...data, connectionStatus: state } });
  const channel = waMonitor.waInstances[instance.name];
  if (!channel) return;
  if (data.token) channel.token = data.token;
  channel.stateConnection = { state };
};

officialRouter.put('/apps/:appId', async (req, res) => {
  try {
    res.json(await apps().sync(req.params.appId, req.body));
  } catch (error) {
    fail(res, 'app_sync', error, 'Não foi possível sincronizar o aplicativo Meta.');
  }
});

officialRouter.get('/apps/:appId', async (req, res) => {
  try {
    const service = apps();
    res.json(service.status(await service.require(req.params.appId)));
  } catch (error) {
    fail(res, 'app_status', error, 'Não foi possível consultar o aplicativo Meta.');
  }
});

officialRouter.delete('/apps/:appId', async (req, res) => {
  try {
    await apps().delete(req.params.appId);
    res.json({ deleted: true });
  } catch (error) {
    fail(res, 'app_delete', error, 'Não foi possível excluir o aplicativo Meta.');
  }
});

officialRouter.post('/validate', async (req, res) => {
  try {
    const phone = await validateOfficialCredentials(
      graph().config,
      req.body,
      apps().credentials(await apps().require(req.body.meta_app_id)),
    );
    res.json({ valid: true, phone_number: phone.display_phone_number, verified_name: phone.verified_name });
  } catch (error) {
    fail(res, 'validate', error, 'A Meta recusou a validação das credenciais.');
  }
});

officialRouter.post(
  '/:instanceName/activate',
  withInstance('activate', 'A Meta recusou a assinatura dos eventos da WABA.', async (instance, req, res) => {
    if (instance.metaAppId && req.body.meta_app_id && req.body.meta_app_id !== instance.metaAppId)
      throw new OfficialError('O aplicativo da conexão não pode ser alterado.');
    const appId = instance.metaAppId || req.body.meta_app_id;
    const app = await apps().require(appId);
    const conflictApp = await prismaRepository.instance.findFirst({
      where: {
        id: { not: instance.id },
        businessId: instance.businessId,
        integration: 'WHATSAPP-BUSINESS',
        metaAppId: { not: appId },
      },
    });
    if (conflictApp) throw new OfficialError('Esta WABA já está vinculada a outro aplicativo.');
    const token = req.body.token ?? instance.token;
    await validateOfficialCredentials(
      graph().config,
      { token, waba_id: instance.businessId, phone_number_id: instance.number },
      apps().credentials(app),
    );
    const conflict = await prismaRepository.instance.findFirst({
      where: {
        id: { not: instance.id },
        number: instance.number,
        integration: 'WHATSAPP-BUSINESS',
        metaAppId: { not: null },
        connectionStatus: { not: 'close' },
      },
    });
    if (conflict) throw new OfficialError('Este Phone Number ID já está ativo em outra conexão da Evolution.');
    await axios.post(
      `${graph().base}/${instance.businessId}/subscribed_apps`,
      {},
      { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 },
    );
    await setState(instance, 'open', { metaAppId: app.id, token });
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
    const { base } = graph();
    const app = await apps().require(instance.metaAppId);
    const file = Buffer.from(String(req.body.base64 || ''), 'base64');
    if (!file.length || file.length > MAX_SAMPLE_BYTES) throw new OfficialError('Envie uma amostra de até 16 MB.');
    const upload = await axios.post(`${base}/${app.appId}/uploads`, null, {
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
