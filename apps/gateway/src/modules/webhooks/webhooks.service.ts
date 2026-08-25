import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { isIP } from 'net';
import * as dns from 'dns/promises';

@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);

  constructor(private configService: ConfigService) {}

  async validateUpstreamUrl(urlStr: string): Promise<void> {
    try {
      const url = new URL(urlStr);
      if (url.protocol!== 'http:' && url.protocol!== 'https:') {
        throw new Error('Invalid protocol');
      }

      const hostname = url.hostname;
      const addresses = await dns.resolve4(hostname);
      
      for (const ip of addresses) {
        if (this.isPrivateIp(ip)) {
          this.logger.warn(`Validation failed: ${hostname} resolved to private IP ${ip}`);
          throw new Error('Upstream URL resolves to a private IP address');
        }
      }
    } catch (error) {
      this.logger.error(`URL validation failed for ${urlStr}: ${error.message}`);
      throw new BadRequestException(error.message);
    }
  }

  isPrivateIp(ip: string): boolean {
    // Simple check for common private/local ranges
    // 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16, 127.0.0.0/8
    const parts = ip.split('.').map(Number);
    if (parts[0] === 10) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 23) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
    if (parts[0] === 127) return true;
    return false;
  }
}