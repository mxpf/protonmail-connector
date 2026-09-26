import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createServer} from '../src/server.js';

test('MCP discovery, schema rejection and read/write annotations',async()=>{
  let called=0;
  const server=createServer({execute:async()=>{called++;return {connected:true};}});
  const client=new Client({name:'test-client',version:'1.0.0'});
  const [left,right]=InMemoryTransport.createLinkedPair();
  await server.connect(left); await client.connect(right);
  try {
    const listed=await client.listTools();
    assert.equal(listed.tools.length,10);
    assert.equal(listed.tools.find(t=>t.name==='proton_read')?.annotations?.readOnlyHint,true);
    assert.equal(listed.tools.find(t=>t.name==='proton_send_prepared')?.annotations?.readOnlyHint,false);
    await client.callTool({name:'proton_status',arguments:{}});assert.equal(called,1);
    const result=await client.callTool({name:'proton_send_prepared',arguments:{token:'invalid'}});
    assert.equal(result.isError,true);assert.equal(called,1);
  } finally {await client.close();await server.close();}
});
