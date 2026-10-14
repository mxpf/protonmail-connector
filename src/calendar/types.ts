export type CalendarEvent = {
  id: string;
  calendarId: string;
  uid: string;
  recurrenceId: string | null;
  recurring: boolean;
  title: string;
  description: string;
  location: string;
  start: string;
  end: string;
  allDay: boolean;
  startDate?: string;
  endDate?: string;
  busy: boolean;
  revision: string;
};
export type Snapshot = { events: CalendarEvent[]; fetchedAt: string; snapshotId: string };
export const FRESHNESS_WARNING =
  'Proton shared links may lag changes by up to eight hours. fetchedAt is the download time, not proof of current calendar contents. Results cover only configured shared calendars and are not a booking guarantee. For current changes or creating/editing events, open https://calendar.proton.me.';
