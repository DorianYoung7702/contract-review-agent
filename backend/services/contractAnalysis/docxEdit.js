/**
 * @file services/contractAnalysis/docxEdit.js
 * @brief 在 DOCX 文件中精确定位并替换合同条款文本
 *
 * 核心职责：
 * - 对 DOCX 内 word/*.xml 进行文本替换，支持原文修改建议落地
 * - 处理 XML 实体转义与还原，保证内容写入安全
 * - 跨 w:t run 节点进行模糊匹配，应对文本被分散切割的情况
 *
 * 关键实现：
 * - normalizeForDocxMatch 将全角标点统一并去空白，建立索引映射
 * - replaceTextInXmlRuns 跨 run 拼接后定位目标区间并替换
 * - replaceTextInDocx 通过 AdmZip 直接读写 zip 内 XML 条目
 *
 * 依赖关系：
 * - 上游：fs、path、adm-zip
 * - 下游：被报告渲染、版本快照等需要回写 DOCX 的流程调用
 */
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');

// Known factual corrections for company identifiers previously written by this
// application. Restrict replacement to a matching current company entry so an
// unrelated contract containing the same text is never rewritten implicitly.
const LEGACY_USCC_CORRECTIONS = Object.freeze({
    '91440300MA5FXU44XR': '91440300MA5FXU44XF',
});

const escapeRegExp = (value) => String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const escapeXmlText = (text) => String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

const escapeXmlAttribute = (text) => escapeXmlText(text)
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

const unescapeXmlText = (text) => String(text || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');

const normalizeForDocxMatch = (text) => {
    const normalized = [];
    const indexMap = [];
    for (let index = 0; index < String(text || '').length; index += 1) {
        const char = String(text)[index]
            .replace(/[“”]/g, '"')
            .replace(/[‘’]/g, "'")
            .replace(/[：]/g, ':')
            .replace(/[，]/g, ',')
            .replace(/[。]/g, '.');
        if (/\s/.test(char)) continue;
        normalized.push(char);
        indexMap.push(index);
    }
    return { value: normalized.join(''), indexMap };
};

const findDocxTextRange = (fullText, candidate) => {
    const exactIndex = fullText.indexOf(candidate);
    if (exactIndex >= 0) {
        return { start: exactIndex, end: exactIndex + candidate.length };
    }

    const normalizedFull = normalizeForDocxMatch(fullText);
    const normalizedCandidate = normalizeForDocxMatch(candidate).value;
    if (!normalizedCandidate) return null;

    const normalizedIndex = normalizedFull.value.indexOf(normalizedCandidate);
    if (normalizedIndex < 0) return null;

    const start = normalizedFull.indexMap[normalizedIndex];
    const end = normalizedFull.indexMap[normalizedIndex + normalizedCandidate.length - 1] + 1;
    return { start, end };
};

const replaceTextInXmlRuns = (xml, candidate, suggestedText) => {
    const textRunPattern = /<w:t\b([^>]*)>([\s\S]*?)<\/w:t>/g;
    const runs = [];
    let match;
    let fullText = '';

    while ((match = textRunPattern.exec(xml)) !== null) {
        const decodedText = unescapeXmlText(match[2]);
        runs.push({
            matchStart: match.index,
            matchEnd: match.index + match[0].length,
            attrs: match[1],
            rawText: match[2],
            text: decodedText,
            start: fullText.length,
            end: fullText.length + decodedText.length,
        });
        fullText += decodedText;
    }

    const range = findDocxTextRange(fullText, candidate);
    if (!range) return { xml, replaced: false };

    let inserted = false;
    const safeSuggestion = String(suggestedText || '').replace(/\r?\n+/g, ' ');
    const parts = [];
    let cursor = 0;

    for (const run of runs) {
        parts.push(xml.slice(cursor, run.matchStart));
        cursor = run.matchEnd;

        if (run.end <= range.start || run.start >= range.end) {
            parts.push(`<w:t${run.attrs}>${run.rawText}</w:t>`);
            continue;
        }

        const overlapStart = Math.max(range.start, run.start) - run.start;
        const overlapEnd = Math.min(range.end, run.end) - run.start;
        const before = run.text.slice(0, overlapStart);
        const after = run.text.slice(overlapEnd);
        let nextText = '';

        if (!inserted) {
            nextText = before + safeSuggestion;
            inserted = true;
        }
        if (run.end >= range.end) {
            nextText += after;
        }

        const attrs = /^\s/.test(nextText) || /\s$/.test(nextText)
            ? (run.attrs.includes('xml:space=') ? run.attrs : `${run.attrs} xml:space="preserve"`)
            : run.attrs;
        parts.push(`<w:t${attrs}>${escapeXmlText(nextText)}</w:t>`);
    }

    parts.push(xml.slice(cursor));
    return { xml: parts.join(''), replaced: true };
};

const coalesceDiffSegments = (segments = []) => {
    const merged = [];
    for (const segment of segments) {
        if (!segment?.text) continue;
        const previous = merged[merged.length - 1];
        if (previous?.type === segment.type) previous.text += segment.text;
        else merged.push({ type: segment.type, text: segment.text });
    }
    // Present replacements in the familiar Word order: deleted text first,
    // then inserted text. LCS backtracking can otherwise emit insert/delete.
    for (let index = 0; index < merged.length - 1; index += 1) {
        if (merged[index].type === 'insert' && merged[index + 1].type === 'delete') {
            [merged[index], merged[index + 1]] = [merged[index + 1], merged[index]];
            index += 1;
        }
    }
    return merged;
};

/**
 * Character-level LCS diff for Chinese contract clauses. Common text stays in place;
 * only the actual changed fragments become tracked deletions/insertions.
 */
const buildInlineDiffSegments = (originalText, suggestedText) => {
    const original = String(originalText || '').replace(/\r?\n+/g, ' ');
    const suggested = String(suggestedText || '').replace(/\r?\n+/g, ' ');
    if (original === suggested) return original ? [{ type: 'equal', text: original }] : [];

    const left = Array.from(original);
    const right = Array.from(suggested);
    let prefixLength = 0;
    while (
        prefixLength < left.length
        && prefixLength < right.length
        && left[prefixLength] === right[prefixLength]
    ) prefixLength += 1;

    let suffixLength = 0;
    while (
        suffixLength < left.length - prefixLength
        && suffixLength < right.length - prefixLength
        && left[left.length - 1 - suffixLength] === right[right.length - 1 - suffixLength]
    ) suffixLength += 1;

    const leftMiddle = left.slice(prefixLength, left.length - suffixLength);
    const rightMiddle = right.slice(prefixLength, right.length - suffixLength);
    const segments = [];
    if (prefixLength) segments.push({ type: 'equal', text: left.slice(0, prefixLength).join('') });

    // Bound memory for unexpectedly long model output. The fallback still keeps
    // the shared prefix/suffix and marks only the unmatched middle as changed.
    const cellCount = (leftMiddle.length + 1) * (rightMiddle.length + 1);
    if (cellCount > 1_000_000) {
        if (leftMiddle.length) segments.push({ type: 'delete', text: leftMiddle.join('') });
        if (rightMiddle.length) segments.push({ type: 'insert', text: rightMiddle.join('') });
    } else {
        const width = rightMiddle.length + 1;
        const matrix = new Uint32Array((leftMiddle.length + 1) * width);
        for (let i = 1; i <= leftMiddle.length; i += 1) {
            for (let j = 1; j <= rightMiddle.length; j += 1) {
                const index = i * width + j;
                matrix[index] = leftMiddle[i - 1] === rightMiddle[j - 1]
                    ? matrix[(i - 1) * width + j - 1] + 1
                    : Math.max(matrix[(i - 1) * width + j], matrix[i * width + j - 1]);
            }
        }

        const reversed = [];
        let i = leftMiddle.length;
        let j = rightMiddle.length;
        while (i > 0 || j > 0) {
            if (i > 0 && j > 0 && leftMiddle[i - 1] === rightMiddle[j - 1]) {
                reversed.push({ type: 'equal', text: leftMiddle[i - 1] });
                i -= 1;
                j -= 1;
            } else if (j > 0 && (i === 0 || matrix[i * width + j - 1] > matrix[(i - 1) * width + j])) {
                reversed.push({ type: 'insert', text: rightMiddle[j - 1] });
                j -= 1;
            } else {
                reversed.push({ type: 'delete', text: leftMiddle[i - 1] });
                i -= 1;
            }
        }
        segments.push(...reversed.reverse());
    }

    if (suffixLength) segments.push({ type: 'equal', text: left.slice(left.length - suffixLength).join('') });
    return coalesceDiffSegments(segments);
};

const mergeRunProperties = (runProperties = '', additions = '') => {
    if (!additions) return runProperties;
    if (/<w:rPr\b/.test(runProperties)) {
        const withoutConflictingProperties = runProperties
            .replace(/<w:(?:color|strike|dstrike|u)\b[^>]*\/?>(?:<\/w:(?:color|strike|dstrike|u)>)?/g, '');
        return withoutConflictingProperties.replace('</w:rPr>', `${additions}</w:rPr>`);
    }
    return `<w:rPr>${additions}</w:rPr>`;
};

/** Build real OOXML tracked changes with minimal inline redline styling. */
const buildRedlineRunsXml = (originalText, suggestedText, options = {}) => {
    const segments = buildInlineDiffSegments(originalText, suggestedText);
    const revisionId = Number.isInteger(options.revisionId) ? options.revisionId : 0;
    const author = escapeXmlAttribute(options.author || 'AI合同审查');
    const date = escapeXmlAttribute(options.date || new Date().toISOString());
    const baseRunProperties = options.runProperties || '';
    let nextRevisionId = revisionId;

    return segments.map((segment) => {
        const text = escapeXmlText(segment.text);
        if (segment.type === 'equal') {
            return `<w:r>${baseRunProperties}<w:t xml:space="preserve">${text}</w:t></w:r>`;
        }
        if (segment.type === 'delete') {
            const runProperties = mergeRunProperties(
                baseRunProperties,
                '<w:strike/><w:color w:val="FF0000"/>',
            );
            const xml = `<w:del w:id="${nextRevisionId}" w:author="${author}" w:date="${date}"><w:r>${runProperties}<w:delText xml:space="preserve">${text}</w:delText></w:r></w:del>`;
            nextRevisionId += 1;
            return xml;
        }
        const runProperties = mergeRunProperties(
            baseRunProperties,
            '<w:u w:val="single"/><w:color w:val="FF0000"/>',
        );
        const xml = `<w:ins w:id="${nextRevisionId}" w:author="${author}" w:date="${date}"><w:r>${runProperties}<w:t xml:space="preserve">${text}</w:t></w:r></w:ins>`;
        nextRevisionId += 1;
        return xml;
    }).join('');
};

const buildPlainRunXml = (text, runProperties = '') => {
    if (!text) return '';
    return `<w:r>${runProperties}<w:t xml:space="preserve">${escapeXmlText(text)}</w:t></w:r>`;
};

const readParagraphText = (paragraphXml) => {
    const texts = [];
    for (const match of String(paragraphXml || '').matchAll(/<w:(?:t|delText)\b[^>]*>([\s\S]*?)<\/w:(?:t|delText)>/g)) {
        texts.push(unescapeXmlText(match[1]));
    }
    return texts.join('');
};

const inferCompanyRole = (paragraphText, companyName) => {
    const text = String(paragraphText || '');
    const name = String(companyName || '');
    const index = text.indexOf(name);
    if (index < 0) return '';
    if (new RegExp(`${escapeRegExp(name)}\\s*[（(]甲方[）)]`).test(text)) return '甲方';
    if (new RegExp(`${escapeRegExp(name)}\\s*[（(]乙方[）)]`).test(text)) return '乙方';
    const before = text.slice(Math.max(0, index - 18), index);
    if (/(?:甲方|采购单位|委托方)[^甲乙]{0,12}[：:]?\s*$/.test(before)) return '甲方';
    if (/(?:乙方|供货单位|受托方)[^甲乙]{0,12}[：:]?\s*$/.test(before)) return '乙方';
    return '';
};

const buildCompanyInfoParagraphXml = (line, options = {}) => {
    const text = escapeXmlText(String(line || ''));
    const paragraphProperties = options.paragraphProperties || '<w:pPr><w:spacing w:after="0" w:line="360" w:lineRule="auto"/></w:pPr>';
    const runProperties = '<w:rPr><w:rFonts w:ascii="SimSun" w:eastAsia="宋体"/><w:sz w:val="21"/><w:szCs w:val="21"/>'
        + (options.tracked ? '<w:u w:val="single"/><w:color w:val="FF0000"/>' : '')
        + '</w:rPr>';
    const run = `<w:r>${runProperties}<w:t xml:space="preserve">${text}</w:t></w:r>`;
    if (!options.tracked) return `<w:p>${paragraphProperties}${run}</w:p>`;
    const revisionId = Number.isInteger(options.revisionId) ? options.revisionId : 0;
    const author = escapeXmlAttribute(options.author || 'AI合同审查');
    const date = escapeXmlAttribute(options.date || new Date().toISOString());
    return `<w:p>${paragraphProperties}<w:ins w:id="${revisionId}" w:author="${author}" w:date="${date}">${run}</w:ins></w:p>`;
};

const normalizeCompanyInfoEntries = (entries = []) => entries.map((item) => ({
    companyName: String(item.companyName || item.company_name || '').trim(),
    unified_code: String(item.unified_code || item.profile?.unified_code || '').trim().toUpperCase(),
    registered_address: String(item.registered_address || item.profile?.registered_address || '').trim(),
    role: String(item.role || '').trim(),
    source: item.source || item.profile?.data_source || '',
})).filter((item) => item.companyName && (item.unified_code || item.registered_address));

const correctLegacyUsccInXml = (xml, entries) => {
    let nextXml = String(xml || '');
    const corrections = [];
    for (const [legacyCode, correctedCode] of Object.entries(LEGACY_USCC_CORRECTIONS)) {
        const isConfirmedForCurrentCompany = entries.some((item) => item.unified_code === correctedCode);
        if (!isConfirmedForCurrentCompany || !nextXml.includes(legacyCode)) continue;
        const occurrences = nextXml.split(legacyCode).length - 1;
        nextXml = nextXml.split(legacyCode).join(correctedCode);
        corrections.push({ legacy_code: legacyCode, corrected_code: correctedCode, occurrences });
    }
    return { xml: nextXml, corrections };
};

/**
 * Insert structured party information into a DOCX. Separate party lines receive
 * code/address immediately after the company line; companies embedded together
 * in a narrative receive a complete party block before that paragraph.
 */
const insertCompanyInfoBlocksInDocx = (filePath, entries = [], options = {}) => {
    const zip = new AdmZip(filePath);
    const documentEntry = zip.getEntry('word/document.xml');
    if (!documentEntry) throw new Error('DOCX_DOCUMENT_XML_MISSING');
    let xml = documentEntry.getData().toString('utf8');
    const normalizedEntries = normalizeCompanyInfoEntries(entries);
    if (!normalizedEntries.length) return { applied: [], skipped: [{ reason: 'NO_COMPANY_INFO' }] };
    const legacyCorrection = correctLegacyUsccInXml(xml, normalizedEntries);
    xml = legacyCorrection.xml;

    const paragraphs = [];
    for (const match of xml.matchAll(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g)) {
        paragraphs.push({ xml: match[0], start: match.index, end: match.index + match[0].length, text: readParagraphText(match[0]) });
    }
    const documentText = paragraphs.map((p) => p.text).join('\n');
    const prepared = [];
    const skipped = [];

    for (const item of normalizedEntries) {
        const companyParagraphs = paragraphs.filter((p) => p.text.includes(item.companyName));
        if (!companyParagraphs.length) {
            skipped.push({ companyName: item.companyName, reason: 'COMPANY_NOT_FOUND' });
            continue;
        }
        const missingCode = Boolean(item.unified_code && !documentText.includes(item.unified_code));
        const missingAddress = Boolean(item.registered_address && !documentText.includes(item.registered_address));
        if (!missingCode && !missingAddress) {
            skipped.push({ companyName: item.companyName, reason: 'ALREADY_FILLED' });
            continue;
        }
        const anchor = companyParagraphs[0];
        const role = item.role || inferCompanyRole(anchor.text, item.companyName);
        const isStandalonePartyLine = anchor.text.length <= 140
            && Boolean(role)
            && normalizedEntries.filter((other) => anchor.text.includes(other.companyName)).length === 1;
        prepared.push({ ...item, anchor, role, isStandalonePartyLine, missingCode, missingAddress });
    }

    if (!prepared.length) {
        if (legacyCorrection.corrections.length) {
            zip.updateFile('word/document.xml', Buffer.from(xml, 'utf8'));
            zip.writeZip(filePath);
        }
        return { applied: [], skipped, corrected_legacy_codes: legacyCorrection.corrections };
    }
    const grouped = new Map();
    for (const item of prepared) {
        const key = item.isStandalonePartyLine ? `after:${item.anchor.end}` : `before:${item.anchor.start}`;
        if (!grouped.has(key)) grouped.set(key, []);
        grouped.get(key).push(item);
    }

    const date = options.date || new Date().toISOString();
    let nextRevisionId = scanMaxWordId(xml) + 1;
    const insertions = [];
    const applied = [];
    for (const [key, group] of grouped.entries()) {
        const [position, rawOffset] = key.split(':');
        const lines = [];
        for (const item of group) {
            if (!item.isStandalonePartyLine) lines.push(`${item.role ? `${item.role}：` : '合同主体：'}${item.companyName}`);
            if (item.missingCode) lines.push(`统一社会信用代码：${item.unified_code}`);
            if (item.missingAddress) lines.push(`地址：${item.registered_address}`);
            applied.push({
                companyName: item.companyName,
                role: item.role,
                unified_code: item.unified_code,
                registered_address: item.registered_address,
                source: item.source,
                mode: item.isStandalonePartyLine ? 'after_party_line' : 'party_block_before_narrative',
                missing_fields: [item.missingCode ? 'unified_code' : '', item.missingAddress ? 'registered_address' : ''].filter(Boolean),
                original_text: '',
                suggested_text: [
                    !item.isStandalonePartyLine ? `${item.role ? `${item.role}：` : '合同主体：'}${item.companyName}` : '',
                    item.missingCode ? `统一社会信用代码：${item.unified_code}` : '',
                    item.missingAddress ? `地址：${item.registered_address}` : '',
                ].filter(Boolean).join('\n'),
            });
        }
        const blockXml = lines.map((line) => {
            const paragraph = buildCompanyInfoParagraphXml(line, {
                tracked: Boolean(options.tracked),
                revisionId: nextRevisionId,
                author: options.author,
                date,
            });
            nextRevisionId += 1;
            return paragraph;
        }).join('');
        insertions.push({ offset: Number(rawOffset), position, xml: blockXml });
    }

    insertions.sort((a, b) => b.offset - a.offset);
    for (const insertion of insertions) {
        const offset = insertion.offset;
        xml = xml.slice(0, offset) + insertion.xml + xml.slice(offset);
    }
    zip.updateFile('word/document.xml', Buffer.from(xml, 'utf8'));
    if (options.tracked) ensureTrackRevisions(zip);
    zip.writeZip(filePath);
    return { applied, skipped, corrected_legacy_codes: legacyCorrection.corrections };
};

const collectParagraphRuns = (paragraphXml) => {
    const runs = [];
    const runPattern = /<w:r\b[^>]*>[\s\S]*?<\/w:r>/g;
    let match;
    let fullText = '';
    while ((match = runPattern.exec(paragraphXml)) !== null) {
        const texts = [];
        const textPattern = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g;
        let textMatch;
        while ((textMatch = textPattern.exec(match[0])) !== null) {
            texts.push(unescapeXmlText(textMatch[1]));
        }
        const text = texts.join('');
        if (!text) continue;
        const runProperties = match[0].match(/<w:rPr\b[^>]*>[\s\S]*?<\/w:rPr>/)?.[0] || '';
        runs.push({
            matchStart: match.index,
            matchEnd: match.index + match[0].length,
            text,
            start: fullText.length,
            end: fullText.length + text.length,
            runProperties,
        });
        fullText += text;
    }
    return { runs, fullText };
};

const buildCommentReferenceXml = (commentId) => (
    `<w:commentRangeStart w:id="${commentId}"/>`
    + `{{REDLINE_CHANGE}}`
    + `<w:commentRangeEnd w:id="${commentId}"/>`
    + `<w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="${commentId}"/></w:r>`
);

const applyRedlineInParagraph = (paragraphXml, candidate, suggestedText, options = {}) => {
    const { runs, fullText } = collectParagraphRuns(paragraphXml);
    const range = findDocxTextRange(fullText, candidate);
    if (!range) return { xml: paragraphXml, replaced: false };

    const overlapping = runs.filter((run) => run.end > range.start && run.start < range.end);
    if (!overlapping.length) return { xml: paragraphXml, replaced: false };

    const first = overlapping[0];
    const last = overlapping[overlapping.length - 1];
    const before = first.text.slice(0, Math.max(0, range.start - first.start));
    const after = last.text.slice(Math.max(0, range.end - last.start));
    const matchedOriginal = fullText.slice(range.start, range.end);
    const diffSegments = buildInlineDiffSegments(matchedOriginal, suggestedText);
    if (!diffSegments.some((segment) => segment.type !== 'equal')) {
        return { xml: paragraphXml, replaced: false };
    }
    const revisionId = Number.isInteger(options.revisionId) ? options.revisionId : 0;
    const commentId = Number.isInteger(options.commentId) ? options.commentId : revisionId;

    const change = buildRedlineRunsXml(matchedOriginal, suggestedText, {
        revisionId,
        author: options.author,
        date: options.date,
        runProperties: first.runProperties,
    });
    const anchoredChange = buildCommentReferenceXml(commentId).replace('{{REDLINE_CHANGE}}', change);
    const replacement = buildPlainRunXml(before, first.runProperties)
        + anchoredChange
        + buildPlainRunXml(after, last.runProperties);

    return {
        xml: paragraphXml.slice(0, first.matchStart) + replacement + paragraphXml.slice(last.matchEnd),
        replaced: true,
        matchedOriginal,
    };
};

/**
 * Replace matched original text with redline markup (keep deleted text visible as red strike,
 * append suggested text as red underline). Does not silently overwrite body with suggestion only.
 */
const applyRedlineInXmlRuns = (xml, candidate, suggestedText, options = {}) => {
    const paragraphPattern = /<w:p\b[^>]*>[\s\S]*?<\/w:p>/g;
    let match;
    while ((match = paragraphPattern.exec(xml)) !== null) {
        const result = applyRedlineInParagraph(match[0], candidate, suggestedText, options);
        if (!result.replaced) continue;
        return {
            xml: xml.slice(0, match.index) + result.xml + xml.slice(match.index + match[0].length),
            replaced: true,
            matchedOriginal: result.matchedOriginal,
        };
    }
    return { xml, replaced: false };
};

const scanMaxWordId = (...xmlValues) => {
    let maxId = -1;
    const idPattern = /\bw:id="(\d+)"/g;
    for (const xml of xmlValues) {
        let match;
        while ((match = idPattern.exec(String(xml || ''))) !== null) {
            maxId = Math.max(maxId, Number(match[1]));
        }
    }
    return maxId;
};

const upsertZipFile = (zip, entryName, xml) => {
    const data = Buffer.from(xml, 'utf8');
    if (zip.getEntry(entryName)) zip.updateFile(entryName, data);
    else zip.addFile(entryName, data);
};

const ensureTrackRevisions = (zip) => {
    const entry = zip.getEntry('word/settings.xml');
    let xml = entry
        ? entry.getData().toString('utf8')
        : '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"></w:settings>';
    if (!/<w:trackRevisions\b/.test(xml)) {
        xml = xml.replace('</w:settings>', '<w:trackRevisions/></w:settings>');
    }
    upsertZipFile(zip, 'word/settings.xml', xml);
};

const ensureCommentsRelationship = (zip) => {
    const relPath = 'word/_rels/document.xml.rels';
    const entry = zip.getEntry(relPath);
    let xml = entry
        ? entry.getData().toString('utf8')
        : '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>';
    if (!/relationships\/comments"/.test(xml)) {
        let maxRid = 0;
        for (const match of xml.matchAll(/\bId="rId(\d+)"/g)) maxRid = Math.max(maxRid, Number(match[1]));
        const relationship = `<Relationship Id="rId${maxRid + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="comments.xml"/>`;
        xml = xml.replace('</Relationships>', `${relationship}</Relationships>`);
    }
    upsertZipFile(zip, relPath, xml);
};

const ensureCommentsContentType = (zip) => {
    const contentTypesPath = '[Content_Types].xml';
    const entry = zip.getEntry(contentTypesPath);
    if (!entry) throw new Error('DOCX_CONTENT_TYPES_MISSING');
    let xml = entry.getData().toString('utf8');
    if (!/PartName="\/word\/comments\.xml"/.test(xml)) {
        const override = '<Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/>';
        xml = xml.replace('</Types>', `${override}</Types>`);
        zip.updateFile(contentTypesPath, Buffer.from(xml, 'utf8'));
    }
};

const appendComment = (zip, commentId, commentText, options = {}) => {
    const commentsPath = 'word/comments.xml';
    const entry = zip.getEntry(commentsPath);
    let xml = entry
        ? entry.getData().toString('utf8')
        : '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"></w:comments>';
    const author = escapeXmlAttribute(options.author || 'AI合同审查');
    const date = escapeXmlAttribute(options.date || new Date().toISOString());
    const text = escapeXmlText(commentText || 'AI 审查修改建议');
    const comment = `<w:comment w:id="${commentId}" w:author="${author}" w:date="${date}"><w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p></w:comment>`;
    xml = xml.replace('</w:comments>', `${comment}</w:comments>`);
    upsertZipFile(zip, commentsPath, xml);
    ensureCommentsRelationship(zip);
    ensureCommentsContentType(zip);
};

const normalizeReplacementCandidates = (originalText, originalCandidates = []) => {
    const candidates = [originalText, ...originalCandidates]
        .map((item) => String(item || '').trim())
        .filter(Boolean);
    const seen = new Set();
    return candidates.filter((candidate) => {
        const key = normalizeForDocxMatch(candidate).value;
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
    });
};

const replaceTextInDocx = (filePath, originalText, suggestedText, originalCandidates = []) => {
    const zip = new AdmZip(filePath);
    const xmlEntries = zip.getEntries().filter((entry) => /^word\/.*\.xml$/.test(entry.entryName));
    const escapedSuggestion = escapeXmlText(suggestedText);
    const candidates = normalizeReplacementCandidates(originalText, originalCandidates);
    let replacements = 0;

    for (const entry of xmlEntries) {
        let xml = entry.getData().toString('utf8');
        let updated = false;

        for (const candidate of candidates) {
            const escapedOriginal = escapeXmlText(candidate);
            const exactCount = xml.split(escapedOriginal).length - 1;
            if (exactCount > 0) {
                xml = xml.split(escapedOriginal).join(escapedSuggestion);
                replacements += exactCount;
                updated = true;
                break;
            }

            const runReplacement = replaceTextInXmlRuns(xml, candidate, suggestedText);
            if (runReplacement.replaced) {
                xml = runReplacement.xml;
                replacements += 1;
                updated = true;
                break;
            }
        }

        if (updated) {
            zip.updateFile(entry.entryName, Buffer.from(xml, 'utf8'));
        }
    }

    if (replacements === 0) {
        throw new Error('DOCX_EXACT_TEXT_NOT_FOUND');
    }

    zip.writeZip(filePath);
    return replacements;
};

/**
 * Apply redline markup to DOCX in place.
 * @returns {number} number of successful redline applications
 */
const applyRedlineInDocx = (filePath, originalText, suggestedText, originalCandidates = [], options = {}) => {
    const zip = new AdmZip(filePath);
    const xmlEntries = zip.getEntries().filter((entry) => entry.entryName === 'word/document.xml');
    const candidates = normalizeReplacementCandidates(originalText, originalCandidates);
    let replacements = 0;

    for (const entry of xmlEntries) {
        let xml = entry.getData().toString('utf8');
        let updated = false;
        const commentsXml = zip.getEntry('word/comments.xml')?.getData().toString('utf8') || '';
        const baseId = scanMaxWordId(xml, commentsXml) + 1;

        for (const candidate of candidates) {
            const date = options.date || new Date().toISOString();
            const runReplacement = applyRedlineInXmlRuns(xml, candidate, suggestedText, {
                revisionId: baseId,
                commentId: baseId,
                author: options.author,
                date,
            });
            if (runReplacement.replaced) {
                xml = runReplacement.xml;
                replacements += 1;
                updated = true;
                appendComment(
                    zip,
                    baseId,
                    options.comment || options.title || `建议修改为：${suggestedText}`,
                    { author: options.author, date },
                );
                break;
            }
        }

        if (updated) {
            zip.updateFile(entry.entryName, Buffer.from(xml, 'utf8'));
            ensureTrackRevisions(zip);
        }
    }

    if (replacements === 0) {
        throw new Error('DOCX_EXACT_TEXT_NOT_FOUND');
    }

    zip.writeZip(filePath);
    return replacements;
};

/**
 * Apply many redline items to a DOCX copy. Continues on misses.
 * @param {string} filePath
 * @param {Array<{ original_text?: string, suggested_text?: string, comment?: string, title?: string }>} items
 */
const applyRedlinesToDocx = (filePath, items = []) => {
    let applied = 0;
    let failed = 0;
    for (const item of items) {
        const original = String(item.original_text || item.original_clause || '').trim();
        if (!original) {
            failed += 1;
            continue;
        }
        const suggested = String(
            item.suggested_text
            || item.modification
            || item.comment
            || item.title
            || '【审查意见】',
        ).trim();
        try {
            applyRedlineInDocx(filePath, original, suggested, [], {
                comment: item.comment,
                title: item.title,
                author: item.author || 'AI合同审查',
            });
            applied += 1;
        } catch {
            failed += 1;
        }
    }
    return { applied, failed };
};

module.exports = {
    escapeXmlText,
    escapeXmlAttribute,
    unescapeXmlText,
    normalizeForDocxMatch,
    findDocxTextRange,
    replaceTextInXmlRuns,
    applyRedlineInXmlRuns,
    applyRedlineInParagraph,
    buildRedlineRunsXml,
    buildInlineDiffSegments,
    readParagraphText,
    inferCompanyRole,
    buildCompanyInfoParagraphXml,
    insertCompanyInfoBlocksInDocx,
    normalizeReplacementCandidates,
    replaceTextInDocx,
    applyRedlineInDocx,
    applyRedlinesToDocx,
};
