import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {ZodError} from 'zod';
import {realpathSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {loadConfig} from './config.js';
import {MailService} from './mail.js';
import {tools, instructions, PublicError, type ToolName, MAX_RESPONSE_BYTES} from '../shared/protocol.js';

export function createServer(service: Pick<MailService, 'execute'>) {
  const server = new McpServer({name:'proton-mail-connector',version:'0.1.0'}, {instructions});
  const reads = new Set(['proton_status','proton_list_mailboxes','proton_search','proton_read','proton_read_attachment']);
  for (const name of Object.keys(tools) as ToolName[]) {
    const definition = tools[name];
    server.registerTool(name, {description: definition.description, inputSchema: definition.schema,
      annotations: {readOnlyHint: reads.has(name), destructiveHint: ['proton_move','proton_set_flags','proton_send_prepared'].includes(name),
        idempotentHint: reads.has(name) || name === 'proton_set_flags', openWorldHint:true}}, async (args: unknown) => {
      try {
        const result = await service.execute(name,args);
        const text = JSON.stringify(result);
        if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) throw new PublicError('response_too_large','Result exceeds the response limit. Narrow the request.');
        return {content: [{type:'text' as const, text}]};
      } catch (error) {
        const message = error instanceof PublicError ? `${error.code}: ${error.message}` : error instanceof ZodError
          ? 'invalid_input: Check the tool arguments.'
          : 'operation_unconfirmed: Operation could not be confirmed. For a write, check mailbox state before retrying.';
        return {isError: true, content:[{type:'text' as const,text:message}]};
      }
    });
  }
  return server;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const path = process.env.PROTON_CONFIG;
  if (!path) throw new Error('Set PROTON_CONFIG to a private configuration file.');
  const service = new MailService(loadConfig(path));
  const server = createServer(service);
  await server.connect(new StdioServerTransport());
  const stop = async () => { await server.close(); service.close(); process.exit(0); };
  process.once('SIGTERM',stop); process.once('SIGINT',stop);
}
