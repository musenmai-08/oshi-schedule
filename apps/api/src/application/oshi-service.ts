import { MAX_CHANNELS_PER_USER } from '@oshi-schedule/shared';
import { AppError } from '../domain/errors.js';
import type {
  AuthAdmin,
  AuthIdentity,
  CalendarGateway,
  Clock,
  Store,
  TokenCipher,
  YouTubeGateway,
} from './models.js';
import type { SyncService } from './sync-service.js';

export class OshiService {
  constructor(
    private readonly store: Store,
    private readonly youtube: YouTubeGateway,
    private readonly calendar: CalendarGateway,
    private readonly cipher: TokenCipher,
    private readonly clock: Clock,
    private readonly authAdmin: AuthAdmin,
    readonly sync: SyncService,
  ) {}

  async me(identity: AuthIdentity) {
    return this.store.ensureUser(identity);
  }

  async onboard(identity: AuthIdentity, refreshToken: string) {
    const user = await this.store.ensureUser(identity);
    const encrypted = this.cipher.encrypt(refreshToken);
    await this.store.saveCredential(user.id, encrypted.ciphertext, encrypted.keyId);
    const calendarId = await this.calendar.ensureCalendar(user);
    return this.store.completeOnboarding(
      user.id,
      encrypted.ciphertext,
      encrypted.keyId,
      calendarId,
    );
  }

  async resolve(handle: string) {
    const resolved = await this.youtube.resolveHandle(handle);
    return this.store.upsertChannel(resolved);
  }

  async list(identity: AuthIdentity) {
    const user = await this.store.ensureUser(identity);
    return this.store.listSubscriptions(user.id);
  }

  async register(identity: AuthIdentity, youtubeChannelId: string) {
    const user = await this.store.ensureUser(identity);
    const count = await this.store.countSubscriptions(user.id);
    if (count >= MAX_CHANNELS_PER_USER)
      throw new AppError('CHANNEL_LIMIT_REACHED', '登録上限は3件です', 422);
    const channel = await this.store.findChannelByYoutubeId(youtubeChannelId);
    if (!channel)
      throw new AppError('CHANNEL_NOT_RESOLVED', '先にチャンネルを検索してください', 409);
    try {
      return await this.store.createSubscription(user.id, channel.id);
    } catch {
      throw new AppError('DUPLICATE_CHANNEL', 'このチャンネルは登録済みです', 409);
    }
  }

  async setStatus(identity: AuthIdentity, id: string, status: 'ACTIVE' | 'PAUSED') {
    const user = await this.store.ensureUser(identity);
    const result = await this.store.updateSubscription(user.id, id, status);
    if (!result) throw new AppError('NOT_FOUND', '対象が見つかりません', 404);
    return result;
  }

  async remove(identity: AuthIdentity, id: string) {
    const user = await this.store.ensureUser(identity);
    const target = await this.store.getSubscription(user.id, id);
    if (!target) throw new AppError('NOT_FOUND', '対象が見つかりません', 404);
    if (user.calendarId) {
      const broadcasts = await this.store.listFutureBroadcasts(target.channel.id, this.clock.now());
      for (const item of broadcasts) {
        const mapping = await this.store.getMapping(user.id, item.id);
        if (mapping) {
          await this.calendar.deleteEvent(user, user.calendarId, mapping.eventId);
          await this.store.deleteMapping(user.id, item.id);
        }
      }
    }
    await this.store.deleteSubscription(user.id, id);
  }

  async reconnect(identity: AuthIdentity, refreshToken: string) {
    return this.onboard(identity, refreshToken);
  }

  async deleteAccount(identity: AuthIdentity) {
    const user = await this.store.ensureUser(identity);
    if (user.calendarId) await this.calendar.deleteCalendar(user, user.calendarId);
    await this.calendar.revokeAuthorization(user);
    await this.store.deleteAccount(user.id);
    await this.authAdmin.deleteUser(identity.subject);
  }
}
