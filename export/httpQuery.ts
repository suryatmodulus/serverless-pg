import { parse } from '../shims/url';
import { Socket } from '../shims/net';
import { types, localhostWarning } from '.';

// @ts-ignore -- this isn't officially exported by pg
import { prepareValue } from '../node_modules/pg/lib/utils';

export class NeonDbError extends Error {
  code: string | null = null;
  name = 'NeonDbError';
}

interface Query {
  query: string;
  params: any[];
}

interface HTTPQueryOptions {
  arrayMode?: boolean;  // default false
  fullResults?: boolean;  // default false
  fetchOptions?: Record<string, any>;
  queryCallback?: (query: Query) => void;
  resultCallback?: (query: Query, result: any, rows: any, opts: any) => void;
}

export function neon(
  connectionString: string, {
    arrayMode: arrayModeDefault,
    fullResults: fullresultsDefault,
    fetchOptions: fetchOptionsDefault,
    queryCallback,
    resultCallback
  }: HTTPQueryOptions = {}
) {

  const db = parse(connectionString);
  const { protocol, username, password, hostname, pathname } = db;

  if ((protocol !== 'postgres:' && protocol !== 'postgresql:') || !hostname || !username || !password || !pathname) {
    throw new Error('Database connection string format should be: postgresql://user:password@host.tld/dbname?option=value');
  }
  if (hostname === 'localhost') console.warn(localhostWarning);

  return async function (strings: TemplateStringsArray | string, ...params: any[]): Promise<any> {
    let arrayMode = arrayModeDefault ?? false;
    let fullResults = fullresultsDefault ?? false;
    let fetchOptions = fetchOptionsDefault ?? {};

    let query;
    if (typeof strings === 'string') {  // ordinary (non tagged-template) usage
      query = strings;

      const opts = params[1];  // drizzle-orm insist that they need these options overrides
      if (opts !== undefined) {
        if (opts.arrayMode !== undefined) arrayMode = opts.arrayMode;
        if (opts.fullResults !== undefined) fullResults = opts.fullResults;
        if (opts.fetchOptions !== undefined) fetchOptions = { ...fetchOptions, ...opts.fetchOptions };
      }

      params = params[0] ?? [];  // the second argument should be an array of params

    } else {  // tagged-template usage
      query = '';
      for (let i = 0; i < strings.length; i++) {
        query += strings[i];
        if (i < params.length) query += '$' + (i + 1);
      }
    }

    // preparing the query params makes timezones and array types consistent with ordinary node-postgres/pg
    params = params.map(param => prepareValue(param));

    let qp, response;
    try {
      const url = `https://${hostname}/sql`;
      const connCacheHeader = Socket.fetchConnectionCache === true ? { 'Neon-Pool-Opt-In': 'true' } : {} as Record<string, string>;

      qp = { query, params };
      if (queryCallback) queryCallback(qp);

      response = await fetch(url, {
        body: JSON.stringify(qp),
        method: 'POST',
        headers: {
          'Neon-Connection-String': connectionString,
          'Neon-Raw-Text-Output': 'true',
          'Neon-Array-Mode': 'true',
          ...connCacheHeader,
        },
        ...fetchOptions,
      });

    } catch (err: any) {
      throw new NeonDbError(`Error connecting to database: ${err.message}`)
    }

    if (response.ok) {
      const rawResults = await response.json() as any;
      const colNames = rawResults.fields.map((field: any) => field.name);
      const parsers = rawResults.fields.map((field: any) => types.getTypeParser(field.dataTypeID));

      // now parse and possibly restructure the rows data like node-postgres does
      const rows = arrayMode === true ?
        // maintain array-of-arrays structure
        rawResults.rows.map((row: any) => row.map((col: any, i: number) => col === null ? null : parsers[i](col))) :
        // turn into an object
        rawResults.rows.map((row: any) => {
          return Object.fromEntries(
            row.map((col: any, i: number) => [colNames[i], col === null ? null : parsers[i](col)])
          )
        });

      if (resultCallback) resultCallback(qp, rawResults, rows, { arrayMode, fullResults });

      if (fullResults) {
        rawResults.viaNeonFetch = true;
        rawResults.rowAsArray = arrayMode;
        rawResults.rows = rows;
        return rawResults;
      }

      return rows;

    } else {
      const { status } = response;
      if (status === 400) {
        const { message, code } = await response.json() as any;
        const dbError = new NeonDbError(message);
        dbError.code = code;
        throw dbError;

      } else {
        const text = await response.text();
        throw new NeonDbError(`Database error (HTTP status ${status}): ${text}`);
      }
    }
  }
}