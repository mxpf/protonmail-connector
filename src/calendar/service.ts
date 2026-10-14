import {loadConfig} from './config.js';
import {Feeds} from './feed.js';
import {FRESHNESS_WARNING} from './types.js';
import {PublicError} from '../../shared/protocol.js';
import {eventsSchema,windowSchema,availabilitySchema} from './schemas.js';
export class CalendarReader {
  private feeds: Feeds;
  constructor(private config:ReturnType<typeof loadConfig>,fetcher:typeof fetch=fetch) {this.feeds=new Feeds(config.cacheSeconds,fetcher);}
  static fromFile(path:string) {return new CalendarReader(loadConfig(path));}
  async execute(name:string,input:unknown):Promise<unknown> {
    if(name==='proton_calendar_list') return {calendars:this.config.calendars.map(({id,name,timezone,visibility})=>({id,name,timezone,visibility,readOnly:true})),warning:FRESHNESS_WARNING,directProtonWrites:false,manageUrl:'https://calendar.proton.me'};
    if(name==='proton_calendar_events') {
      const a=eventsSchema.parse(input);windowSchema.parse(a);
      const c=this.config.calendars.find(c=>c.id===a.calendarId);
      if(!c) throw new PublicError('calendar_missing','Select a listed calendar.');
      if(a.query && c.visibility==='busy') throw new PublicError('busy_only','Text search is unavailable for a busy-only calendar.');
      const s=await this.feeds.read(c,a.start,a.end);
      if((a.offset>0 && !a.snapshotId) || (a.snapshotId && a.snapshotId!==s.snapshotId)) throw new PublicError('calendar_changed','Use the first page snapshotId; restart if the feed changed.');
      const events=s.events.map(e=>c.visibility==='busy'?{...e,title:'Busy',description:'',location:''}:e).filter(e=>!a.query || [e.title,e.description,e.location].some(s=>s.toLowerCase().includes(a.query.toLowerCase())));
      return {events:events.slice(a.offset,a.offset+a.limit),nextOffset:a.offset+a.limit<events.length?a.offset+a.limit:null,total:events.length,snapshotId:s.snapshotId,fetchedAt:s.fetchedAt,warning:FRESHNESS_WARNING};
    }
    const a=availabilitySchema.parse(input);windowSchema.parse(a);
    const ids=[...new Set(a.calendarIds??this.config.calendars.map(c=>c.id))];
    const intervals:{start:string;end:string}[]=[],sources:{calendarId:string;fetchedAt:string}[]=[];
    for(const id of ids) {
      const c=this.config.calendars.find(c=>c.id===id);if(!c) throw new PublicError('calendar_missing','Select listed calendars.');
      const s=await this.feeds.read(c,a.start,a.end);sources.push({calendarId:id,fetchedAt:s.fetchedAt});
      intervals.push(...s.events.filter(e=>e.busy&&e.end>e.start).map(e=>({start:new Date(Math.max(Date.parse(e.start),Date.parse(a.start))).toISOString(),end:new Date(Math.min(Date.parse(e.end),Date.parse(a.end))).toISOString()})));
    }
    intervals.sort((a,b)=>a.start.localeCompare(b.start));const busy:typeof intervals=[];
    for(const interval of intervals) {const last=busy.at(-1);if(last&&interval.start<=last.end){if(interval.end>last.end)last.end=interval.end;}else busy.push({...interval});}
    const provisionalFree:typeof intervals=[];let cursor=new Date(a.start).toISOString();const end=new Date(a.end).toISOString();
    for(const b of busy) {if(cursor<b.start)provisionalFree.push({start:cursor,end:b.start});if(b.end>cursor)cursor=b.end;}
    if(cursor<end)provisionalFree.push({start:cursor,end});
    return {busy,provisionalFree,sources,warning:FRESHNESS_WARNING};
  }
}
