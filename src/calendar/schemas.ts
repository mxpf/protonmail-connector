import {z} from 'zod';
const instant=z.string().datetime({offset:true});
export const windowShape={start:instant,end:instant};
export const windowSchema=z.object(windowShape).refine(w=>Date.parse(w.end)>Date.parse(w.start) && Date.parse(w.end)-Date.parse(w.start)<=93*86400000,'Use an increasing window of at most 93 days.');
export const eventsSchema=z.object({calendarId:z.string().max(40),...windowShape,query:z.string().max(200).default(''),offset:z.number().int().min(0).max(10000).default(0),limit:z.number().int().min(1).max(100).default(50),snapshotId:z.string().regex(/^[a-f0-9]{64}$/).optional()}).strict();
export const availabilitySchema=z.object({...windowShape,calendarIds:z.array(z.string().max(40)).min(1).max(25).optional()}).strict();
