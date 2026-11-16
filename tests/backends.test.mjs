import { test } from 'node:test';
import assert from 'node:assert/strict';
import { invocarAWS, invocarAzure, invocarGCP, azureRegistrada, cambio, simularApisCotacao } from './helpers.mjs';

const ENTRADA_AWS = { aporteInicial: 10000, aporteMensal: 500, taxaJuros: 0.8, tempoMeses: 24 };

// ---------- AWS ----------

test('AWS: calcula juros compostos e histórico coerente com o montante', async () => {
    const r = await invocarAWS({ body: ENTRADA_AWS });
    assert.equal(r.status, 200);
    assert.equal(r.body.status, 'success');
    const d = r.body.data;
    assert.equal(d.totalInvestido, 22000);
    assert.equal(d.historicoEvolucao.length, 25);
    assert.equal(d.historicoEvolucao[0], 10000);
    // Bug corrigido: o último ponto do gráfico precisa ser igual ao montante do card
    assert.equal(d.historicoEvolucao.at(-1), d.montanteBruto);
    assert.equal(d.totalRendimentos, Math.round((d.montanteBruto - d.totalInvestido) * 100) / 100);
    // Fórmula fechada (aportes no fim do mês): VF = P(1+i)^n + PMT[((1+i)^n - 1)/i]
    const i = 0.008, n = 24;
    const esperado = 10000 * (1 + i) ** n + 500 * (((1 + i) ** n - 1) / i);
    assert.equal(d.montanteBruto, Math.round(esperado * 100) / 100);
});

test('AWS: juros zero devolve exatamente o total investido', async () => {
    const r = await invocarAWS({ body: { ...ENTRADA_AWS, taxaJuros: 0 } });
    assert.equal(r.body.data.montanteBruto, 22000);
    assert.equal(r.body.data.totalRendimentos, 0);
});

test('AWS: informa cold start apenas na primeira invocação', async () => {
    // As outras invocações deste arquivo já aqueceram a instância
    const r = await invocarAWS({ body: ENTRADA_AWS });
    assert.equal(r.body.coldStart, false);
});

test('AWS: 400 para parâmetros inválidos', async () => {
    const casos = [
        [{ ...ENTRADA_AWS, tempoMeses: 1e9 }, 'tempoMeses'],
        [{ ...ENTRADA_AWS, tempoMeses: 2.5 }, 'tempoMeses'],
        [{ ...ENTRADA_AWS, aporteInicial: -1 }, 'aporteInicial'],
        [{ ...ENTRADA_AWS, aporteMensal: 'abc' }, 'aporteMensal'],
        [{ ...ENTRADA_AWS, taxaJuros: 150 }, 'taxaJuros'],
        [{ aporteInicial: 100 }, 'taxaJuros']
    ];
    for (const [body, campo] of casos) {
        const r = await invocarAWS({ body });
        assert.equal(r.status, 400, JSON.stringify(body));
        assert.equal(r.body.erro, 'VALIDACAO');
        assert.ok(r.body.detalhes.some(d => d.campo === campo), `esperava erro em ${campo}`);
    }
});

test('AWS: 400 para JSON malformado e método errado', async () => {
    assert.equal((await invocarAWS({ body: '{quebrado' })).status, 400);
    assert.equal((await invocarAWS({ method: 'GET' })).status, 400);
});

test('AWS: preflight OPTIONS (Function URL / payload 2.0) e CORS', async () => {
    const r = await invocarAWS({ method: 'OPTIONS' });
    assert.equal(r.status, 204);
    assert.equal(r.headers['Access-Control-Allow-Origin'], '*');
});

test('AWS: devolve o requestId enviado no corpo (Function URL não libera o header)', async () => {
    const r = await invocarAWS({ body: { ...ENTRADA_AWS, requestId: 'abc123' } });
    assert.equal(r.body.requestId, 'abc123');
});

test('AWS: aceita corpo em base64 (Function URL)', async () => {
    const { handler } = await import('../aws-lambda/index.js');
    const r = await handler({
        requestContext: { http: { method: 'POST' } },
        isBase64Encoded: true,
        body: Buffer.from(JSON.stringify(ENTRADA_AWS)).toString('base64')
    });
    assert.equal(r.statusCode, 200);
});

test('AWS: ?simularErro=true devolve 500', async () => {
    const erroOriginal = console.error;
    console.error = () => {};
    try {
        const r = await invocarAWS({ body: ENTRADA_AWS, query: { simularErro: 'true' } });
        assert.equal(r.status, 500);
        assert.equal(r.body.erro, 'INTERNO');
    } finally {
        console.error = erroOriginal;
    }
});

// ---------- AZURE (modelo v4: azure-functions/src/functions/cambio.js) ----------

test('Azure: registra POST /api/cambio anônimo', () => {
    assert.equal(azureRegistrada.nome, 'cambio');
    assert.equal(azureRegistrada.route, 'cambio');
    assert.equal(azureRegistrada.authLevel, 'anonymous');
    assert.deepEqual(azureRegistrada.methods, ['POST', 'OPTIONS']);
});

test('Azure: usa cotação ao vivo da AwesomeAPI quando disponível', async () => {
    const r = await invocarAzure({ body: { montanteBRL: 55 }, apis: { awesome: { USD: 5, EUR: 5.5 } } });
    assert.equal(r.status, 200);
    assert.equal(r.body.data.fonte, 'awesomeapi');
    assert.equal(r.body.data.valorUSD, 11);
    assert.equal(r.body.data.valorEUR, 10);
});

test('Azure: AwesomeAPI com 429 -> usa a ExchangeRate-API', async () => {
    const r = await invocarAzure({ body: { montanteBRL: 55 }, apis: { exchangerate: { USD: 5, EUR: 5.5 } } });
    assert.equal(r.body.data.fonte, 'exchangerate-api');
    assert.equal(r.body.data.cotacaoUSD, 5);
    assert.equal(r.body.data.valorEUR, 10);
});

test('Azure: consulta as duas APIs em paralelo e fica com a primeira que responder', async () => {
    const inicio = Date.now();
    const r = await invocarAzure({
        body: { montanteBRL: 55 },
        apis: { awesome: { USD: 9, EUR: 9 }, exchangerate: { USD: 5, EUR: 5.5 }, atrasoMs: { awesome: 1000 } }
    });
    const duracao = Date.now() - inicio;
    assert.deepEqual([...r.chamadasApi].sort(), ['awesome', 'exchangerate']); // as duas disparadas juntas
    assert.equal(r.body.data.fonte, 'exchangerate-api');                         // a rápida venceu
    assert.ok(duracao < 800, `esperou a API lenta: ${duracao} ms`);
});

test('Azure: API lenta (timeout) não atrasa além de ~1,5 s', async () => {
    const inicio = Date.now();
    const r = await invocarAzure({ body: { montanteBRL: 56 }, apis: { atrasoMs: { awesome: 5000, exchangerate: 5000 } } });
    const duracao = Date.now() - inicio;
    assert.equal(r.body.data.fonte, 'tabela-fixa');
    assert.ok(duracao < 2000, `demorou ${duracao} ms`); // antes, em sequência, eram até 3 s
});

test('Azure: cai na tabela fixa se as duas APIs falharem', async () => {
    const r = await invocarAzure({ body: { montanteBRL: 5600 } });
    assert.equal(r.status, 200);
    assert.equal(r.body.data.fonte, 'tabela-fixa');
    assert.equal(r.body.data.valorUSD, 1000);
    assert.equal(r.body.data.valorEUR, Math.round(5600 / 6.10 * 100) / 100);
});

test('Azure: cotação fica em cache e a 2ª requisição não consulta as APIs', async () => {
    const primeira = await invocarAzure({ body: { montanteBRL: 55 }, apis: { awesome: { USD: 5, EUR: 5.5 } } });
    assert.equal(primeira.chamadasApi.length, 2);
    const segunda = await invocarAzure({ body: { montanteBRL: 110, moedas: ['EUR'] }, manterCache: true }); // APIs "fora do ar"
    assert.equal(segunda.chamadasApi.length, 0);
    assert.equal(segunda.body.data.fonte, 'awesomeapi');
    assert.equal(segunda.body.data.valorEUR, 20);
    assert.equal(segunda.body.data.valorUSD, null); // só a moeda pedida
});

test('Azure: cache expira em 5 minutos e falha de API não é guardada', async () => {
    const { buscarCotacoes, limparCacheCotacoes, CACHE_TTL_MS } = cambio;
    limparCacheCotacoes();
    let sim = simularApisCotacao({ exchangerate: { USD: 5, EUR: 6 } });
    try {
        const t0 = 1_000_000;
        assert.equal((await buscarCotacoes(['USD'], t0)).emCache, false);
        assert.equal((await buscarCotacoes(['USD'], t0 + CACHE_TTL_MS - 1)).emCache, true);
        const expirada = await buscarCotacoes(['USD'], t0 + CACHE_TTL_MS);
        assert.equal(expirada.emCache, false);
        assert.equal(sim.chamadas.length, 4); // 2 consultas x 2 APIs
    } finally {
        sim.restaurar();
    }

    limparCacheCotacoes();
    sim = simularApisCotacao(); // tudo fora do ar
    try {
        assert.equal(await buscarCotacoes(['USD']), null);
        assert.equal(await buscarCotacoes(['USD']), null);
        assert.equal(sim.chamadas.length, 4); // tentou de novo: falha não fica em cache
    } finally {
        sim.restaurar();
    }
});

test('Azure: requisições simultâneas compartilham uma única consulta às APIs', async () => {
    const { buscarCotacoes, limparCacheCotacoes } = cambio;
    limparCacheCotacoes();
    const sim = simularApisCotacao({ awesome: { USD: 5, EUR: 6 }, atrasoMs: { awesome: 50 } });
    try {
        const resultados = await Promise.all([buscarCotacoes(['USD']), buscarCotacoes(['EUR']), buscarCotacoes(['USD', 'EUR'])]);
        assert.equal(sim.chamadas.length, 2); // uma por API, não seis
        assert.deepEqual(resultados.map(r => r.fonte), ['awesomeapi', 'awesomeapi', 'awesomeapi']);
        assert.deepEqual(resultados[2].cotacoes, { USD: 5, EUR: 6 });
    } finally {
        sim.restaurar();
    }
});

test('Azure: modo "fixa" nem consulta a API', async () => {
    const r = await invocarAzure({ body: { montanteBRL: 56, modo: 'fixa' }, apis: { awesome: { USD: 1, EUR: 1 } } });
    assert.equal(r.body.data.valorUSD, 10);
    assert.equal(r.chamadasApi.length, 0);
});

test('Azure: 400 para entrada inválida', async () => {
    for (const body of [{}, { montanteBRL: 0 }, { montanteBRL: -5 }, { montanteBRL: 'x' }, { montanteBRL: 1, moedas: ['JPY'] }, { montanteBRL: 1, modo: 'outro' }, '{quebrado']) {
        const r = await invocarAzure({ body });
        assert.equal(r.status, 400, JSON.stringify(body));
        assert.equal(r.body.erro, 'VALIDACAO');
    }
});

test('Azure: OPTIONS 204, ?simularErro=true 500, requestId e cold start', async () => {
    assert.equal((await invocarAzure({ method: 'OPTIONS' })).status, 204);
    const erro = await invocarAzure({ body: { montanteBRL: 100 }, query: { simularErro: 'true' }, headers: { 'x-request-id': 'req1' } });
    assert.equal(erro.status, 500);
    assert.equal(erro.body.erro, 'INTERNO');
    assert.equal(erro.body.requestId, 'req1');
    const ok = await invocarAzure({ body: { montanteBRL: 100 } });
    assert.equal(ok.body.coldStart, false); // instância já aquecida pelos testes anteriores
    assert.equal(ok.headers['Access-Control-Allow-Origin'], '*');
});

// ---------- GCP ----------

test('GCP: projeta inflação e ganho real', async () => {
    const r = await invocarGCP({ body: { montanteBruto: 25000, totalInvestido: 22000, taxaInflacao: 4.5, tempoMeses: 24 } });
    assert.equal(r.status, 200);
    const d = r.body.data;
    assert.equal(d.taxaInflacaoAcumulada, Math.round((1.045 ** 2 - 1) * 10000) / 100);
    assert.equal(d.montanteReal, Math.round(25000 / 1.045 ** 2 * 100) / 100);
    assert.equal(typeof r.body.coldStart, 'boolean');
});

test('GCP: 400 com detalhes por campo', async () => {
    const r = await invocarGCP({ body: { montanteBruto: 0, tempoMeses: 700 } });
    assert.equal(r.status, 400);
    const campos = r.body.detalhes.map(d => d.campo).sort();
    assert.deepEqual(campos, ['montanteBruto', 'tempoMeses']);
});

test('GCP: OPTIONS 204, GET 400 e ?simularErro=true 500', async () => {
    assert.equal((await invocarGCP({ method: 'OPTIONS' })).status, 204);
    assert.equal((await invocarGCP({ method: 'GET' })).status, 400);
    const r = await invocarGCP({ body: { montanteBruto: 1, tempoMeses: 1 }, query: { simularErro: 'true' } });
    assert.equal(r.status, 500);
});
