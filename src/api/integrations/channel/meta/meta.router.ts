import { RouterBroker } from '@api/abstract/abstract.router';
import { metaController, prismaRepository, waMonitor } from '@api/server.module';
import { ConfigService, WaBusiness } from '@config/env.config';
import { Logger } from '@config/logger.config';
import { Router } from 'express';

import { equalMetaToken, MetaAppService } from './meta-app.service';
import { verifyMetaSignature } from './meta-signature';

const logger = new Logger('MetaRouter');

export class MetaRouter extends RouterBroker {
  constructor(readonly configService: ConfigService) {
    super();
    const apps = new MetaAppService(prismaRepository, configService.get<WaBusiness>('WA_BUSINESS'), waMonitor);
    this.router.get(this.routerPath('webhook/meta/:publicId', false), async (req, res) => {
      try {
        const app = await apps.publicApp(req.params.publicId);
        if (!app) return res.sendStatus(404);
        if (
          req.query['hub.mode'] !== 'subscribe' ||
          typeof req.query['hub.challenge'] !== 'string' ||
          !equalMetaToken(req.query['hub.verify_token'], apps.verifyToken(app))
        ) {
          return res.sendStatus(403);
        }
        const verified = await prismaRepository.metaApp.updateMany({
          where: { id: app.id, deletedAt: null, verifyToken: app.verifyToken },
          data: { callbackVerifiedAt: new Date() },
        });
        if (!verified.count) return res.sendStatus(403);
        return res.type('text/plain').send(req.query['hub.challenge']);
      } catch (error) {
        logger.error(`Meta verification unavailable: reason=${error?.code || error?.name}`);
        return res.sendStatus(503);
      }
    });
    this.router.post(this.routerPath('webhook/meta/:publicId', false), async (req, res) => {
      try {
        const app = await apps.publicApp(req.params.publicId);
        if (!app) return res.sendStatus(404);
        if (!verifyMetaSignature(apps.credentials(app).app_secret, req.rawBody, req.get('x-hub-signature-256'))) {
          return res.status(401).json({ error: 'Invalid Meta signature' });
        }
        if (req.body?.object !== 'whatsapp_business_account' || !Array.isArray(req.body.entry)) {
          return res.status(200).json({ status: 'ignored' });
        }
        const result = await metaController.enqueueWebhook(req.body, app.id);
        await prismaRepository.metaApp.update({ where: { id: app.id }, data: { lastEventAt: new Date() } });
        return res.status(200).json(result);
      } catch (error) {
        logger.error(`Meta webhook not persisted: reason=${error?.code || error?.name}`);
        return res.status(500).json({ error: 'Meta event not persisted' });
      }
    });
  }

  public readonly router: Router = Router();
}
