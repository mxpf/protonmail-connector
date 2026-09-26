import {loadConfig} from './config.js';
import {MailService} from './mail.js';
import {randomUUID} from 'node:crypto';
import type {MessageRef} from '../shared/protocol.js';

const path = process.env.PROTON_CONFIG;
if (!path) throw new Error('PROTON_CONFIG is required.');
const config = loadConfig(path);
const service = new MailService(config);
try {
  await service.execute('proton_status',{});
  const folders = await service.execute('proton_list_mailboxes',{}) as {path:string;specialUse?:string}[];
  const found = await service.execute('proton_search',{mailbox:'INBOX',limit:3}) as {messages:unknown[]};
  console.log(JSON.stringify({authenticated:true,folderCount:folders.length,inboxSampleCount:found.messages.length}));
  if (process.argv.includes('--write-test')) {
    const trash = folders.find(f => f.specialUse === '\\Trash');
    if (!trash) throw new Error('No Trash folder found for test cleanup.');
    const marker = randomUUID();
    const text = `Private connector setup test ${marker}. No email was sent.`;
    const draft = await service.execute('proton_create_draft', {to:[config.sender],subject:`Connector setup test ${marker}`,text}) as MessageRef;
    if (!draft.uid || !draft.uidValidity || !draft.mailbox) throw new Error('Draft created but has no usable reference; inspect Drafts.');
    const message: MessageRef = {mailbox:draft.mailbox,uid:draft.uid,uidValidity:draft.uidValidity};
    const read = await service.execute('proton_read',{message}) as {text:string};
    if (read.text.trim() !== text) throw new Error('Draft readback differed; inspect Drafts.');
    await service.execute('proton_move',{message,destination:trash.path});
    console.log(JSON.stringify({draftCreated:true,draftReadbackVerified:true,testDraftMovedToTrash:true,emailSent:false}));
  }
} catch (error) {
  // Do not serialize arbitrary SMTP/IMAP errors: they may contain account data.
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'unclassified';
  console.error(JSON.stringify({checkFailed:true,code:/^[A-Za-z0-9_-]{1,64}$/.test(code)?code:'unclassified'}));
  process.exitCode=1;
} finally {service.close();}
