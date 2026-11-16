// Garante que o cálculo local do navegador (fallback) continua idêntico às funções na nuvem.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { invocarAWS, invocarAzure, invocarGCP } from './helpers.mjs';

const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');

function extrairScript(id) {
    const m = html.match(new RegExp(`<script id="${id}">([\\s\\S]*?)</script>`));
    assert.ok(m, `script #${id} não encontrado no index.html`);
    return m[1];
}

const local = new Function(`${extrairScript('calculos-locais')}; return { calcAWSLocal, calcAzureLocal, calcGCPLocal };`)();

const CENARIOS = [
    [10000, 500, 0.8, 24, 4.5],
    [0, 100, 1, 1, 0],
    [1234.56, 0, 0, 12, 10],
    [50000, 2500, 1.5, 360, 6.2],
    [1, 1, 99.9, 600, -2]
];

test('script principal da página não tem erro de sintaxe', () => {
    assert.doesNotThrow(() => new Function(extrairScript('app')));
});

for (const [aporteInicial, aporteMensal, taxaJuros, tempoMeses, taxaInflacao] of CENARIOS) {
    test(`paridade local x nuvem: ${JSON.stringify({ aporteInicial, aporteMensal, taxaJuros, tempoMeses, taxaInflacao })}`, async () => {
        const aws = await invocarAWS({ body: { aporteInicial, aporteMensal, taxaJuros, tempoMeses } });
        assert.deepEqual(local.calcAWSLocal(aporteInicial, aporteMensal, taxaJuros, tempoMeses), aws.body.data);

        const { montanteBruto, totalInvestido } = aws.body.data;
        const azure = await invocarAzure({ body: { montanteBRL: montanteBruto } });
        assert.deepEqual(local.calcAzureLocal(montanteBruto), azure.body.data);

        const gcp = await invocarGCP({ body: { montanteBruto, totalInvestido, taxaInflacao, tempoMeses } });
        assert.deepEqual(local.calcGCPLocal(montanteBruto, totalInvestido, taxaInflacao, tempoMeses), gcp.body.data);
    });
}
