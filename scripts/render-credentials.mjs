import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const outputDirectory = resolve(process.argv[2] ?? '');
if (!process.argv[2]) throw new Error('usage: node render-credentials.mjs OUTPUT_DIRECTORY');

const required = ['CLIENTOPS_INTAKE_API_KEY', 'CLIENTOPS_ADMIN_API_KEY', 'CLIENTOPS_DB_PASSWORD'];
for (const name of required) {
  if (!process.env[name]) throw new Error(`${name} is required`);
}

const credentials = [
  {
    id: 'clientops-intake-api-key',
    name: 'ClientOps Intake API Key',
    type: 'httpHeaderAuth',
    data: {
      name: 'X-ClientOps-Intake-Key',
      value: process.env.CLIENTOPS_INTAKE_API_KEY,
    },
  },
  {
    id: 'clientops-admin-api-key',
    name: 'ClientOps Admin API Key',
    type: 'httpHeaderAuth',
    data: {
      name: 'X-ClientOps-Admin-Key',
      value: process.env.CLIENTOPS_ADMIN_API_KEY,
    },
  },
  {
    id: 'clientops-postgres',
    name: 'ClientOps PostgreSQL',
    type: 'postgres',
    data: {
      host: process.env.CLIENTOPS_DB_HOST ?? 'postgres',
      database: process.env.CLIENTOPS_DB_NAME ?? 'clientops',
      user: process.env.CLIENTOPS_DB_USER ?? 'clientops_app',
      password: process.env.CLIENTOPS_DB_PASSWORD,
      maxConnections: 5,
      allowUnauthorizedCerts: false,
      ssl: 'disable',
      port: Number.parseInt(process.env.CLIENTOPS_DB_PORT ?? '5432', 10),
      sshTunnel: false,
    },
  },
  {
    id: 'clientops-smtp',
    name: 'ClientOps SMTP',
    type: 'smtp',
    data: {
      user: '',
      password: '',
      host: process.env.CLIENTOPS_SMTP_HOST ?? 'mailpit',
      port: Number.parseInt(process.env.CLIENTOPS_SMTP_PORT ?? '1025', 10),
      secure: false,
      disableStartTls: true,
      hostName: 'clientops-relay',
    },
  },
];

await mkdir(outputDirectory, { recursive: true });
const path = resolve(outputDirectory, 'credentials.json');
await writeFile(path, JSON.stringify(credentials, null, 2) + '\n', { mode: 0o600 });
await chmod(path, 0o600);
process.stdout.write(path + '\n');
