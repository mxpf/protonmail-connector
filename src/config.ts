import {readFileSync, statSync} from 'node:fs';
import {z} from 'zod';

export const configSchema = z.object({
  username: z.string().email(), password: z.string().min(1),
  sender: z.string().email(), certificatePath: z.string().startsWith('/'),
  tlsServerName: z.string().default('127.0.0.1'),
  imapPort: z.number().int().min(1).max(65535).default(1143),
  smtpPort: z.number().int().min(1).max(65535).default(1025),
  ledgerPath: z.string().startsWith('/'),
}).strict();
export type Config = z.infer<typeof configSchema>;
export function loadConfig(path: string): Config {
  const stat = statSync(path);
  if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error('Configuration must be a private file (mode 600).');
  return configSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}
