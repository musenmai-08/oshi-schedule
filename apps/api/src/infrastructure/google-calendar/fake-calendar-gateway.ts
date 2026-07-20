import { randomUUID } from 'node:crypto';
import type { CalendarEventInput } from '../../domain/scheduling.js';
import type { CalendarGateway, UserRecord } from '../../application/models.js';

export class FakeCalendarGateway implements CalendarGateway {
  readonly events = new Map<string, CalendarEventInput>();
  readonly calendars = new Set<string>();
  async ensureCalendar(user: UserRecord) {
    const id = user.calendarId ?? `fake-calendar-${user.id}`;
    this.calendars.add(id);
    return id;
  }
  async upsertEvent(
    _user: UserRecord,
    _calendarId: string,
    eventId: string | null,
    event: CalendarEventInput,
  ) {
    const id = eventId && this.events.has(eventId) ? eventId : randomUUID();
    this.events.set(id, event);
    return id;
  }
  async deleteEvent(_user: UserRecord, _calendarId: string, eventId: string) {
    this.events.delete(eventId);
  }
  async deleteCalendar(_user: UserRecord, calendarId: string) {
    this.calendars.delete(calendarId);
  }
  async revokeAuthorization() {}
}
