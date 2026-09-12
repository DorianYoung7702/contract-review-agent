/**
 * @file services/contractAnalysis/onlyoffice.js
 * @brief 构建 OnlyOffice 文档编辑器配置并发送命令服务
 *
 * 核心职责：
 * - 根据合同记录生成 OnlyOffice 编辑器初始化配置
 * - 使用 JWT 对配置签名，保证回调与文档访问安全
 * - 向 OnlyOffice 服务发送命令请求（如强制保存）
 *
 * 关键实现：
 * - buildOnlyOfficeConfig 区分 docx/pdf 的权限与编辑模式
 * - 通过 BACKEND_URL_FOR_DOCKER 生成容器内可访问的文件与回调 URL
 * - postOnlyOfficeCommand 带 JWT 头调用 CommandService
 *
 * 依赖关系：
 * - 上游：jsonwebtoken、axios、path 及环境变量配置
 * - 下游：被合同编辑/保存回调相关路由调用
 */
const jwt = require('jsonwebtoken');
const axios = require('axios');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const ONLYOFFICE_JWT_SECRET = process.env.ONLYOFFICE_JWT_SECRET;
const ONLYOFFICE_URL = process.env.ONLYOFFICE_URL || 'http://localhost:8081';
const APP_HOST = process.env.APP_HOST;
const BACKEND_URL_FOR_DOCKER = process.env.BACKEND_URL_FOR_DOCKER || APP_HOST;

const uploadsRoot = path.join(__dirname, '..', '..', 'uploads');

/** Build a URL OnlyOffice (in Docker) can use to download a file under uploads/. */
const buildUploadFileUrl = (storagePath) => {
    const relativeUpload = path.relative(uploadsRoot, storagePath).replace(/\\/g, '/');
    if (!relativeUpload || relativeUpload.startsWith('..')) {
        return `${BACKEND_URL_FOR_DOCKER}/api/uploads/${path.basename(storagePath)}`;
    }
    return `${BACKEND_URL_FOR_DOCKER}/api/uploads/${relativeUpload}`;
};

/**
 * @param {object} contractRecord
 * @param {string} ext
 * @param {object} [options]
 * @param {string} [options.storagePath] override file path (e.g. version snapshot)
 * @param {string} [options.documentKey] override OnlyOffice key
 * @param {string} [options.title]
 * @param {boolean} [options.readOnly] view+comment history without edit
 */
const buildOnlyOfficeConfig = (contractRecord, ext = 'docx', options = {}) => {
    const isPdf = ext === 'pdf';
    const storagePath = options.storagePath || contractRecord.storage_path;
    const fileUrl = buildUploadFileUrl(storagePath);
    const readOnly = Boolean(options.readOnly) || isPdf;
    const callbackUrl = `${BACKEND_URL_FOR_DOCKER}/api/contracts/save-callback`;
    const payload = {
        document: {
            fileType: ext,
            key: options.documentKey || contractRecord.document_key,
            title: options.title || contractRecord.original_filename,
            url: fileUrl,
            permissions: {
                comment: !isPdf,
                download: true,
                edit: !readOnly,
                print: true,
                review: !isPdf,
            },
        },
        documentType: isPdf ? 'pdf' : 'word',
        editorConfig: {
            callbackUrl: readOnly ? undefined : callbackUrl,
            lang: 'zh-CN',
            mode: readOnly ? 'view' : 'edit',
            user: {
                id: `user-${contractRecord.user_id || 1}`,
                name: 'Reviewer',
            },
            customization: {
                forcesave: !readOnly,
                comments: true,
                compactHeader: true,
                compactToolbar: true,
                toolbarHideFileName: true,
                toolbarNoTabs: true,
                features: {
                    tabStyle: 'line',
                    tabBackground: 'toolbar',
                    spellcheck: false,
                },
                hideRightMenu: true,
                hideRulers: true,
                help: false,
                plugins: false,
                chat: false,
                feedback: false,
                goback: false,
            },
        },
    };
    return { ...payload, token: jwt.sign(payload, ONLYOFFICE_JWT_SECRET) };
};

const postOnlyOfficeCommand = async (payload) => {
    const commandPayload = ONLYOFFICE_JWT_SECRET
        ? { ...payload, token: jwt.sign(payload, ONLYOFFICE_JWT_SECRET) }
        : payload;

    const headers = { 'Content-Type': 'application/json' };
    if (ONLYOFFICE_JWT_SECRET) {
        headers.Authorization = `Bearer ${commandPayload.token}`;
    }

    const response = await axios.post(
        `${ONLYOFFICE_URL.replace(/\/$/, '')}/coauthoring/CommandService.ashx`,
        commandPayload,
        { headers, timeout: 10000 },
    );
    return response.data;
};

const parseConvertResponse = (data) => {
    if (data == null) return {};
    if (typeof data === 'object') return data;
    const text = String(data);
    try {
        return JSON.parse(text);
    } catch {
        /* XML fallback from older Document Server */
    }
    const endMatch = text.match(/<EndConvert[^>]*>([^<]*)<\/EndConvert>/i);
    const percentMatch = text.match(/<Percent[^>]*>([^<]*)<\/Percent>/i);
    const urlMatch = text.match(/<FileUrl[^>]*><!\[CDATA\[(.*?)\]\]><\/FileUrl>/i)
        || text.match(/<FileUrl[^>]*>([^<]*)<\/FileUrl>/i);
    const errorMatch = text.match(/<Error[^>]*>(-?\d+)<\/Error>/i);
    return {
        endConvert: endMatch ? String(endMatch[1]).toLowerCase() === 'true' : false,
        percent: percentMatch ? Number(percentMatch[1]) : 0,
        fileUrl: urlMatch ? urlMatch[1] : '',
        error: errorMatch ? Number(errorMatch[1]) : 0,
    };
};

/**
 * Convert a remote DOCX (reachable by OnlyOffice) to PDF bytes via ConvertService.
 * @param {{ fileUrl: string, key?: string, title?: string }} options
 * @returns {Promise<Buffer>}
 */
const convertDocumentToPdf = async ({ fileUrl, key, title } = {}) => {
    if (!fileUrl) throw new Error('fileUrl is required for conversion');
    const payload = {
        async: false,
        filetype: 'docx',
        outputtype: 'pdf',
        key: String(key || `convert-${uuidv4()}`).slice(0, 128),
        title: title || 'document.docx',
        url: fileUrl,
    };

    const token = ONLYOFFICE_JWT_SECRET ? jwt.sign(payload, ONLYOFFICE_JWT_SECRET) : null;
    const body = token ? { ...payload, token } : payload;
    const headers = {
        'Content-Type': 'application/json',
        Accept: 'application/json',
    };
    if (token) headers.Authorization = `Bearer ${token}`;

    const base = ONLYOFFICE_URL.replace(/\/$/, '');
    let response;
    try {
        response = await axios.post(`${base}/converter`, body, { headers, timeout: 180000 });
    } catch (err) {
        if (err.response?.status === 404 || err.code === 'ECONNREFUSED') {
            response = await axios.post(`${base}/ConvertService.ashx`, body, { headers, timeout: 180000 });
        } else {
            throw err;
        }
    }

    const parsed = parseConvertResponse(response.data);
    if (parsed.error && Number(parsed.error) !== 0) {
        throw new Error(`OnlyOffice convert failed: error=${parsed.error}`);
    }
    const resultUrl = parsed.fileUrl || parsed.url || parsed.fileurl;
    if (!resultUrl) {
        throw new Error('OnlyOffice convert returned no fileUrl');
    }

    const pdfResp = await axios.get(resultUrl, { responseType: 'arraybuffer', timeout: 180000 });
    return Buffer.from(pdfResp.data);
};

module.exports = {
    ONLYOFFICE_JWT_SECRET,
    ONLYOFFICE_URL,
    APP_HOST,
    BACKEND_URL_FOR_DOCKER,
    buildUploadFileUrl,
    buildOnlyOfficeConfig,
    postOnlyOfficeCommand,
    convertDocumentToPdf,
};
