import { randomUUID } from 'node:crypto';
import { GOOGLE_OAUTH_REQUEST_SCOPES } from '@oshi-schedule/shared';
import type { CalendarEventInput } from '../../domain/scheduling.js';
import type { CalendarGateway, UserRecord } from '../../application/models.js';

export class FakeCalendarGateway implements CalendarGateway {
  readonly events = new Map<string, CalendarEventInput>();
  readonly calendars = new Set<string>();
  async verifyGrant() {
    return [...GOOGLE_OAUTH_REQUEST_SCOPES].sort().join(' ');
  }
  async ensureCalendar(user: UserRecord) {
    const id = user.calendarId ?? `fake-calendar-${user.id}`;
    this.calendars.add(id);
    return id;
  }
  async eventExists(_user: UserRecord, _calendarId: string, eventId: string) {
    return this.events.has(eventId);
  }
  async upsertEvent(
    _user: UserRecord,
    _calendarId: string,
    eventId: string | null,
    event: CalendarEventInput,
    _deterministicId = false,
  ) {
    void _deterministicId;
    const id = eventId ?? randomUUID();
    this.events.set(id, event);
    return id;
  }
  async deleteEvent(_user: UserRecord, _calendarId: string, eventId: string) {
    this.events.delete(eventId);
  }
  async deleteManagedEvent(user: UserRecord, calendarId: string, eventId: string, notAfter?: Date) {
    const event = this.events.get(eventId);
    if (event && event.extendedProperties.private.managedBy !== 'oshi-schedule')
      throw new Error('GOOGLE_EVENT_NOT_MANAGED');
    if (event && notAfter) {
      const start = Date.parse(event.start);
      const end = Date.parse(event.end);
      if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || end > notAfter.getTime())
        throw new Error('GOOGLE_EVENT_NOT_PAST');
    }
    await this.deleteEvent(user, calendarId, eventId);
  }
  async deleteCalendar(_user: UserRecord, calendarId: string) {
    this.calendars.delete(calendarId);
  }
  async revokeAuthorization() {}
}
