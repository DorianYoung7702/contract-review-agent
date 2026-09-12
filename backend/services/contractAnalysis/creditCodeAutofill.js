/**
 * @file services/contractAnalysis/creditCodeAutofill.js
 * @brief 将双方公司名称、统一社会信用代码和注册地址写入 DOCX
 */

const path = require('path');
const { insertCompanyInfoBlocksInDocx } = require('./docxEdit');

const USCC_RE = /[0-9A-HJ-NP-RT-Y]{2}\d{6}[0-9A-HJ-NP-RT-Y0-9]{10}/i;
const YUNJIA_COMPANY_NAME = '深圳市云伽智能技术有限公司';
const YUNJIA_FIXED_PROFILE = Object.freeze({
    company_name: YUNJIA_COMPANY_NAME,
    unified_code: '91440300MA5FXU44XF',
    registered_address: '深圳市南山区西丽街道西丽社区留仙大道创智云城1标段1栋D座1701-1708、1801-1806',
    legal_representative: '',
    registered_capital: '',
    establish_date: '',
    company_status: '存续',
    is_dishonest: false,
    is_executed: false,
    has_admin_punishment: false,
    has_business_exception: false,
    has_equity_pledge: false,
    has_chattel_mortgage: false,
    risk_level: 'green',
    risk_items: [],
    suggestion: '云伽为固定审查立场主体，使用已确认的公司资料。',
    data_source: 'yunjia_fixed_profile',
});

const isYunjiaCompany = (name) => String(name || '').replace(/\s+/g, '') === YUNJIA_COMPANY_NAME;

const getYunjiaFixedProfile = () => ({
    ...YUNJIA_FIXED_PROFILE,
    risk_items: [],
    queried_at: new Date().toISOString(),
});

const normalizeCompanySearchResults = (companySearchResults = []) => companySearchResults.map((item) => {
    const companyName = String(item?.companyName || item?.company_name || '').trim();
    const profile = item?.profile || {};
    return {
        companyName,
        role: item?.role || '',
        unified_code: profile.unified_code || '',
        registered_address: profile.registered_address || '',
        source: profile.data_source || item?.source || '',
    };
}).filter((item) => item.companyName && (item.unified_code || item.registered_address));

/**
 * Write company information into the live DOCX. The same normalized result is
 * retained in analysis_result and later reused by redline/formal exports.
 */
const autofillCreditCodesInContract = (contract, plainText, companySearchResults = []) => {
    const ext = path.extname(contract?.storage_path || '').toLowerCase();
    if (ext !== '.docx') return { applied: [], skipped: [{ reason: 'NOT_DOCX' }] };
    const entries = normalizeCompanySearchResults(companySearchResults);
    if (!entries.length) return { applied: [], skipped: [{ reason: 'NO_VERIFIED_COMPANY_INFO' }] };
    return insertCompanyInfoBlocksInDocx(contract.storage_path, entries, { tracked: false });
};

module.exports = {
    USCC_RE,
    YUNJIA_COMPANY_NAME,
    YUNJIA_FIXED_PROFILE,
    isYunjiaCompany,
    getYunjiaFixedProfile,
    normalizeCompanySearchResults,
    autofillCreditCodesInContract,
};
