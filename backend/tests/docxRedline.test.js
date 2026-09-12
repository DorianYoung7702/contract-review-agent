const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const AdmZip = require('adm-zip');

const {
    applyRedlineInXmlRuns,
    applyRedlinesToDocx,
    buildInlineDiffSegments,
} = require('../services/contractAnalysis/docxEdit');
const { collectRedlineItems } = require('../services/contractAnalysis/redlineWorkflow');

const DOCUMENT_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:rPr><w:b/></w:rPr><w:t>付款条款：</w:t></w:r><w:r><w:t>甲方应</w:t></w:r><w:r><w:t>于5日内付款。</w:t></w:r></w:p>
    <w:sectPr/>
  </w:body>
</w:document>`;

const createMinimalDocx = (filePath) => {
    const zip = new AdmZip();
    zip.addFile('[Content_Types].xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>
</Types>`, 'utf8'));
    zip.addFile('_rels/.rels', Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`, 'utf8'));
    zip.addFile('word/document.xml', Buffer.from(DOCUMENT_XML, 'utf8'));
    zip.addFile('word/settings.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"></w:settings>`, 'utf8'));
    zip.addFile('word/_rels/document.xml.rels', Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`, 'utf8'));
    zip.writeZip(filePath);
};

test('redline replacement marks only changed fragments inside the original sentence', () => {
    const result = applyRedlineInXmlRuns(
        DOCUMENT_XML,
        '甲方应于5日内付款。',
        '甲方应于验收后30日内付款。',
        { revisionId: 4, commentId: 7, author: '测试审查员', date: '2026-08-11T00:00:00.000Z' },
    );

    assert.equal(result.replaced, true);
    assert.match(result.xml, /<w:del w:id="4"[^>]*><w:r><w:rPr>/);
    assert.match(result.xml, /<w:delText[^>]*>5<\/w:delText>/);
    assert.match(result.xml, /<w:ins w:id="5"[^>]*>[\s\S]*验收后30/);
    assert.doesNotMatch(result.xml, /<w:delText[^>]*>甲方应于5日内付款。<\/w:delText>/);
    assert.doesNotMatch(result.xml, /<w:ins[^>]*>[\s\S]*甲方应于验收后30日内付款。<\/w:t>/);
    assert.match(result.xml, /<w:t xml:space="preserve">甲方应于<\/w:t>/);
    assert.match(result.xml, /<w:t xml:space="preserve">日内付款。<\/w:t>/);
    assert.match(result.xml, /<w:commentRangeStart w:id="7"\/>/);
    assert.doesNotMatch(result.xml, /<w:rPr\b[^>]*>(?:(?!<\/w:rPr>)[\s\S])*<w:r\b/);
});

test('inline diff isolates multiple edits in one sentence', () => {
    assert.deepEqual(
        buildInlineDiffSegments('乙方应在5日内提交纸质报告。', '乙方应在10日内提交电子报告并盖章。'),
        [
            { type: 'equal', text: '乙方应在' },
            { type: 'delete', text: '5' },
            { type: 'insert', text: '10' },
            { type: 'equal', text: '日内提交' },
            { type: 'delete', text: '纸质' },
            { type: 'insert', text: '电子' },
            { type: 'equal', text: '报告' },
            { type: 'insert', text: '并盖章' },
            { type: 'equal', text: '。' },
        ],
    );
});

test('company information autofill suggestions are excluded from redline items', () => {
    const items = collectRedlineItems({
        modification_suggestions: [
            {
                redline_kind: 'company_info_block',
                original_text: '甲方：云伽公司',
                suggested_text: '统一社会信用代码：示例',
            },
            {
                title: '付款期限',
                original_text: '收到发票后5日付款',
                suggested_text: '验收合格且收到发票后30日付款',
            },
        ],
    });

    assert.equal(items.length, 1);
    assert.equal(items[0].title, '付款期限');
});

test('plain annotation comments are never used as replacement redlines', () => {
    const items = collectRedlineItems({
        auto_annotation_targets: [
            {
                original_text: '甲方应于5日内付款。',
                comment: '付款期限过短，建议结合验收结果调整。',
                title: '付款期限风险',
            },
        ],
    });

    assert.deepEqual(items, []);
});

test('DOCX redline materialization writes tracked changes, comments and package relationships', (t) => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'contract-redline-test-'));
    const filePath = path.join(tempDir, 'redline.docx');
    t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
    createMinimalDocx(filePath);

    const result = applyRedlinesToDocx(filePath, [
        {
            original_text: '甲方应于5日内付款。',
            suggested_text: '甲方应于验收后30日内付款。',
            comment: '付款条件应与验收结果绑定，避免先付款后争议。',
            title: '付款条款',
        },
        {
            original_text: '不存在的原文',
            suggested_text: '不会写入',
        },
    ]);

    assert.deepEqual(result, { applied: 1, failed: 1 });
    const zip = new AdmZip(filePath);
    const documentXml = zip.readAsText('word/document.xml');
    const settingsXml = zip.readAsText('word/settings.xml');
    const commentsXml = zip.readAsText('word/comments.xml');
    const relsXml = zip.readAsText('word/_rels/document.xml.rels');
    const typesXml = zip.readAsText('[Content_Types].xml');

    assert.match(documentXml, /<w:del\b[^>]*>[\s\S]*?<w:delText\b/);
    assert.match(documentXml, /<w:ins\b[^>]*>[\s\S]*?<w:t\b/);
    assert.match(documentXml, /<w:commentRangeStart\b/);
    assert.match(documentXml, /<w:commentReference\b/);
    assert.match(settingsXml, /<w:trackRevisions\/>/);
    assert.match(commentsXml, /付款条件应与验收结果绑定/);
    assert.match(relsXml, /relationships\/comments/);
    assert.match(typesXml, /PartName="\/word\/comments\.xml"/);
});
