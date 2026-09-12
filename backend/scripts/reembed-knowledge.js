/**
 * CLI: re-embed all vector_documents with current EMBEDDING_* config
 *   npm run reembed:rag
 *   npm run reembed:rag -- --limit=100
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { reembedAllVectorDocuments } = require('../services/vectorStore/reembed');

const limitArg = process.argv.find((a) => a.startsWith('--limit='));
const limit = limitArg ? Number(limitArg.split('=')[1]) : null;

reembedAllVectorDocuments({ limit })
    .then((r) => {
        console.log('[reembed] done', r);
        process.exit(0);
    })
    .catch((e) => {
        console.error('[reembed] failed:', e.message);
        process.exit(1);
    });
