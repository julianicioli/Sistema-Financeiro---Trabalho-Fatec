import { app } from '@azure/functions';
import { converter } from '../cambio.js';

// HTTP Trigger anônimo: POST /api/cambio
const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, X-Request-Id',
    'Access-Control-Allow-Methods': 'OPTIONS,POST'
};

// Fica true só na primeira invocação de cada instância (cold start real)
let coldStart = true;

app.http('cambio', {
    methods: ['POST', 'OPTIONS'],
    authLevel: 'anonymous',
    route: 'cambio',
    handler: async (request, context) => {
        const eraColdStart = coldStart;
        coldStart = false;
        const requestId = request.headers.get('x-request-id');

        if (request.method === 'OPTIONS') {
            return { status: 204, headers: CORS };
        }

        try {
            let body = {};
            const texto = await request.text();
            if (texto) {
                try {
                    body = JSON.parse(texto);
                } catch {
                    return {
                        status: 400,
                        headers: CORS,
                        jsonBody: { status: 'error', erro: 'VALIDACAO', detalhes: [{ campo: 'body', mensagem: 'JSON inválido' }], requestId }
                    };
                }
            }

            const resultado = await converter(body, {
                simularErro: request.query.get('simularErro') === 'true',
                requestId,
                regiao: process.env.REGION_NAME || 'Azure'
            });
            context.log(`[cambio] requestId=${requestId} status=${resultado.status}`);
            if (resultado.status === 200) resultado.body.coldStart = eraColdStart;
            return { status: resultado.status, headers: CORS, jsonBody: resultado.body };
        } catch (error) {
            context.error(`[cambio] requestId=${requestId}`, error);
            return {
                status: 500,
                headers: CORS,
                jsonBody: { status: 'error', erro: 'INTERNO', mensagem: error.message, requestId }
            };
        }
    }
});
