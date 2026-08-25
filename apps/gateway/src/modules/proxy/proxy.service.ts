import { Injectable, Logger, InternalServerErrorException } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { WebhooksService } from '../webhooks/webhooks.service';
import * as dns from 'dns/promises';
import { firstValueFrom } from 'rxjs';

interface DnsCacheEntry {
  ips: string[];
  expiry: number;
}

@Injectable()
export class ProxyService {
  private readonly logger = new Logger(ProxyService.name);
  private readonly dnsCache = new Map<string, DnsCacheEntry>();
  private readonly CACHE_TTL_MS = 60000;

  constructor(
    private readonly httpService: HttpService,
    private readonly webhooksService: WebhooksService,
  ) {}

  private async validateDnsAtRuntime(hostname: string): Promise<void> {
    const cached = this.dnsCache.get(hostname);
    if (cached && cached.expiry > Date.now()) {
      return;
    }

    try {
      const addresses = await dns.resolve4(hostname);
      for (const ip of addresses) {
        if (this.webhooksService.isPrivateIp(ip)) {
          this.logger.warn(`[AUDIT] proxy.dns_rebind_blocked: ${hostname} resolved to private IP ${ip}`);
          throw new Error('DNS Rebinding detected: resolved to private IP');
        }
      }
      this.dnsCache.set(hostname, {
        ips: addresses,
        expiry: Date.now() + this.CACHE_TTL_MS,
      });
    } catch (error) {
      if (error.message === 'DNS Rebinding detected: resolved to private IP') {
        throw error;
      }
      // Fallback for resolution errors
      throw new Error(`DNS resolution failed: ${error.message}`);
    }
  }

  async proxyRequest(urlStr: string, method: string, data?: any, headers?: any) {
    const url = new URL(urlStr);
    await this.validateDnsAtRuntime(url.hostname);

    try {
      const response = await firstValueFrom(
        this.httpService.request({
          method,
          url: urlStr,
          data,
          headers: {
            ..headers,
            'Host': url.hostname,
          },
        }),
      );
      return response;
    } catch (error) {
      if (error.message.includes('DNS Rebinding')) {
        throw new InternalServerErrorException('Upstream validation failed', 502);
      }
      throw error;
    }
  }
}