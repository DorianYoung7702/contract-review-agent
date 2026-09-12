const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const AdmZip = require('adm-zip');

const {
    insertCompanyInfoBlocksInDocx,
    readParagraphText,
} = require('../services/contractAnalysis/docxEdit');
const {
    getYunjiaFixedProfile,
    isYunjiaCompany,
} = require('../services/contractAnalysis/creditCodeAutofill');

const createMinimalDocx = (filePath, paragraphs) => {
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
    const body = paragraphs.map((text) => `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`).join('');
    zip.addFile('word/document.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr/></w:body></w:document>`, 'utf8'));
    zip.addFile('word/settings.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"></w:settings>`, 'utf8'));
    zip.writeZip(filePath);
};

const readDocumentXml = (filePath) => new AdmZip(filePath).readAsText('word/document.xml');

const companyEntries = [
    {
        companyName: '深圳市云伽智能技术有限公司',
        unified_code: '91440300MA5FXU44XF',
        registered_address: '深圳市南山区西丽街道西丽社区留仙大道创智云城1标段1栋D座1701-1708、1801-1806',
        source: 'yunjia_fixed_profile',
    },
    {
        companyName: '深圳市效能企业管理咨询有限公司',
        unified_code: '91440300MA5FPR018P',
        registered_address: '深圳市南山区南山街道南山社区南新路阳光科创中心二期A座701-12',
        source: 'qichacha',
    },
];

test('云伽使用固定公司资料，不依赖外部工商查询', () => {
    const profile = getYunjiaFixedProfile();
    assert.equal(isYunjiaCompany(profile.company_name), true);
    assert.equal(profile.unified_code, '91440300MA5FXU44XF');
    assert.match(profile.registered_address, /创智云城/);
    assert.equal(profile.data_source, 'yunjia_fixed_profile');
});

test('双方出现在同一叙述段时，在正文前插入完整公司信息块', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'company-info-narrative-'));
    const filePath = path.join(dir, 'contract.docx');
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    createMinimalDocx(filePath, [
        '培 训 合 同',
        '',
        '为了适应业务发展需要，深圳市云伽智能技术有限公司（甲方）委托深圳市效能企业管理咨询有限公司（乙方）提供培训服务。',
    ]);

    const result = insertCompanyInfoBlocksInDocx(filePath, companyEntries);
    assert.equal(result.applied.length, 2);
    assert.deepEqual(result.applied.map((item) => item.role), ['甲方', '乙方']);
    const xml = readDocumentXml(filePath);
    const paragraphs = [...xml.matchAll(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g)].map((m) => readParagraphText(m[0]));
    const narrativeIndex = paragraphs.findIndex((text) => text.startsWith('为了适应业务发展需要'));
    assert.ok(paragraphs.indexOf('甲方：深圳市云伽智能技术有限公司') < narrativeIndex);
    assert.ok(paragraphs.indexOf('乙方：深圳市效能企业管理咨询有限公司') < narrativeIndex);
    assert.ok(paragraphs.indexOf('统一社会信用代码：91440300MA5FXU44XF') < narrativeIndex);
    assert.ok(paragraphs.indexOf('地址：深圳市南山区南山街道南山社区南新路阳光科创中心二期A座701-12') < narrativeIndex);
});

test('独立甲乙方公司行后分别补信用代码和地址', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'company-info-lines-'));
    const filePath = path.join(dir, 'contract.docx');
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    createMinimalDocx(filePath, [
        '采购单位（甲方）: 深圳市云伽智能技术有限公司',
        '供货单位（乙方）: 深圳市效能企业管理咨询有限公司',
        '根据相关法律法规，双方签订本合同。',
    ]);

    const result = insertCompanyInfoBlocksInDocx(filePath, companyEntries);
    assert.equal(result.applied.length, 2);
    assert.ok(result.applied.every((item) => item.mode === 'after_party_line'));
    const paragraphs = [...readDocumentXml(filePath).matchAll(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g)].map((m) => readParagraphText(m[0]));
    const aIndex = paragraphs.indexOf('采购单位（甲方）: 深圳市云伽智能技术有限公司');
    const bIndex = paragraphs.indexOf('供货单位（乙方）: 深圳市效能企业管理咨询有限公司');
    assert.equal(paragraphs[aIndex + 1], '统一社会信用代码：91440300MA5FXU44XF');
    assert.match(paragraphs[aIndex + 2], /^地址：深圳市南山区西丽街道/);
    assert.equal(paragraphs[bIndex + 1], '统一社会信用代码：91440300MA5FPR018P');
    assert.match(paragraphs[bIndex + 2], /^地址：深圳市南山区南山街道/);
});

test('已写入的云伽错误信用代码会被原位纠正且不重复插入', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'company-info-correction-'));
    const filePath = path.join(dir, 'contract.docx');
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    createMinimalDocx(filePath, [
        '甲方：深圳市云伽智能技术有限公司',
        '统一社会信用代码：91440300MA5FXU44XR',
        `地址：${companyEntries[0].registered_address}`,
    ]);

    const result = insertCompanyInfoBlocksInDocx(filePath, [companyEntries[0]]);
    assert.equal(result.applied.length, 0);
    assert.equal(result.corrected_legacy_codes.length, 1);
    const xml = readDocumentXml(filePath);
    assert.doesNotMatch(xml, /91440300MA5FXU44XR/);
    assert.match(xml, /91440300MA5FXU44XF/);
});

test('红线模式写入真实 Word 插入修订并启用跟踪修订', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'company-info-redline-'));
    const filePath = path.join(dir, 'contract.docx');
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    createMinimalDocx(filePath, [
        '深圳市云伽智能技术有限公司（甲方）委托深圳市效能企业管理咨询有限公司（乙方）提供服务。',
    ]);

    const result = insertCompanyInfoBlocksInDocx(filePath, companyEntries, {
        tracked: true,
        author: 'AI合同审查',
        date: '2026-08-11T00:00:00.000Z',
    });
    assert.equal(result.applied.length, 2);
    const zip = new AdmZip(filePath);
    const documentXml = zip.readAsText('word/document.xml');
    assert.match(documentXml, /<w:ins\b[^>]*w:author="AI合同审查"/);
    assert.match(documentXml, /<w:color w:val="FF0000"\/>/);
    assert.match(documentXml, /<w:u w:val="single"\/>/);
    assert.match(zip.readAsText('word/settings.xml'), /<w:trackRevisions\/>/);
});
