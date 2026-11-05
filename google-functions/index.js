const functions = require('@google-cloud/functions-framework');

functions.http('projetorInflacao', (req, res) => {
    // CORS Headers
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    res.set('Access-Control-Allow-Methods', 'OPTIONS,POST,GET');

    if (req.method === 'OPTIONS') {
        res.status(204).send('');
        return;
    }

    try {
        const body = req.body || {};
        const montanteBruto = parseFloat(body.montanteBruto) || 0;
        const totalInvestido = parseFloat(body.totalInvestido) || 0;
        const taxaInflacaoAnual = parseFloat(body.taxaInflacao) || 4.5;
        const meses = parseInt(body.tempoMeses) || 12;

        let inflacaoMensal = Math.pow(1 + (taxaInflacaoAnual / 100), 1/12) - 1;
        let fatorInflacao = Math.pow(1 + inflacaoMensal, meses);
        
        let montanteReal = montanteBruto / fatorInflacao;
        let perdaPoderCompra = montanteBruto - montanteReal;
        let ganhoRealLiquido = montanteReal - totalInvestido;

        res.status(200).json({
            status: "success",
            provider: "Google Cloud Functions (us-central1)",
            data: {
                montanteReal: Math.round(montanteReal * 100) / 100,
                perdaPoderCompra: Math.round(perdaPoderCompra * 100) / 100,
                ganhoRealLiquido: Math.round(ganhoRealLiquido * 100) / 100,
                taxaInflacaoAcumulada: Math.round((fatorInflacao - 1) * 10000) / 100
            }
        });
    } catch (error) {
        res.status(400).json({ status: "error", message: error.message });
    }
});