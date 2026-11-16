import { test } from 'node:test';
import assert from 'node:assert/strict';
import { invocarAWS, invocarAzure, invocarGCP, azureRegistrada } from './helpers.mjs';

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
    const r = await invocarAzure({ body: { montanteBRL: 55 }, cotacaoAoVivo: { USD: 5, EUR: 5.5 } });
    assert.equal(r.status, 200);
    assert.equal(r.body.data.fonte, 'awesomeapi');
    assert.equal(r.body.data.valorUSD, 11);
    assert.equal(r.body.data.valorEUR, 10);
    assert.match(r.chamadasApi[0], /USD-BRL,EUR-BRL$/);
});

test('Azure: cai na tabela fixa se a AwesomeAPI falhar', async () => {
    const r = await invocarAzure({ body: { montanteBRL: 5600 } });
    assert.equal(r.status, 200);
    assert.equal(r.body.data.fonte, 'tabela-fixa');
    assert.equal(r.body.data.valorUSD, 1000);
    assert.equal(r.body.data.valorEUR, Math.round(5600 / 6.10 * 100) / 100);
});

test('Azure: modo "fixa" nem consulta a API', async () => {
    const r = await invocarAzure({ body: { montanteBRL: 56, modo: 'fixa' }, cotacaoAoVivo: { USD: 1, EUR: 1 } });
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
