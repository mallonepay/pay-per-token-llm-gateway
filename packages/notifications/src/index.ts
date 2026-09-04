// ──────────────────────────────────────────────
// @x402/notifications — Webhook, in-app
// ──────────────────────────────────────────────

import type { NotificationChannel, NotificationEvent } from '@x402/types';
import { logger } from '@x402/logger';

export interface NotificationPayload {
  providerId: string;
  event: NotificationEvent;
  data: Record<string, unknown>;
}

export interface NotificationHandler {
  channel: NotificationChannel;
  send(payload: NotificationPayload): Promise<boolean>;
}

// ── In-App Notification Handler (logs + in-memory queue) ─

interface InAppMessage {
  id: string;
  providerId: string;
  event: string;
  data: Record<string, unknown>;
  timestamp: string;
  read: boolean;
}

const inAppQueue: InAppMessage[] = [];

export const inAppHandler: NotificationHandler = {
  channel: 'in_app',
  async send(payload) {
    const message: InAppMessage = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      providerId: payload.providerId,
      event: payload.event,
      data: payload.data,
      timestamp: new Date().toISOString(),
      read: false,
    };
    inAppQueue.unshift(message);

    // Keep only last 1000 messages
    if (inAppQueue.length > 1000) {
      inAppQueue.length = 1000;
    }

    logger.info('In-app notification', payload as unknown as Record<string, unknown>);
    return true;
  },
};

/** Get in-app notifications for a provider */
export function getInAppNotifications(providerId: string, limit = 50): InAppMessage[] {
  return inAppQueue.filter((m) => m.providerId === providerId).slice(0, limit);
}

/** Mark a notification as read */
export function markInAppRead(messageId: string): boolean {
  const msg = inAppQueue.find((m) => m.id === messageId);
  if (msg) {
    msg.read = true;
    return true;
  }
  return false;
}

// ── Webhook Notification Handler ─────────────

export class WebhookNotificationHandler implements NotificationHandler {
  channel: NotificationChannel = 'webhook';

  constructor(
    private options: {
      retryCount?: number;
      retryDelayMs?: number;
    } = {},
  ) {}

  async send(payload: NotificationPayload, webhookUrl?: string): Promise<boolean> {
    if (!webhookUrl) {
      logger.warn('No webhook URL configured — skipping');
      return false;
    }

    const maxRetries = this.options.retryCount || 3;
    const retryDelay = this.options.retryDelayMs || 1000;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const response = await fetch(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            event: payload.event,
            providerId: payload.providerId,
            data: payload.data,
            timestamp: new Date().toISOString(),
          }),
        });

        if (response.ok) {
          logger.info('Webhook sent successfully', { event: payload.event, webhookUrl });
          return true;
        }

        logger.warn('Webhook delivery failed', {
          event: payload.event,
          status: response.status,
          attempt,
        });
      } catch (error) {
        logger.warn('Webhook error', { event: payload.event, error: String(error), attempt });
      }

      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, retryDelay * attempt));
      }
    }

    logger.error('Webhook delivery failed after all retries', { event: payload.event });
    return false;
  }

  /**
   * Send a webhook with an optional HMAC-SHA256 signature header so the
   * receiver can verify the payload came from this gateway.
   *
   * Signature: hex(HMAC-SHA256(secret, rawBody)) sent as `X-x402-Signature`.
   */
  async sendWithSignature(
    payload: NotificationPayload,
    webhookUrl: string,
    secret?: string,
  ): Promise<boolean> {
    const maxRetries = this.options.retryCount || 3;
    const retryDelay = this.options.retryDelayMs || 1000;
    const body = JSON.stringify({
      event: payload.event,
      providerId: payload.providerId,
      data: payload.data,
      timestamp: new Date().toISOString(),
    });

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (secret) {
      const { createHmac } = await import('crypto');
      headers['X-x402-Signature'] = createHmac('sha256', secret).update(body).digest('hex');
    }

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const response = await fetch(webhookUrl, {
          method: 'POST',
          headers,
          body,
          // Never let a misbehaving receiver stall payment processing.
          signal: AbortSignal.timeout(10_000),
        });

        if (response.ok) {
          logger.info('Signed webhook sent successfully', {
            event: payload.event,
            webhookUrl,
            signed: !!secret,
          });
          return true;
        }

        logger.warn('Signed webhook delivery failed', {
          event: payload.event,
          status: response.status,
          attempt,
        });
      } catch (error) {
        logger.warn('Signed webhook error', {
          event: payload.event,
          error: String(error),
          attempt,
        });
      }

      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, retryDelay * attempt));
      }
    }

    logger.error('Signed webhook delivery failed after all retries', { event: payload.event });
    return false;
  }
}

// ── Notification Dispatcher ──────────────────

export class NotificationDispatcher {
  private handlers: NotificationHandler[] = [];

  register(handler: NotificationHandler): void {
    this.handlers.push(handler);
  }

  async dispatch(payload: NotificationPayload): Promise<NotificationChannel[]> {
    const delivered: NotificationChannel[] = [];

    for (const handler of this.handlers) {
      try {
        const success = await handler.send(payload);
        if (success) delivered.push(handler.channel);
      } catch (error) {
        logger.error('Notification handler error', {
          channel: handler.channel,
          error: String(error),
        });
      }
    }

    return delivered;
  }
}

/** Default dispatcher instance — handlers are registered at gateway startup. */
export const dispatcher = new NotificationDispatcher();
dispatcher.register(inAppHandler);
