import { parentPort, workerData } from 'node:worker_threads';
import { parseCalendar } from './parse.js';
try {
  parentPort!.postMessage({
    events: parseCalendar(
      workerData.ics,
      workerData.id,
      workerData.timezone,
      workerData.start,
      workerData.end,
    ),
  });
} catch {
  parentPort!.postMessage({
    error: 'Calendar cannot be safely expanded. Check its format, timezones, recurrence, and size.',
  });
}
