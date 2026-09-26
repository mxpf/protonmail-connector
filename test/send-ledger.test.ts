import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SendLedger, type Prepared} from '../src/send-ledger.js';
const mail: Prepared = {raw:'ZmFrZQ==', envelope:{from:'owner@example.com',to:['recipient@example.com']},preview:{text:'hello'},messageId:'<test@example.com>'};
test('send is committed once across concurrent attempts and process restart', async () => {
  const dir = mkdtempSync(join(tmpdir(),'proton-ledger-'));
  let ledger = new SendLedger(join(dir,'send.db'));
  try {
    const {token} = ledger.prepare(mail); let deliveries = 0;
    const outcomes = await Promise.allSettled([ledger.send(token,async () => {deliveries++;}),ledger.send(token,async () => {deliveries++;})]);
    assert.equal(deliveries,1); assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1);
    ledger.close(); ledger = new SendLedger(join(dir,'send.db'));
    await assert.rejects(ledger.send(token, async () => {deliveries++;})); assert.equal(deliveries,1);
  } finally {ledger.close(); rmSync(dir,{recursive:true});}
});
test('timeout after possible delivery burns token, and expiry prevents delivery', async () => {
  let now = 100_000; const ledger = new SendLedger(':memory:',()=>now);
  try {
    const first = ledger.prepare(mail);
    await assert.rejects(ledger.send(first.token, async()=>{throw new Error('connection lost after DATA');}), /could not be confirmed/);
    let count=0;
    await assert.rejects(ledger.send(first.token,async()=>{count++;}));
    const expired = ledger.prepare(mail); now += 16*60_000;
    await assert.rejects(ledger.send(expired.token,async()=>{count++;})); assert.equal(count,0);
  } finally {ledger.close();}
});
