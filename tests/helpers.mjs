// Utilitários compartilhados: carrega as três funções serverless e expõe
// adaptadores que as invocam como se fossem chamadas HTTP.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export const awsHandler = require('../aws-lambda/index.js').handler;
export const azureHandler = require('../azure-functions/conversorCambio/index.js');
export const { projetorInflacao: gcpHandler } = await import('../google-functions/index.js');

export async function invocarAWS({ method = 'POST', body, query, headers = {} } = {}) {
    const r = await awsHandler({
        requestContext: { http: { method } },
        headers,
        queryStringParameters: query,
        body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body))
    });
    return { status: r.statusCode, headers: r.headers, body: r.body ? JSON.parse(r.body) : r.body };
}

export async function invocarAzure({ method = 'POST', body, query = {}, headers = {} } = {}) {
    const context = { log: Object.assign(() => {}, { error: () => {} }) };
    await azureHandler(context, { method, body, query, headers });
    return { status: context.res.status, headers: context.res.headers, body: context.res.body };
}

export async function invocarGCP({ method = 'POST', body, query = {}, headers = {} } = {}) {
    const req = {
        method,
        body,
        query,
        get: (nome) => headers[nome.toLowerCase()]
    };
    const res = {
        statusCode: undefined,
        headers: {},
        body: undefined,
        set(k, v) { this.headers[k] = v; return this; },
        status(c) { this.statusCode = c; return this; },
        json(b) { this.body = b; return this; },
        send(b) { this.body = b; return this; }
    };
    const erroOriginal = console.error;
    console.error = () => {}; // silencia o log esperado da falha simulada
    try {
        gcpHandler(req, res);
    } finally {
        console.error = erroOriginal;
    }
    return { status: res.statusCode, headers: res.headers, body: res.body };
}
