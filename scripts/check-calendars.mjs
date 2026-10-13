import {CalendarReader} from '../dist/src/calendar/service.js';
import {loadConfig} from '../dist/src/calendar/config.js';
const config=loadConfig(process.argv[2]);const reader=new CalendarReader(config);
const start=new Date().toISOString(),end=new Date(Date.now()+7*86400000).toISOString();
const results=[];
for(const c of config.calendars){try{const r=await reader.execute('proton_calendar_events',{calendarId:c.id,start,end,limit:1});results.push({id:c.id,readable:true,eventCount:r.total});}catch{results.push({id:c.id,readable:false});}}
console.log(JSON.stringify({calendars:results,allReadable:results.every(r=>r.readable)}));if(results.some(r=>!r.readable))process.exitCode=1;
