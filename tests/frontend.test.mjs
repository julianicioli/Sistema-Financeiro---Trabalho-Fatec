// Roda o index.html de verdade (jsdom) com um fetch falso que encaminha cada requisição
// para a função serverless correspondente. Testa o fluxo completo: cascata AWS -> Azure/GCP,
// fallback, erros 400, modo mock, "Tentar de novo", métricas, gráfico e descarte de execuções antigas.
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

const ENTRADA_PADRAO = { aporteInicial: 10000, aporteMensal: 500, taxaJuros: 0.8, tempoMeses: 24 };

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
                const headers = Object.fromEntries(Object.entries(opts.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
                chamadas.push({ host: u.host, simularErro: u.searchParams.get('simularErro'), body: JSON.parse(opts.body), headers });
                if (atrasoMs[u.host]) await new Promise(r => setTimeout(r, atrasoMs[u.host]));
                if (redeQuebrada.has(u.host)) throw new TypeError('Failed to fetch');
                const rota = ROTAS[u.host];
                if (!rota) throw new TypeError('Failed to fetch');
                const r = await rota({
                    method: opts.method,
                    body: JSON.parse(opts.body),
                    query: Object.fromEntries(u.searchParams),
                    headers
                });
                return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body };
            };
        }
    });
    win = dom.window;
    // Aponta a página para as "nuvens" falsas
    win.eval(`endpoints.aws = 'https://aws.test/'; endpoints.azure = 'https://azure.test/api/cambio'; endpoints.gcp = 'https://gcp.test/';`);
    // Espera a execução automática do carregamento terminar antes de cada teste
    const inicio = Date.now();
    while (!win.eval('lastRun') || $('btnRun').disabled) {
        if (Date.now() - inicio > 5000) throw new Error('execução inicial não terminou');
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
const visivel = (id) => !$(id).classList.contains('hidden');
const awsEsperado = async (entrada = {}) => (await invocarAWS({ body: { ...ENTRADA_PADRAO, ...entrada } })).body.data;

function preencher(valores) {
    for (const [id, v] of Object.entries(valores)) $(id).value = String(v);
}

beforeEach(async () => { await criarPagina(); });

test('modo real: as três nuvens respondem 200 e os valores batem com as funções', async () => {
    await rodar();

    for (const id of ['AWS', 'Azure', 'GCP']) {
        assert.equal(texto(`badge${id}`), '200 OK', id);
        assert.equal(visivel(`warn${id}`), false, id);
        assert.equal(visivel(`retry${id}`), false, id);
    }
    assert.equal(texto('awsStatusDisplay'), 'HTTP 200 OK');
    assert.equal($('fonteCambio').textContent, 'Tabela fixa (reserva)'); // APIs de cotação simuladas fora do ar

    const aws = await awsEsperado();
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

test('card da Azure mostra a fonte da cotação com a atribuição da ExchangeRate-API', async () => {
    ROTAS['azure.test'] = (req) => invocarAzure({ ...req, apis: { exchangerate: { USD: 5, EUR: 6 } } });
    try {
        await rodar();
    } finally {
        ROTAS['azure.test'] = invocarAzure;
    }
    const link = $('fonteCambio').querySelector('a');
    assert.equal(link.textContent, 'Rates By Exchange Rate API');
    assert.equal(link.href, 'https://www.exchangerate-api.com/');
    assert.equal(texto('valCambio'), '1 USD = R$ 5.00');

    $('failAzure').checked = true; // fallback local usa a tabela fixa
    await rodar();
    assert.equal($('fonteCambio').textContent, 'Tabela fixa (reserva)');
});

test('X-Request-Id: AWS recebe no corpo; Azure e GCP no header; o mesmo id nas três', async () => {
    await rodar();
    const id = texto('lastRequestId');
    assert.match(id, /^[a-z0-9]{12}$/i);
    assert.equal(chamadas.find(c => c.host === 'aws.test').body.requestId, id);
    assert.equal(chamadas.find(c => c.host === 'azure.test').headers['x-request-id'], id);
    assert.equal(chamadas.find(c => c.host === 'gcp.test').headers['x-request-id'], id);
    assert.equal(json('aws').requestId, id);
    assert.equal(json('gcp').requestId, id);
});

test('taxa ao ano é convertida para a taxa mensal equivalente', async () => {
    preencher({ taxaJuros: 12 });
    $('tipoTaxa').value = 'anual';
    await rodar();
    const enviada = chamadas.find(c => c.host === 'aws.test').body.taxaJuros;
    assert.ok(Math.abs(enviada - (Math.pow(1.12, 1 / 12) - 1) * 100) < 1e-5, String(enviada));
});

test('falha forçada na AWS: chama ?simularErro=true, recebe 500 e ativa fallback visível', async () => {
    $('failAWS').checked = true;
    await rodar();

    const req = chamadas.find(c => c.host === 'aws.test');
    assert.equal(req.simularErro, 'true');
    assert.equal(texto('badgeAWS'), 'Fallback local');
    assert.equal(texto('awsStatusDisplay'), 'Fallback local · HTTP 500');
    assert.ok(visivel('warnAWS'));
    assert.ok(visivel('retryAWS'));
    const corpo = json('aws');
    assert.equal(corpo.status, 'fallback');
    assert.equal(corpo.respostaNuvem.erro, 'INTERNO');

    // O fallback calcula o mesmo montante e as outras nuvens seguem funcionando
    assert.equal(texto('valMontanteBruto'), brl((await awsEsperado()).montanteBruto));
    assert.equal(texto('badgeAzure'), '200 OK');
    assert.equal(texto('badgeGCP'), '200 OK');
});

test('fallback usa a taxa digitada (não mais 0,8% fixo) quando a AWS falha', async () => {
    preencher({ taxaJuros: 2 });
    $('failAWS').checked = true;
    await rodar();
    assert.deepEqual([...grafico()[0].data], (await awsEsperado({ taxaJuros: 2 })).historicoEvolucao);
});

test('falha de rede na GCP: fallback, demais nuvens intactas e "Tentar de novo" refaz só a GCP', async () => {
    redeQuebrada.add('gcp.test');
    await rodar();
    assert.equal(texto('badgeGCP'), 'Fallback local');
    assert.equal(texto('gcpStatusDisplay'), 'Fallback local · Failed to fetch');
    assert.notEqual(texto('valMontanteReal'), 'Serviço Indisponível');
    assert.equal(texto('badgeAWS'), '200 OK');
    assert.equal(texto('badgeAzure'), '200 OK');

    redeQuebrada.clear();
    chamadas.length = 0;
    await win.eval(`tentarDeNovo('gcp')`);
    assert.deepEqual(chamadas.map(c => c.host), ['gcp.test']);
    assert.equal(texto('badgeGCP'), '200 OK');
    assert.equal(visivel('retryGCP'), false);
});

test('erro 400 de validação é exibido (não é mascarado por fallback)', async () => {
    preencher({ aporteInicial: 0, aporteMensal: 0 }); // montante 0 -> Azure e GCP exigem > 0
    await rodar();
    assert.equal(texto('badgeGCP'), '400 Inválido');
    assert.equal(texto('gcpStatusDisplay'), 'HTTP 400 Bad Request');
    assert.equal(json('gcp').detalhes[0].campo, 'montanteBruto');
    assert.equal(texto('valMontanteReal'), 'Serviço Indisponível');
    assert.equal(texto('badgeAzure'), '400 Inválido');
    assert.equal(visivel('warnGCP'), false);
    assert.equal(grafico()[1].data.length, 0); // curva IPCA some quando a GCP não respondeu
});

test('400 na AWS interrompe a cascata com mensagem de dependência', async () => {
    preencher({ taxaJuros: 150 }); // acima do limite da AWS (0 a 100)
    await rodar();
    assert.equal(texto('badgeAWS'), '400 Inválido');
    assert.equal(texto('badgeAzure'), 'Indisponível');
    assert.equal(json('azure').erro, 'DEPENDENCIA');
    assert.equal(texto('gcpStatusDisplay'), 'Não executada');
    assert.equal(chamadas.filter(c => c.host !== 'aws.test').length, 0);
    assert.equal(grafico()[0].data.length, 0);
});

test('endpoint vazio no modo real: fallback local com o motivo', async () => {
    win.eval(`endpoints.azure = ''`);
    await rodar();
    assert.equal(texto('badgeAzure'), 'Fallback local');
    assert.equal(texto('azureStatusDisplay'), 'Fallback local · URL da função não configurada');
    assert.equal(texto('typeAzure'), 'Local');
});

test('modo mock: nenhuma requisição HTTP; falha forçada vira fallback', async () => {
    win.eval(`setExecutionMode('mock')`);
    chamadas.length = 0;
    $('failAzure').checked = true;
    await rodar();
    assert.equal(chamadas.length, 0);
    assert.equal(texto('badgeAWS'), 'Mock OK');
    assert.equal(texto('typeAWS'), 'Mock');
    assert.equal(texto('badgeAzure'), 'Fallback local');
});

test('cold/warm vem da própria função', async () => {
    await rodar();
    for (const [cloud, id] of [['aws', 'AWS'], ['azure', 'Azure'], ['gcp', 'GCP']]) {
        assert.equal(typeof json(cloud).coldStart, 'boolean', cloud);
        assert.equal(texto(`type${id}`), json(cloud).coldStart ? 'Cold Start' : 'Warm Start', cloud);
    }
});

test('painel de métricas registra cada chamada com resultado e latência', async () => {
    win.eval('limparMetricas()');
    $('failGCP').checked = true;
    await rodar();
    const metricas = win.eval('metrics');
    assert.equal(metricas.length, 3);
    const porNuvem = Object.fromEntries(metricas.map(m => [m.nuvem, m]));
    assert.equal(porNuvem.AWS.resultado, 'ok');
    assert.equal(porNuvem.GCP.resultado, 'fallback');
    assert.equal(porNuvem.GCP.http, 500);
    assert.equal($('metricsBody').querySelectorAll('tr').length, 3);
});

test('execução antiga não sobrescreve a mais nova', async () => {
    atrasoMs['aws.test'] = 200;
    const primeira = rodar();          // taxa 0,8% (lenta)
    await new Promise(r => setTimeout(r, 20));
    atrasoMs['aws.test'] = 0;
    preencher({ taxaJuros: 3 });
    const segunda = rodar();           // taxa 3% (rápida)
    await Promise.all([primeira, segunda]);
    assert.equal(json('aws').data.montanteBruto, (await awsEsperado({ taxaJuros: 3 })).montanteBruto);
    assert.equal($('btnRun').disabled, false);
});

test('modal de endpoints é preenchido a partir da configuração e salva alterações', async () => {
    win.eval('toggleEndpointModal(true)');
    assert.equal($('endpointAWS').value, 'https://aws.test/');
    $('endpointAzure').value = '  https://azure.test/novo  ';
    win.eval('saveEndpoints()');
    assert.equal(win.eval('endpoints.azure'), 'https://azure.test/novo');
    assert.ok($('endpointModal').classList.contains('hidden'));
});
