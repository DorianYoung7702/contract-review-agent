const DEFAULT_REVIEW_ORGANIZATION = '云伽智能';

const normalizePartyName = (value) => String(value || '')
  .normalize('NFKC')
  .replace(/\s+/g, '')
  .toLowerCase();

export const findDefaultReviewPerspective = (parties = []) => {
  const keyword = normalizePartyName(DEFAULT_REVIEW_ORGANIZATION);
  if (!Array.isArray(parties)) return '';
  return parties.find((party) => normalizePartyName(party).includes(keyword)) || '';
};

export const resolveDefaultReviewPerspective = ({
  explicitPerspective = '',
  serverDefault = '',
  parties = [],
} = {}) => String(explicitPerspective || '').trim()
  || String(serverDefault || '').trim()
  || findDefaultReviewPerspective(parties);
