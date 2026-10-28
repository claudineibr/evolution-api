import { InstanceDto } from '@api/dto/instance.dto';
import { TemplateDto } from '@api/dto/template.dto';
import { metaUnavailableStatus } from '@api/integrations/channel/meta/official-credentials';
import { PrismaRepository } from '@api/repository/repository.service';
import { ConfigService, WaBusiness } from '@config/env.config';
import { Logger } from '@config/logger.config';
import { GatewayTimeoutException, ServiceUnavailableException } from '@exceptions';
import axios from 'axios';

import { WAMonitoringService } from './monitor.service';

export class TemplateService {
  constructor(
    private readonly waMonitor: WAMonitoringService,
    public readonly prismaRepository: PrismaRepository,
    private readonly configService: ConfigService,
  ) {}

  private readonly logger = new Logger('TemplateService');

  public async find(instance: InstanceDto) {
    const getInstance = await this.waMonitor.waInstances[instance.instanceName].instance;

    if (!getInstance) {
      throw new Error('Instance not found');
    }

    const credentials = { businessId: getInstance.businessId, token: getInstance.token };

    const response = await this.requestTemplate(credentials, {}, 'GET');

    if (!response || response.error) this.throwMetaError(response, 'Error to find templates');

    return response.data;
  }

  public async create(instance: InstanceDto, data: TemplateDto) {
    try {
      const getInstance = await this.waMonitor.waInstances[instance.instanceName].instance;

      if (!getInstance) {
        throw new Error('Instance not found');
      }

      const credentials = { businessId: getInstance.businessId, token: getInstance.token };

      const postData = {
        name: data.name,
        category: data.category,
        allow_category_change: data.allowCategoryChange,
        language: data.language,
        components: data.components,
      };

      const response = await this.requestTemplate(credentials, postData, 'POST');

      if (!response || response.error) this.throwMetaError(response, 'Error to create template');

      const template = await this.prismaRepository.template.create({
        data: {
          templateId: response.id,
          name: data.name,
          template: response,
          webhookUrl: data.webhookUrl,
          instanceId: getInstance.id,
        },
      });

      return template;
    } catch (error) {
      this.logger.error('Error in create template: ' + error);
      // Propagate the real error instead of "engolindo" it
      throw error;
    }
  }

  public async edit(
    instance: InstanceDto,
    data: { templateId: string; category?: string; components?: any; allowCategoryChange?: boolean; ttl?: number },
  ) {
    const getInstance = await this.waMonitor.waInstances[instance.instanceName].instance;
    if (!getInstance) {
      throw new Error('Instance not found');
    }

    const credentials = { businessId: getInstance.businessId, token: getInstance.token };

    const payload: Record<string, unknown> = {};
    const templates = await this.find(instance);
    if (!Array.isArray(templates) || !templates.some((template: any) => String(template.id) === data.templateId)) {
      throw new Error('Template does not belong to this WhatsApp account');
    }
    if (typeof data.category === 'string') payload.category = data.category;
    if (typeof data.allowCategoryChange === 'boolean') payload.allow_category_change = data.allowCategoryChange;
    if (typeof data.ttl === 'number') payload.time_to_live = data.ttl;
    if (data.components) payload.components = data.components;

    const response = await this.requestEditTemplate(credentials, data.templateId, payload);

    if (!response || response.error) this.throwMetaError(response, 'Error to edit template');

    return response;
  }

  public async delete(instance: InstanceDto, data: { name: string; hsmId?: string }) {
    const getInstance = await this.waMonitor.waInstances[instance.instanceName].instance;
    if (!getInstance) {
      throw new Error('Instance not found');
    }

    const credentials = { businessId: getInstance.businessId, token: getInstance.token };

    const response = await this.requestDeleteTemplate(credentials, { name: data.name, hsm_id: data.hsmId });

    if (!response || response.error) this.throwMetaError(response, 'Error to delete template');

    try {
      // Best-effort local cleanup of stored template metadata
      await this.prismaRepository.template.deleteMany({
        where: {
          OR: [
            { name: data.name, instanceId: getInstance.id },
            data.hsmId ? { templateId: data.hsmId, instanceId: getInstance.id } : undefined,
          ].filter(Boolean) as any,
        },
      });
    } catch (err) {
      this.logger.warn(
        `Failed to cleanup local template records after delete: ${(err as Error)?.message || String(err)}`,
      );
    }

    return response;
  }

  private throwIfMetaUnavailable(error: any) {
    const status = metaUnavailableStatus(error);
    if (status === 504) throw new GatewayTimeoutException('A Meta não confirmou o envio.');
    if (status === 503)
      throw new ServiceUnavailableException('A Meta está indisponível no momento. Tente novamente em alguns minutos.');
  }

  private throwMetaError(response: any, fallback: string): never {
    if (!response?.error) throw new Error(fallback);
    const metaError = new Error(response.error.message || 'WhatsApp API Error');
    (metaError as any).template = response.error;
    throw metaError;
  }

  private async requestTemplate(credentials: { businessId: string; token: string }, data: any, method: string) {
    try {
      let urlServer = this.configService.get<WaBusiness>('WA_BUSINESS').URL;
      const version = this.configService.get<WaBusiness>('WA_BUSINESS').VERSION;
      urlServer = `${urlServer}/${version}/${credentials.businessId}/message_templates`;
      const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${credentials.token}` };

      if (method === 'GET') {
        const templates: any[] = [];
        let after: string;
        do {
          const result = await axios.get(urlServer, {
            headers,
            params: { fields: 'id,name,language,status,category,components,rejected_reason', limit: 100, after },
            timeout: 15000,
          });
          templates.push(...(result.data.data || []));
          after = result.data.paging?.next ? result.data.paging?.cursors?.after : undefined;
        } while (after);
        return { data: templates };
      } else if (method === 'POST') {
        const result = await axios.post(urlServer, data, { headers, timeout: 15000 });
        return result.data;
      }
    } catch (e) {
      this.logger.error(
        'WhatsApp API request error: ' + (e.response?.data ? JSON.stringify(e.response?.data) : e.message),
      );
      this.throwIfMetaUnavailable(e);

      // Return the complete error response from WhatsApp API
      if (e.response?.data) {
        return e.response.data;
      }

      // If no response data, throw connection error
      throw new Error(`Connection error: ${e.message}`);
    }
  }

  private async requestEditTemplate(credentials: { businessId: string; token: string }, templateId: string, data: any) {
    try {
      let urlServer = this.configService.get<WaBusiness>('WA_BUSINESS').URL;
      const version = this.configService.get<WaBusiness>('WA_BUSINESS').VERSION;
      urlServer = `${urlServer}/${version}/${templateId}`;
      const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${credentials.token}` };
      const result = await axios.post(urlServer, data, { headers, timeout: 15000 });
      return result.data;
    } catch (e) {
      this.logger.error(
        'WhatsApp API request error: ' + (e.response?.data ? JSON.stringify(e.response?.data) : e.message),
      );
      this.throwIfMetaUnavailable(e);
      if (e.response?.data) return e.response.data;
      throw new Error(`Connection error: ${e.message}`);
    }
  }

  private async requestDeleteTemplate(
    credentials: { businessId: string; token: string },
    params: { name: string; hsm_id?: string },
  ) {
    try {
      let urlServer = this.configService.get<WaBusiness>('WA_BUSINESS').URL;
      const version = this.configService.get<WaBusiness>('WA_BUSINESS').VERSION;
      urlServer = `${urlServer}/${version}/${credentials.businessId}/message_templates`;
      const headers = { Authorization: `Bearer ${credentials.token}` };
      const result = await axios.delete(urlServer, { headers, params, timeout: 15000 });
      return result.data;
    } catch (e) {
      this.logger.error(
        'WhatsApp API request error: ' + (e.response?.data ? JSON.stringify(e.response?.data) : e.message),
      );
      this.throwIfMetaUnavailable(e);
      if (e.response?.data) return e.response.data;
      throw new Error(`Connection error: ${e.message}`);
    }
  }
}
