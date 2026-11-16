import { http } from '@google-cloud/functions-framework';

// Função 3 (GCP): Projetor de Inflação e Poder de Compra
// POST { montanteBruto, totalInvestido, taxaInflacao (IPCA % ao ano), tempoMeses }
// 200 = sucesso | 400 = parâmetros inválidos | 500 = falha interna (?simularErro=true força)

function lerNumero(body, campo) {
    const valor = body[campo];
    if (valor === undefined || valor === null || valor === '') return undefined;
    return Number(valor);
}

function validar(body) {
    const detalhes = [];
    const montanteBruto = lerNumero(body, 'montanteBruto');
    const totalInvestido = lerNumero(body, 'totalInvestido') ?? 0;
    const taxaInflacao = lerNumero(body, 'taxaInflacao') ?? 4.5;
    const tempoMeses = lerNumero(body, 'tempoMeses');

    if (montanteBruto === undefined) {
        detalhes.push({ campo: 'montanteBruto', mensagem: 'é obrigatório' });
    } else if (!Number.isFinite(montanteBruto) || montanteBruto <= 0) {
        detalhes.push({ campo: 'montanteBruto', mensagem: 'deve ser um número maior que 0' });
    }

    if (!Number.isFinite(totalInvestido) || totalInvestido < 0) {
        detalhes.push({ campo: 'totalInvestido', mensagem: 'deve ser um número maior ou igual a 0' });
    }

    if (!Number.isFinite(taxaInflacao) || taxaInflacao < -10 || taxaInflacao > 100) {
        detalhes.push({ campo: 'taxaInflacao', mensagem: 'deve estar entre -10 e 100 (% ao ano)' });
    }

    if (tempoMeses === undefined) {
        detalhes.push({ campo: 'tempoMeses', mensagem: 'é obrigatório' });
    } else if (!Number.isInteger(tempoMeses) || tempoMeses < 1 || tempoMeses > 600) {
        detalhes.push({ campo: 'tempoMeses', mensagem: 'deve ser um inteiro entre 1 e 600' });
    }

    return { detalhes, montanteBruto, totalInvestido, taxaInflacao, tempoMeses };
}

const arredondar = (n) => Math.round(n * 100) / 100;

http('projetorInflacao', (req, res) => {
    const requestId = req.get('X-Request-Id') || null;

    // CORS Headers
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Headers', 'Content-Type, X-Request-Id');
    res.set('Access-Control-Allow-Methods', 'OPTIONS,POST');

    if (req.method === 'OPTIONS') {
        res.status(204).send('');
        return;
    }

    if (req.method !== 'POST') {
        res.status(400).json({
            status: 'error',
            erro: 'VALIDACAO',
            detalhes: [{ campo: 'method', mensagem: 'use POST com corpo JSON' }],
            requestId
        });
        return;
    }

    try {
        // Demonstração de resiliência: força uma falha interna
        if (req.query.simularErro === 'true') {
            throw new Error('Falha simulada (simularErro=true)');
        }

        const body = (req.body && typeof req.body === 'object') ? req.body : {};
        const { detalhes, montanteBruto, totalInvestido, taxaInflacao, tempoMeses } = validar(body);

        if (detalhes.length > 0) {
            res.status(400).json({ status: 'error', erro: 'VALIDACAO', detalhes, requestId });
            return;
        }

        const inflacaoMensal = Math.pow(1 + (taxaInflacao / 100), 1 / 12) - 1;
        const fatorInflacao = Math.pow(1 + inflacaoMensal, tempoMeses);

        const montanteReal = montanteBruto / fatorInflacao;
        const perdaPoderCompra = montanteBruto - montanteReal;
        const ganhoRealLiquido = montanteReal - totalInvestido;

        res.status(200).json({
            status: 'success',
            provider: 'Google Cloud Functions (us-central1)',
            data: {
                montanteReal: arredondar(montanteReal),
                perdaPoderCompra: arredondar(perdaPoderCompra),
                ganhoRealLiquido: arredondar(ganhoRealLiquido),
                taxaInflacaoAcumulada: arredondar((fatorInflacao - 1) * 100)
            },
            requestId
        });
    } catch (error) {
        console.error('[projetorInflacao]', requestId, error);
        res.status(500).json({ status: 'error', erro: 'INTERNO', mensagem: error.message, requestId });
    }
});
