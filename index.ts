import { Client } from 'pg';
import * as c from 'crypto';

export interface Env {
  DATABASE_URL: string;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {

    const client = new Client({ connectionString: env.DATABASE_URL });
    const result = await client.query('SELECT now()');
    return new Response('x' /*JSON.stringify(result.rows)*/);
  }
}
