import { PrismaRepository } from '@api/repository/repository.service';
import type { WAMonitoringService } from '@api/services/monitor.service';
import type { WaBusiness } from '@config/env.config';
import { Logger } from '@config/logger.config';
import type { MetaApp } from '@prisma/client';
import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'crypto';

import { OfficialError } from './official-credentials';

export function encryptMetaSecret(value: string, key: string) {
  if (!/^[a-f0-9]{64}$/i.test(key || ''))
    throw new OfficialError('Configure a chave de criptografia Meta da Evolution.');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(key, 'hex'), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map((part) => part.toString('base64')).join('.');
}

export function decryptMetaSecret(value: string, key: string) {
  if (!/^[a-f0-9]{64}$/i.test(key || ''))
    throw new OfficialError('Configure a chave de criptografia Meta da Evolution.');
  const [iv, tag, encrypted] = value.split('.').map((part) => Buffer.from(part, 'base64'));
  const cipher = createDecipheriv('aes-256-gcm', Buffer.from(key, 'hex'), iv);
  cipher.setAuthTag(tag);
  return Buffer.concat([cipher.update(encrypted), cipher.final()]).toString('utf8');
}

export function equalMetaToken(actual: unknown, expected: string) {
  if (typeof actual !== 'string' || !expected) return false;
  const value = Buffer.from(actual);
  const token = Buffer.from(expected);
  return value.length === token.length && timingSafeEqual(value, token);
}

export class MetaAppService {
  private readonly logger = new Logger('MetaAppService');

  constructor(
    private readonly repository: PrismaRepository,
    private readonly config: WaBusiness,
    private readonly waMonitor: WAMonitoringService,
  ) {}

  async require(id: string) {
    if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id))
      throw new OfficialError('Selecione um aplicativo Meta válido.');
    const app = await this.repository.metaApp.findFirst({ where: { id, deletedAt: null } });
    if (!app) throw new OfficialError('Aplicativo Meta não encontrado na Evolution.');
    return app;
  }

  async publicApp(publicId: string) {
    return this.repository.metaApp.findFirst({ where: { publicId, deletedAt: null } });
  }

  credentials(app: MetaApp) {
    return {
      app_id: app.appId,
      app_secret: decryptMetaSecret(app.appSecret, this.config.ENCRYPTION_KEY),
      verify_token: this.verifyToken(app),
    };
  }

  verifyToken(app: MetaApp) {
    return decryptMetaSecret(app.verifyToken, this.config.ENCRYPTION_KEY);
  }

  status(app: MetaApp) {
    return { callback_verified_at: app.callbackVerifiedAt, last_event_at: app.lastEventAt };
  }

  async sync(id: string, data: any) {
    if (
      !/^[0-9a-f-]{36}$/i.test(id) ||
      !/^[0-9a-f-]{36}$/i.test(data.company_id || '') ||
      !/^\d{1,50}$/.test(data.app_id || '') ||
      !/^[\w-]{32,64}$/.test(data.public_id || '') ||
      typeof data.app_secret !== 'string' ||
      data.app_secret.length < 16 ||
      data.app_secret.length > 4096 ||
      typeof data.verify_token !== 'string' ||
      data.verify_token.length < 32 ||
      data.verify_token.length > 128
    ) {
      throw new OfficialError('Dados inválidos do aplicativo Meta.');
    }
    const { status, closed } = await this.repository.$transaction(async (transaction) => {
      const existing = await transaction.metaApp.findUnique({ where: { id } });
      if (
        existing &&
        (existing.companyId !== data.company_id ||
          existing.appId !== data.app_id ||
          existing.publicId !== data.public_id ||
          existing.deletedAt)
      ) {
        throw new OfficialError('O aplicativo Meta não pode ser transferido ou reativado.');
      }
      let old: ReturnType<MetaAppService['credentials']> | null = null;
      let unreadable = false;
      if (existing) {
        try {
          old = this.credentials(existing);
        } catch (error) {
          unreadable = true;
          this.logger.warn(
            `Meta app credentials unreadable, re-encrypting: app=${id} reason=${error?.code || error?.name}`,
          );
        }
      }
      const secretChanged = unreadable || (old && old.app_secret !== data.app_secret);
      const changed = secretChanged || (old && old.verify_token !== data.verify_token);
      const app = await transaction.metaApp.upsert({
        where: { id },
        create: {
          id,
          companyId: data.company_id,
          appId: data.app_id,
          activeAppId: data.app_id,
          publicId: data.public_id,
          appSecret: encryptMetaSecret(data.app_secret, this.config.ENCRYPTION_KEY),
          verifyToken: encryptMetaSecret(data.verify_token, this.config.ENCRYPTION_KEY),
        },
        update: {
          appSecret: encryptMetaSecret(data.app_secret, this.config.ENCRYPTION_KEY),
          verifyToken: encryptMetaSecret(data.verify_token, this.config.ENCRYPTION_KEY),
          ...(changed ? { callbackVerifiedAt: null } : {}),
          ...(secretChanged ? { lastEventAt: null } : {}),
        },
      });
      let closed: string[] = [];
      if (secretChanged) {
        const linked = await transaction.instance.findMany({ where: { metaAppId: id }, select: { name: true } });
        await transaction.instance.updateMany({ where: { metaAppId: id }, data: { connectionStatus: 'close' } });
        closed = linked.map((instance) => instance.name);
      }
      return { status: this.status(app), closed };
    });
    for (const name of closed) {
      const channel = this.waMonitor.waInstances[name];
      if (channel) channel.stateConnection = { state: 'close' };
    }
    return status;
  }

  async delete(id: string) {
    const app = await this.repository.metaApp.findUnique({ where: { id } });
    if (!app || app.deletedAt) return;
    const instance = await this.repository.instance.findFirst({ where: { metaAppId: id } });
    if (instance) throw new OfficialError('Remova os números vinculados antes de excluir o aplicativo Meta.');
    await this.repository.metaApp.update({ where: { id }, data: { deletedAt: new Date(), activeAppId: null } });
  }
}
