import type { PrismaRepository } from '@api/repository/repository.service';
import type { WAMonitoringService } from '@api/services/monitor.service';
import { Events } from '@api/types/wa.types';
import { Logger } from '@config/logger.config';
import { createJid } from '@utils/createJid';
import { createHash } from 'crypto';

const BATCH_SIZE = 25;
const LEASE_MS = 300000;
const MAX_ATTEMPTS = 288;

export class MetaController {
  private readonly logger = new Logger('MetaController');
  private workerStarted = false;
  private draining = false;

  constructor(
    public readonly prismaRepository: PrismaRepository,
    public readonly waMonitor: WAMonitoringService,
  ) {}

  public async enqueueWebhook(payload: any, metaAppId: string) {
    if (!metaAppId) throw new Error('Meta app required');
    const id = createHash('sha256')
      .update(metaAppId + ':' + JSON.stringify(payload))
      .digest('hex');
    await this.prismaRepository.metaWebhookInbox.upsert({
      where: { id },
      create: { id, payload, metaAppId },
      update: {},
    });
    return { status: 'success' };
  }

  public startWebhookWorker() {
    if (this.workerStarted) return;
    this.workerStarted = true;
    const timer = setInterval(() => void this.drainWebhookInbox(), 5000);
    timer.unref();
    void this.drainWebhookInbox();
  }

  public async drainWebhookInbox() {
    if (this.draining) return;
    this.draining = true;
    try {
      let rows: { id: string; payload: any; attempts: number; metaAppId: string }[];
      do {
        const now = new Date();
        rows = await this.prismaRepository.metaWebhookInbox.findMany({
          where: { completedAt: null, availableAt: { lte: now }, metaAppId: { not: null } },
          orderBy: { availableAt: 'asc' },
          take: BATCH_SIZE,
        });
        for (const row of rows) {
          const claimed = await this.prismaRepository.metaWebhookInbox.updateMany({
            where: { id: row.id, completedAt: null, availableAt: { lte: now } },
            data: { availableAt: new Date(Date.now() + LEASE_MS), attempts: { increment: 1 } },
          });
          if (!claimed.count) continue;
          try {
            await this.receiveWebhook(row.payload, row.metaAppId);
            await this.prismaRepository.metaWebhookInbox.update({
              where: { id: row.id },
              data: { completedAt: new Date() },
            });
          } catch (error) {
            const attempt = row.attempts + 1;
            const discarded = attempt >= MAX_ATTEMPTS;
            if (discarded) {
              await this.prismaRepository.metaWebhookInbox.update({
                where: { id: row.id },
                data: { completedAt: new Date() },
              });
            }
            this.logger.error(
              `Meta webhook processing failed: event=${row.id} attempt=${attempt} discarded=${discarded} reason=${String(error?.message ?? error).slice(0, 200)}`,
            );
          }
        }
      } while (rows.length === BATCH_SIZE);
      await this.prismaRepository.metaWebhookInbox.deleteMany({
        where: { completedAt: { lt: new Date(Date.now() - 7 * 86400000) } },
      });
    } catch (error) {
      this.logger.error(`Meta webhook worker unavailable: reason=${error?.code || error?.name}`);
    } finally {
      this.draining = false;
    }
  }

  public async receiveWebhook(data: any, metaAppId: string) {
    if (!metaAppId) throw new Error('Meta app required');
    if (data.object !== 'whatsapp_business_account') return;
    const app = await this.prismaRepository.metaApp.findFirst({ where: { id: metaAppId, deletedAt: null } });
    if (!app) return;
    for (const entry of data.entry || []) {
      const wabaId = String(entry.id);
      for (const change of entry.changes || []) {
        const value = change.value || {};
        if (change.field === 'message_template_status_update') {
          const instances = await this.prismaRepository.instance.findMany({
            where: {
              businessId: wabaId,
              metaAppId,
              integration: 'WHATSAPP-BUSINESS',
              connectionStatus: { not: 'close' },
            },
          });
          if (!instances.length)
            this.logger.info(`Meta event ignored: app=${metaAppId} field=template_status reason=unregistered_waba`);
          for (const instance of instances) {
            const channel = this.waMonitor.waInstances[instance.name];
            if (!channel) throw new Error('Official instance not loaded');
            await channel.sendDataWebhook(Events.MESSAGES_UPDATE, { template_status: value, waba_id: wabaId });
          }
          continue;
        }
        const numberId = value.metadata?.phone_number_id;
        if (!numberId) continue;
        const instances = await this.prismaRepository.instance.findMany({
          where: {
            metaAppId,
            number: String(numberId),
            businessId: wabaId,
            integration: 'WHATSAPP-BUSINESS',
            connectionStatus: { not: 'close' },
          },
        });
        if (instances.length !== 1) {
          if (!instances.length) this.logger.info(`Meta event ignored: app=${metaAppId} reason=unregistered_number`);
          if (instances.length > 1) {
            this.logger.error(`Meta event ignored: phone_number_id=${numberId} active_instances=${instances.length}`);
          }
          continue;
        }
        const [instance] = instances;
        const channel = this.waMonitor.waInstances[instance.name];
        if (!channel) throw new Error('Official instance not loaded');
        for (const message of value.messages || []) {
          const duplicate = await this.prismaRepository.message.findFirst({
            where: { instanceId: instance.id, key: { path: ['id'], equals: message.id } },
          });
          if (duplicate) continue;
          const contact = (value.contacts || []).find((item: any) => item.wa_id === message.from) || {
            wa_id: message.from,
            profile: { name: message.from },
          };
          const contacts = [{ ...contact, profile: { ...contact.profile, phone: createJid(String(message.from)) } }];
          const singleValue = { ...value, contacts, messages: [message], statuses: undefined };
          await channel.connectToWhatsapp({
            ...data,
            entry: [{ ...entry, changes: [{ ...change, value: singleValue }] }],
          });
        }
        for (const status of value.statuses || []) {
          await channel.sendDataWebhook(Events.MESSAGES_UPDATE, {
            keyId: status.id,
            status: status.status,
            remoteJid: `${status.recipient_id}@s.whatsapp.net`,
            timestamp: status.timestamp,
            errors: status.errors || [],
          });
        }
      }
    }
  }
}
