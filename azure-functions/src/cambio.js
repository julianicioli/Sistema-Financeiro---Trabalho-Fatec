// Função 2 (Azure): Conversor de Câmbio Internacional — lógica pura, sem dependência do runtime.
// POST { montanteBRL, moedas?: ["USD","EUR"], modo?: "api" | "fixa" }
// 200 = sucesso | 400 = parâmetros inválidos | 500 = falha interna (?simularErro=true força)

// Tabela de reserva, usada com modo "fixa" ou quando a API pública falha
export const TABELA_FIXA = { USD: 5.60, EUR: 6.10 };
const MOEDAS_ACEITAS = ['USD', 'EUR'];
const MODOS_ACEITOS = ['api', 'fixa'];
const API_COTACAO = 'https://economia.awesomeapi.com.br/json/last/';
// Segunda fonte pública (sem chave). A AwesomeAPI costuma responder 429 para IPs de nuvem compartilhados.
const API_COTACAO_RESERVA = 'https://open.er-api.com/v6/latest/BRL';

const arredondar = (n, casas = 2) => Math.round(n * 10 ** casas) / 10 ** casas;

export function validar(body) {
    const detalhes = [];
    const bruto = body.montanteBRL ?? body.valorBRL;
    const montanteBRL = (bruto === undefined || bruto === null || bruto === '') ? undefined : Number(bruto);
    const moedas = body.moedas ?? MOEDAS_ACEITAS;
    const modo = body.modo ?? 'api';

    if (montanteBRL === undefined) {
        detalhes.push({ campo: 'montanteBRL', mensagem: 'é obrigatório' });
    } else if (!Number.isFinite(montanteBRL) || montanteBRL <= 0) {
        detalhes.push({ campo: 'montanteBRL', mensagem: 'deve ser um número maior que 0' });
    }

    if (!Array.isArray(moedas) || moedas.length === 0 || moedas.some(m => !MOEDAS_ACEITAS.includes(m))) {
        detalhes.push({ campo: 'moedas', mensagem: `aceita apenas ${MOEDAS_ACEITAS.join(' e ')}` });
    }

    if (!MODOS_ACEITOS.includes(modo)) {
        detalhes.push({ campo: 'modo', mensagem: 'deve ser "api" ou "fixa"' });
    }

    return { detalhes, montanteBRL, moedas, modo };
}

// Tenta as APIs públicas em ordem; devolve { cotacoes, fonte } ou null se nenhuma responder.
export async function buscarCotacoes(moedas) {
    const awesome = await buscarAwesomeApi(moedas);
    if (awesome) return { cotacoes: awesome, fonte: 'awesomeapi' };
    const reserva = await buscarExchangeRateApi(moedas);
    if (reserva) return { cotacoes: reserva, fonte: 'exchangerate-api' };
    return null;
}

// ExchangeRate-API (open access): taxas a partir do BRL; a cotação em reais é 1 / taxa.
export async function buscarExchangeRateApi(moedas, timeoutMs = 1500) {
    try {
        const res = await fetch(API_COTACAO_RESERVA, { signal: AbortSignal.timeout(timeoutMs) });
        if (!res.ok) return null;
        const json = await res.json();
        const cotacoes = {};
        for (const m of moedas) {
            const taxa = Number(json?.rates?.[m]);
            if (!Number.isFinite(taxa) || taxa <= 0) return null;
            cotacoes[m] = arredondar(1 / taxa, 4);
        }
        return cotacoes;
    } catch {
        return null;
    }
}

// AwesomeAPI (pública, sem chave). Em qualquer falha devolve null.
export async function buscarAwesomeApi(moedas, timeoutMs = 1500) {
    try {
        const pares = moedas.map(m => `${m}-BRL`).join(',');
        const res = await fetch(API_COTACAO + pares, { signal: AbortSignal.timeout(timeoutMs) });
        if (!res.ok) return null;
        const json = await res.json();
        const cotacoes = {};
        for (const m of moedas) {
            const bid = Number(json[`${m}BRL`]?.bid);
            if (!Number.isFinite(bid) || bid <= 0) return null;
            cotacoes[m] = arredondar(bid, 4);
        }
        return cotacoes;
    } catch {
        return null;
    }
}

export async function converter(body, { simularErro = false, requestId = null, regiao = 'Azure' } = {}) {
    if (simularErro) {
        throw new Error('Falha simulada (simularErro=true)');
    }

    const { detalhes, montanteBRL, moedas, modo } = validar(body || {});
    if (detalhes.length > 0) {
        return { status: 400, body: { status: 'error', erro: 'VALIDACAO', detalhes, requestId } };
    }

    let cotacoes = null;
    let fonte = 'tabela-fixa';
    if (modo === 'api') {
        const resultado = await buscarCotacoes(moedas);
        if (resultado) ({ cotacoes, fonte } = resultado);
    }
    if (!cotacoes) {
        cotacoes = Object.fromEntries(moedas.map(m => [m, TABELA_FIXA[m]]));
    }

    const conversoes = Object.fromEntries(
        moedas.map(m => [m, { cotacao: cotacoes[m], valor: arredondar(montanteBRL / cotacoes[m]) }])
    );

    return {
        status: 200,
        body: {
            status: 'success',
            provider: `Azure Functions (${regiao})`,
            data: {
                valorBRL: arredondar(montanteBRL),
                valorUSD: conversoes.USD?.valor ?? null,
                valorEUR: conversoes.EUR?.valor ?? null,
                cotacaoUSD: conversoes.USD?.cotacao ?? null,
                cotacaoEUR: conversoes.EUR?.cotacao ?? null,
                conversoes,
                fonte
            },
            requestId
        }
    };
}
