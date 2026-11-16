// Função 1 (AWS Lambda): Calculadora de Juros Compostos — exposta por Lambda Function URL (auth NONE).
// POST { aporteInicial, aporteMensal, taxaJuros, tipoTaxa?: "mensal" | "anual", tempoMeses }
// 200 = sucesso | 400 = parâmetros inválidos | 500 = falha interna (?simularErro=true força)
// Aporte mensal no fim de cada mês: M = P(1+i)^n + A[(1+i)^n - 1] / i

const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, X-Request-Id',
    'Access-Control-Allow-Methods': 'OPTIONS,POST',
    'Content-Type': 'application/json'
};

const arredondar = (n, casas = 2) => Math.round(n * 10 ** casas) / 10 ** casas;

function resposta(statusCode, corpo) {
    return { statusCode, headers: CORS, body: JSON.stringify(corpo) };
}

function lerNumero(body, campo) {
    const valor = body[campo];
    if (valor === undefined || valor === null || valor === '') return undefined;
    return Number(valor);
}

export function validar(body) {
    const detalhes = [];
    const aporteInicial = lerNumero(body, 'aporteInicial') ?? 0;
    const aporteMensal = lerNumero(body, 'aporteMensal') ?? 0;
    const taxaJuros = lerNumero(body, 'taxaJuros');
    const tempoMeses = lerNumero(body, 'tempoMeses');
    const tipoTaxa = body.tipoTaxa ?? 'mensal';

    if (!Number.isFinite(aporteInicial) || aporteInicial < 0) {
        detalhes.push({ campo: 'aporteInicial', mensagem: 'deve ser um número maior ou igual a 0' });
    }
    if (!Number.isFinite(aporteMensal) || aporteMensal < 0) {
        detalhes.push({ campo: 'aporteMensal', mensagem: 'deve ser um número maior ou igual a 0' });
    }
    if (taxaJuros === undefined) {
        detalhes.push({ campo: 'taxaJuros', mensagem: 'é obrigatório' });
    } else if (!Number.isFinite(taxaJuros) || taxaJuros < 0 || taxaJuros > 100) {
        detalhes.push({ campo: 'taxaJuros', mensagem: 'deve estar entre 0 e 100 (%)' });
    }
    if (tempoMeses === undefined) {
        detalhes.push({ campo: 'tempoMeses', mensagem: 'é obrigatório' });
    } else if (!Number.isInteger(tempoMeses) || tempoMeses < 1 || tempoMeses > 600) {
        detalhes.push({ campo: 'tempoMeses', mensagem: 'deve ser um inteiro entre 1 e 600' });
    }
    if (!['mensal', 'anual'].includes(tipoTaxa)) {
        detalhes.push({ campo: 'tipoTaxa', mensagem: 'deve ser "mensal" ou "anual"' });
    }
    if (detalhes.length === 0 && aporteInicial === 0 && aporteMensal === 0) {
        detalhes.push({ campo: 'aporteInicial', mensagem: 'informe aporte inicial ou mensal maior que 0' });
    }

    return { detalhes, aporteInicial, aporteMensal, taxaJuros, tempoMeses, tipoTaxa };
}

export function calcular({ aporteInicial, aporteMensal, taxaJuros, tempoMeses, tipoTaxa }) {
    // Taxa anual vira a taxa mensal equivalente: (1 + a)^(1/12) - 1
    const i = tipoTaxa === 'anual' ? Math.pow(1 + taxaJuros / 100, 1 / 12) - 1 : taxaJuros / 100;

    let saldo = aporteInicial;
    const historico = [arredondar(aporteInicial)];
    for (let m = 1; m <= tempoMeses; m++) {
        saldo = saldo * (1 + i) + aporteMensal;
        historico.push(arredondar(saldo));
    }

    const totalInvestido = aporteInicial + aporteMensal * tempoMeses;
    return {
        montanteBruto: arredondar(saldo),
        totalInvestido: arredondar(totalInvestido),
        totalRendimentos: arredondar(saldo - totalInvestido),
        taxaMensal: arredondar(i * 100, 4),
        historicoEvolucao: historico
    };
}

export const handler = async (event) => {
    // Function URL usa o formato 2.0 (requestContext.http.method); API Gateway REST usa httpMethod
    const metodo = event?.requestContext?.http?.method || event?.httpMethod || 'POST';
    const headers = event?.headers || {};
    const requestId = headers['x-request-id'] || headers['X-Request-Id'] || null;

    if (metodo === 'OPTIONS') {
        return { statusCode: 204, headers: CORS, body: '' };
    }
    if (metodo !== 'POST') {
        return resposta(400, { status: 'error', erro: 'VALIDACAO', detalhes: [{ campo: 'method', mensagem: 'use POST com corpo JSON' }], requestId });
    }

    try {
        if (event?.queryStringParameters?.simularErro === 'true') {
            throw new Error('Falha simulada (simularErro=true)');
        }

        let body = {};
        if (event?.body) {
            const texto = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
            try {
                body = JSON.parse(texto);
            } catch {
                return resposta(400, { status: 'error', erro: 'VALIDACAO', detalhes: [{ campo: 'body', mensagem: 'JSON inválido' }], requestId });
            }
        }

        const entrada = validar(body);
        if (entrada.detalhes.length > 0) {
            return resposta(400, { status: 'error', erro: 'VALIDACAO', detalhes: entrada.detalhes, requestId: requestId || body.requestId || null });
        }

        console.log(JSON.stringify({ requestId: requestId || body.requestId, tempoMeses: entrada.tempoMeses }));
        return resposta(200, {
            status: 'success',
            provider: `AWS Lambda (${process.env.AWS_REGION || 'aws'})`,
            data: calcular(entrada),
            requestId: requestId || body.requestId || null
        });
    } catch (error) {
        console.error('[juros-compostos]', requestId, error);
        return resposta(500, { status: 'error', erro: 'INTERNO', mensagem: error.message, requestId });
    }
};
