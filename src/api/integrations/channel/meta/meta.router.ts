import { RouterBroker } from '@api/abstract/abstract.router';
import { metaController } from '@api/server.module';
import { ConfigService, WaBusiness } from '@config/env.config';
import { Logger } from '@config/logger.config';
import { Router } from 'express';

import { verifyMetaSignature } from './meta-signature';

const logger = new Logger('MetaRouter');

export class MetaRouter extends RouterBroker {
  constructor(readonly configService: ConfigService) {
    super();
    this.router
      .get(this.routerPath('webhook/meta', false), async (req, res) => {
        const verifyToken = configService.get<WaBusiness>('WA_BUSINESS').TOKEN_WEBHOOK;
        if (
          verifyToken &&
          req.query['hub.mode'] === 'subscribe' &&
          req.query['hub.verify_token'] === verifyToken &&
          typeof req.query['hub.challenge'] === 'string'
        )
          res.type('text/plain').send(req.query['hub.challenge']);
        else res.status(403).send('Invalid verification token');
      })
      .post(this.routerPath('webhook/meta', false), async (req, res) => {
        const { body } = req;
        if (
          !verifyMetaSignature(
            configService.get<WaBusiness>('WA_BUSINESS').APP_SECRET,
            req.rawBody,
            req.get('x-hub-signature-256'),
          )
        ) {
          return res.status(401).json({ error: 'Invalid Meta signature' });
        }
        if (body?.object !== 'whatsapp_business_account' || !Array.isArray(body.entry)) {
          return res.status(200).json({ status: 'ignored' });
        }
        try {
          return res.status(200).json(await metaController.enqueueWebhook(body));
        } catch (error) {
          logger.error(`Meta webhook not persisted: reason=${error?.code || error?.name}`);
          return res.status(500).json({ error: 'Meta event not persisted' });
        }
      });
  }

  public readonly router: Router = Router();
}
