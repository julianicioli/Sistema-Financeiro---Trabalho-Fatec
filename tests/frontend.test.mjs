// Roda o index.html de verdade (jsdom) com um fetch falso que encaminha cada requisição
// para a função serverless correspondente. Testa o fluxo completo: cascata AWS -> Azure/GCP,
// fallback, erros 400, modo mock, gráfico e descarte de execuções antigas.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { invocarAWS, invocarAzure, invocarGCP } from './helpers.mjs';

const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');

const ROTAS = {
    'aws.test': invocarAWS,
    'azure.test': invocarAzure,
    'gcp.test': invocarGCP
};

let dom, win, chamadas, redeQuebrada, atrasoMs;

async function criarPagina() {
    chamadas = [];
    redeQuebrada = new Set();
    atrasoMs = {};
    dom = new JSDOM(html, {
        runScripts: 'dangerously', // executa só os scripts inline; CDNs externas não são baixadas
        pretendToBeVisual: true,
        beforeParse(window) {
            window.tailwind = {};
            window.lucide = { createIcons() {} };
            window.HTMLCanvasElement.prototype.getContext = () => ({});
            window.Chart = class {
                constructor(_ctx, cfg) { this.data = cfg.data; this.options = cfg.options; }
                update() {}
            };
            window.fetch = async (url, opts) => {
                const u = new URL(url);
                chamadas.push({ host: u.host, simularErro: u.searchParams.get('simularErro'), body: JSON.parse(opts.body) });
                if (atrasoMs[u.host]) await new Promise(r => setTimeout(r, atrasoMs[u.host]));
                if (redeQuebrada.has(u.host)) throw new TypeError('Failed to fetch');
                const r = await ROTAS[u.host]({
                    method: opts.method,
                    body: JSON.parse(opts.body),
                    query: Object.fromEntries(u.searchParams)
                });
                return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body };
            };
        }
    });
    win = dom.window;
    // Aponta a página para as "nuvens" falsas
    win.eval(`endpoints.aws = 'https://aws.test/'; endpoints.azure = 'https://azure.test/api/conversorCambio?code=abc'; endpoints.gcp = 'https://gcp.test/';`);
    // Espera a execução automática do carregamento terminar antes de cada teste
    const inicio = Date.now();
    while (win.eval('execucaoAtual') < 1 || $('btnRun').disabled) {
        if (Date.now() - inicio > 3000) throw new Error('execução inicial não terminou');
        await new Promise(r => setTimeout(r, 10));
    }
    chamadas.length = 0;
}

const $ = (id) => win.document.getElementById(id);
const texto = (id) => $(id).innerText;
const rodar = () => win.eval('runMulticloudSimulation()');
const json = (cloud) => JSON.parse(texto(`${cloud}JsonDisplay`));
const grafico = () => win.eval('chartInstance').data.datasets;
const brl = (v) => win.eval(`formatBRL(${v})`);

function preencher(valores) {
    for (const [id, v] of Object.entries(valores)) $(id).value = String(v);
}

beforeEach(async () => { await criarPagina(); });

test('modo real: as três nuvens respondem 200 e os valores batem com as funções', async () => {
    await rodar();

    for (const id of ['AWS', 'Azure', 'GCP']) assert.equal(texto(`badge${id}`), '200 OK', id);
    assert.equal(texto('awsStatusDisplay'), 'HTTP 200 OK');

    const aws = (await invocarAWS({ body: { aporteInicial: 10000, aporteMensal: 500, taxaJuros: 0.8, tempoMeses: 24 } })).body.data;
    assert.equal(texto('valMontanteBruto'), brl(aws.montanteBruto));

    // Azure e GCP recebem o montante calculado pela AWS
    const azureReq = chamadas.find(c => c.host === 'azure.test');
    assert.equal(azureReq.body.montanteBRL, aws.montanteBruto);
    const gcpReq = chamadas.find(c => c.host === 'gcp.test');
    assert.deepEqual(gcpReq.body, { montanteBruto: aws.montanteBruto, totalInvestido: aws.totalInvestido, taxaInflacao: 4.5, tempoMeses: 24 });

    // Gráfico: último ponto = card (bug do montante divergente corrigido)
    const [bruto, ipca, investido] = grafico();
    assert.equal(bruto.data.at(-1), aws.montanteBruto);
    assert.equal(investido.data.at(-1), 22000);
    assert.ok(Math.abs(ipca.data.at(-1) - json('gcp').data.montanteReal) <= 0.01);
    assert.equal($('btnRun').disabled, false);
});

test('falha forçada na AWS: chama ?simularErro=true, recebe 500 e ativa fallback visível', async () => {
    $('failAWS').checked = true;
    await rodar();

    const req = chamadas.find(c => c.host === 'aws.test');
    assert.equal(req.simularErro, 'true');
    assert.equal(texto('badgeAWS'), 'Fallback Local');   // antes aparecia "200 OK"
    assert.equal(texto('awsStatusDisplay'), 'HTTP 500 Internal Error');
    const corpo = json('aws');
    assert.equal(corpo.status, 'fallback');
    assert.equal(corpo.respostaNuvem.erro, 'INTERNO');

    // O fallback calcula o montante com a taxa do usuário e as outras nuvens seguem funcionando
    const esperado = (await invocarAWS({ body: { aporteInicial: 10000, aporteMensal: 500, taxaJuros: 0.8, tempoMeses: 24 } })).body.data;
    assert.equal(texto('valMontanteBruto'), brl(esperado.montanteBruto));
    assert.equal(texto('badgeAzure'), '200 OK');
    assert.equal(texto('badgeGCP'), '200 OK');
});

test('fallback usa a taxa digitada (não mais 0,8% fixo) quando a AWS falha', async () => {
    preencher({ taxaJuros: 2 });
    $('failAWS').checked = true;
    await rodar();
    const esperado = (await invocarAWS({ body: { aporteInicial: 10000, aporteMensal: 500, taxaJuros: 2, tempoMeses: 24 } })).body.data;
    assert.deepEqual([...grafico()[0].data], esperado.historicoEvolucao);
});

test('falha de rede na GCP: fallback sem status HTTP, demais nuvens intactas', async () => {
    redeQuebrada.add('gcp.test');
    await rodar();
    assert.equal(texto('badgeGCP'), 'Fallback Local');
    assert.equal(texto('gcpStatusDisplay'), 'Sem resposta (rede/timeout)');
    assert.equal(json('gcp').motivoFallback, 'Failed to fetch');
    assert.notEqual(texto('valMontanteReal'), 'Serviço Indisponível');
    assert.equal(texto('badgeAWS'), '200 OK');
    assert.equal(texto('badgeAzure'), '200 OK');
});

test('erro 400 de validação é exibido (não é mascarado por fallback)', async () => {
    preencher({ aporteInicial: 0, aporteMensal: 0 }); // montante 0 -> GCP exige > 0
    await rodar();
    assert.equal(texto('badgeGCP'), '400 Inválido');
    assert.equal(texto('gcpStatusDisplay'), 'HTTP 400 Bad Request');
    assert.equal(json('gcp').detalhes[0].campo, 'montanteBruto');
    assert.equal(texto('valMontanteReal'), 'Serviço Indisponível');
    assert.equal(grafico()[1].data.length, 0); // curva IPCA some quando a GCP não respondeu
});

test('400 na AWS interrompe a cascata com mensagem de dependência', async () => {
    preencher({ taxaJuros: 150 }); // acima do limite da AWS (0 a 100)
    await rodar();
    assert.equal(texto('badgeAWS'), '400 Inválido');
    assert.equal(texto('badgeAzure'), 'Indisponível');
    assert.equal(json('azure').erro, 'DEPENDENCIA');
    assert.equal(chamadas.filter(c => c.host !== 'aws.test').length, 0);
});

test('endpoint vazio no modo real: cálculo local identificado como tal', async () => {
    win.eval(`endpoints.azure = ''`);
    await rodar();
    assert.equal(texto('badgeAzure'), 'Local (sem endpoint)');
    assert.equal(texto('azureStatusDisplay'), 'Sem requisição HTTP');
    assert.equal(texto('typeAzure'), 'Local');
});

test('modo mock: nenhuma requisição HTTP; falha forçada vira fallback', async () => {
    win.eval(`setExecutionMode('mock')`);
    chamadas.length = 0;
    $('failAzure').checked = true;
    await rodar();
    assert.equal(chamadas.length, 0);
    assert.equal(texto('badgeAWS'), 'Local (mock)');
    assert.equal(texto('badgeAzure'), 'Fallback Local');
});

test('cold start vem da própria função', async () => {
    await rodar();
    assert.match(texto('typeAWS'), /^(Cold|Warm) Start$/);
    assert.equal(texto('typeAWS'), json('aws').coldStart ? 'Cold Start' : 'Warm Start');
});

test('execução antiga não sobrescreve a mais nova', async () => {
    atrasoMs['aws.test'] = 200;
    const primeira = rodar();          // taxa 0,8% (lenta)
    await new Promise(r => setTimeout(r, 20));
    atrasoMs['aws.test'] = 0;
    preencher({ taxaJuros: 3 });
    const segunda = rodar();           // taxa 3% (rápida)
    await Promise.all([primeira, segunda]);
    assert.equal(json('aws').data.montanteBruto,
        (await invocarAWS({ body: { aporteInicial: 10000, aporteMensal: 500, taxaJuros: 3, tempoMeses: 24 } })).body.data.montanteBruto);
});

test('modal de endpoints é preenchido a partir da configuração e salva alterações', async () => {
    win.eval('toggleEndpointModal(true)');
    assert.equal($('endpointAWS').value, 'https://aws.test/');
    $('endpointAzure').value = '  https://azure.test/novo  ';
    win.eval('saveEndpoints()');
    assert.equal(win.eval('endpoints.azure'), 'https://azure.test/novo');
    assert.ok($('endpointModal').classList.contains('hidden'));
});
