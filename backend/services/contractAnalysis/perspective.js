/** 合同审查立场默认值：显式选择优先，其次匹配云伽智能所在方。 */
const DEFAULT_REVIEW_ORGANIZATION = String(
    process.env.DEFAULT_REVIEW_ORGANIZATION || '云伽智能',
).trim();

const normalizePartyName = (value) => String(value || '')
    .normalize('NFKC')
    .replace(/\s+/g, '')
    .toLowerCase();

const findOrganizationParty = (
    parties = [],
    organizationKeyword = DEFAULT_REVIEW_ORGANIZATION,
) => {
    const keyword = normalizePartyName(organizationKeyword);
    if (!keyword || !Array.isArray(parties)) return '';
    return parties.find((party) => normalizePartyName(party).includes(keyword)) || '';
};

const resolveReviewPerspective = (
    explicitPerspective,
    parties = [],
    fallback = '',
) => String(explicitPerspective || '').trim()
    || findOrganizationParty(parties)
    || String(fallback || '').trim();

module.exports = {
    DEFAULT_REVIEW_ORGANIZATION,
    normalizePartyName,
    findOrganizationParty,
    resolveReviewPerspective,
};
