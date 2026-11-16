// Utilitários compartilhados: carrega as três funções serverless e expõe
// adaptadores que as invocam como se fossem chamadas HTTP.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export const awsHandler = require('../aws-lambda/index.js').handler;
export const { projetorInflacao: gcpHandler } = await import('../google-functions/index.js');

// Azure (modelo v4): captura o handler registrado em app.http('cambio', ...)
const az = createRequire(new URL('../azure-functions/package.json', import.meta.url))('@azure/functions');
let azureRegistro;
const appHttpOriginal = az.app.http;
az.app.http = (nome, opcoes) => { azureRegistro = { nome, ...opcoes }; };
await import('../azure-functions/src/functions/cambio.js');
az.app.http = appHttpOriginal;
export const azureRegistrada = azureRegistro;

export async function invocarAWS({ method = 'POST', body, query, headers = {} } = {}) {
    const r = await awsHandler({
        requestContext: { http: { method } },
        headers,
        queryStringParameters: query,
        body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body))
    });
    return { status: r.statusCode, headers: r.headers, body: r.body ? JSON.parse(r.body) : r.body };
}

/**
 * Invoca a Azure Function. `cotacaoAoVivo` simula a AwesomeAPI:
 *  null (padrão) = API fora do ar -> a função usa a tabela fixa; objeto { USD, EUR } = cotações devolvidas.
 */
export async function invocarAzure({ method = 'POST', body, query = {}, headers = {}, cotacaoAoVivo = null } = {}) {
    const url = new URL('http://localhost/api/cambio');
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    const request = new az.HttpRequest({
        method,
        url: url.toString(),
        headers,
        body: body === undefined ? undefined : { string: typeof body === 'string' ? body : JSON.stringify(body) }
    });
    const context = new az.InvocationContext({ functionName: 'cambio', logHandler: () => {} });

    const fetchOriginal = globalThis.fetch;
    const chamadasApi = [];
    globalThis.fetch = async (alvo) => {
        chamadasApi.push(String(alvo));
        if (!cotacaoAoVivo) throw new TypeError('fetch failed');
        const json = Object.fromEntries(Object.entries(cotacaoAoVivo).map(([m, bid]) => [`${m}BRL`, { bid: String(bid) }]));
        return { ok: true, json: async () => json };
    };
    try {
        const r = await azureRegistro.handler(request, context);
        return { status: r.status, headers: r.headers, body: r.jsonBody, chamadasApi };
    } finally {
        globalThis.fetch = fetchOriginal;
    }
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
