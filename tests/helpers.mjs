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
    const erroOriginal = console.error;
    console.error = () => {}; // silencia o log esperado da falha simulada
    let r;
    try {
        r = await awsHandler({
            requestContext: { http: { method } },
            headers,
            queryStringParameters: query,
            body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body))
        });
    } finally {
        console.error = erroOriginal;
    }
    return { status: r.statusCode, headers: r.headers, body: r.body ? JSON.parse(r.body) : r.body };
}

export const cambio = await import('../azure-functions/src/cambio.js');

/**
 * Simula as duas APIs de cotação no fetch global. Cada uma recebe { USD, EUR } (cotação em R$)
 * ou null (fora do ar); `atrasoMs` atrasa a resposta de cada uma.
 * Devolve { chamadas, restaurar }.
 */
export function simularApisCotacao({ awesome = null, exchangerate = null, atrasoMs = {} } = {}) {
    const fetchOriginal = globalThis.fetch;
    const chamadas = [];
    globalThis.fetch = async (alvo, opcoes = {}) => {
        const url = String(alvo);
        const api = url.includes('awesomeapi') ? 'awesome' : url.includes('er-api') ? 'exchangerate' : 'outra';
        chamadas.push(api);
        if (atrasoMs[api]) {
            // Como o fetch real: o AbortSignal (timeout) interrompe a espera
            await new Promise((resolve, reject) => {
                const id = setTimeout(resolve, atrasoMs[api]);
                opcoes.signal?.addEventListener('abort', () => {
                    clearTimeout(id);
                    reject(opcoes.signal.reason);
                }, { once: true });
            });
        }
        if (api === 'awesome' && awesome) {
            return { ok: true, json: async () => Object.fromEntries(Object.entries(awesome).map(([m, c]) => [`${m}BRL`, { bid: String(c) }])) };
        }
        if (api === 'exchangerate' && exchangerate) {
            return { ok: true, json: async () => ({ result: 'success', rates: Object.fromEntries(Object.entries(exchangerate).map(([m, c]) => [m, 1 / c])) }) };
        }
        if (api === 'awesome') return { ok: false, status: 429, json: async () => ({}) };
        throw new TypeError('fetch failed');
    };
    return { chamadas, restaurar: () => { globalThis.fetch = fetchOriginal; } };
}

/**
 * Invoca a Azure Function. `apis` simula as APIs de cotação (padrão: as duas fora do ar -> tabela fixa).
 * O cache de cotações é limpo antes de cada chamada, a menos que `manterCache` seja true.
 */
export async function invocarAzure({ method = 'POST', body, query = {}, headers = {}, apis = {}, manterCache = false } = {}) {
    const url = new URL('http://localhost/api/cambio');
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    const request = new az.HttpRequest({
        method,
        url: url.toString(),
        headers,
        body: body === undefined ? undefined : { string: typeof body === 'string' ? body : JSON.stringify(body) }
    });
    const context = new az.InvocationContext({ functionName: 'cambio', logHandler: () => {} });

    if (!manterCache) cambio.limparCacheCotacoes();
    const simulacao = simularApisCotacao(apis);
    try {
        const r = await azureRegistro.handler(request, context);
        return { status: r.status, headers: r.headers, body: r.jsonBody, chamadasApi: simulacao.chamadas };
    } finally {
        simulacao.restaurar();
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
