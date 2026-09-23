// ==UserScript==
// @name         USST 一网畅学课件下载助手
// @name:zh-CN   USST 一网畅学课件下载助手
// @namespace    https://github.com/seabodylibra/Tronclass
// @version      1.1.0
// @description  为上海理工大学一网畅学提供课程附件下载功能，支持 PPT/PDF 等资源。
// @description:zh-CN 为上海理工大学一网畅学提供课程附件下载功能，支持 PPT/PDF 等资源。
// @author       seabodylibra
// @homepageURL  https://github.com/seabodylibra/Tronclass
// @supportURL   https://github.com/seabodylibra/Tronclass/issues
// @match        https://1906.usst.edu.cn/course/*
// @grant        GM_download
// @connect      1906.usst.edu.cn
// @run-at       document-idle
// @noframes
// @license      MIT
// ==/UserScript==

(function () {
    'use strict';

    const PANEL_ID = 'usst-tronclass-download-panel';
    const STYLE_ID = 'usst-tronclass-download-style';
    const ROUTE_POLL_INTERVAL = 500;
    const DOWNLOAD_GAP_MS = 700;

    const state = {
        activityId: null,
        courseId: null,
        routeKey: '',
        routeVersion: 0,
        references: [],
        listScope: 'none',
        courseScanFailures: 0,
        loading: false,
        downloading: false,
        message: '',
        messageKind: 'info',
        requestController: null,
        activeRun: null,
    };

    let ui = null;

    class ApiError extends Error {
        constructor(message, status, operation) {
            super(message);
            this.name = 'ApiError';
            this.status = status;
            this.operation = operation;
        }
    }

    class CancelledError extends Error {
        constructor() {
            super('页面已切换，已停止当前下载队列。');
            this.name = 'CancelledError';
        }
    }

    function logError(message, error) {
        console.error(`[USST 课件下载助手] ${message}`, error || '');
    }

    function logWarn(message, error) {
        console.warn(`[USST 课件下载助手] ${message}`, error || '');
    }

    function isValidActivityCandidate(value) {
        return typeof value === 'string'
            && /^[A-Za-z0-9_-]{1,128}$/.test(value)
            && !/^(course|courses|activity|activities|learning-activity|home|index)$/i.test(value);
    }

    function activityCandidate(value) {
        if (value === null || value === undefined) return null;
        let result = String(value).trim();
        try {
            result = decodeURIComponent(result);
        } catch (error) {
            logWarn('URL 中的活动 ID 无法完整解码，将使用原始值。', error);
        }
        return isValidActivityCandidate(result) ? result : null;
    }

    function findActivityInRoute(route) {
        const cleaned = String(route || '').replace(/^#?\/+/, '');
        const namedRoute = cleaned.match(/(?:^|\/)(?:learning-activity|activity|activities)\/([^/?#]+)/i);
        if (namedRoute) return activityCandidate(namedRoute[1]);

        const parts = cleaned.split(/[/?#]/).filter(Boolean);
        if (parts.length >= 1) return activityCandidate(parts[0]);
        return null;
    }

    function getActivityId() {
        const hashId = findActivityInRoute(window.location.hash);
        if (hashId) return hashId;

        const pathMatch = window.location.pathname.match(/\/learning-activity\/([^/?#]+)/i);
        if (pathMatch) return activityCandidate(pathMatch[1]);

        const params = new URLSearchParams(window.location.search);
        for (const key of ['activityId', 'activity_id', 'activity']) {
            const id = activityCandidate(params.get(key));
            if (id) return id;
        }

        return null;
    }

    function getCourseId() {
        const match = window.location.pathname.match(/^\/course\/([A-Za-z0-9_-]+)(?:\/|$)/i);
        return match ? activityCandidate(match[1]) : null;
    }

    function getErrorMessage(error) {
        if (error instanceof CancelledError) return error.message;
        if (error instanceof ApiError) {
            if (error.status === 401) return '登录状态已失效，请先登录一网畅学。';
            if (error.status === 403) return '当前账号无权访问该活动或附件。';
            if (error.status === 404) return '活动或附件不存在，可能已被删除。';
            if (error.status >= 500) return '一网畅学服务暂时异常，请稍后重试。';
            return error.message;
        }
        if (error && error.name === 'AbortError') return '请求已取消。';
        if (error instanceof TypeError) return '网络请求失败，请检查网络或登录状态。';
        return error && error.message ? error.message : '发生未知错误，请查看控制台日志。';
    }

    function setMessage(message, kind) {
        state.message = message || '';
        state.messageKind = kind || 'info';
        render();
    }

    async function requestJson(url, operation, signal) {
        let response;
        try {
            response = await fetch(url, {
                method: 'GET',
                credentials: 'include',
                headers: { Accept: 'application/json' },
                signal,
            });
        } catch (error) {
            logError(`${operation} 请求失败。`, error);
            throw error;
        }

        const text = await response.text();
        if (!response.ok) {
            const error = new ApiError(`${operation} 返回 HTTP ${response.status}。`, response.status, operation);
            logError(`${operation} 请求被服务器拒绝。`, { status: response.status, bodyLength: text.length });
            throw error;
        }
        if (!text.trim()) {
            const message = operation === '获取预览地址'
                ? '预览地址为空，预览可能仍在生成或生成失败。'
                : `${operation} 返回为空。`;
            const error = new ApiError(message, response.status, operation);
            logError(`${operation} 返回空响应。`, error);
            throw error;
        }

        try {
            return JSON.parse(text);
        } catch (error) {
            logError(`${operation} 返回的不是有效 JSON。`, { parseError: error, bodyLength: text.length });
            throw new ApiError(`${operation} 返回格式异常。`, response.status, operation);
        }
    }

    function pickString(...values) {
        for (const value of values) {
            if (typeof value === 'string' && value.trim()) return value.trim();
            if (typeof value === 'number' && Number.isFinite(value)) return String(value);
        }
        return '';
    }

    function getReferenceArray(payload) {
        if (Array.isArray(payload)) return payload;
        if (!payload || typeof payload !== 'object') return [];
        if (Array.isArray(payload.references)) return payload.references;
        if (payload.data && Array.isArray(payload.data.references)) return payload.data.references;
        if (Array.isArray(payload.uploads)) return payload.uploads;
        if (payload.data && Array.isArray(payload.data.uploads)) return payload.data.uploads;
        return [];
    }

    function hasReferenceList(payload) {
        return Array.isArray(payload)
            || Boolean(payload && typeof payload === 'object' && (
                Array.isArray(payload.references)
                || Array.isArray(payload.uploads)
                || (payload.data && Array.isArray(payload.data.references))
                || (payload.data && Array.isArray(payload.data.uploads))
            ));
    }

    function getCourseActivityArray(payload) {
        if (!payload || typeof payload !== 'object') return null;
        if (Array.isArray(payload.activities)) return payload.activities;
        if (payload.data && Array.isArray(payload.data.activities)) return payload.data.activities;
        return null;
    }

    function normaliseReferences(payload) {
        const items = getReferenceArray(payload);
        const seen = new Set();
        const references = [];

        items.forEach((item, index) => {
            if (!item || typeof item !== 'object') {
                logWarn(`附件 ${index + 1} 的数据不是对象，已跳过。`);
                return;
            }

            const nestedReference = item.reference && typeof item.reference === 'object' ? item.reference : {};
            const nestedUpload = item.upload && typeof item.upload === 'object' ? item.upload : {};
            const referenceId = pickString(
                item.id,
                item.reference_id,
                item.referenceId,
                nestedReference.id,
                nestedReference.reference_id,
                nestedUpload.reference_id,
            );
            const name = pickString(
                item.name,
                item.file_name,
                item.filename,
                item.fileName,
                item.original_name,
                nestedReference.name,
                nestedReference.file_name,
                nestedUpload.name,
                nestedUpload.file_name,
            );

            if (referenceId && seen.has(referenceId)) {
                logWarn(`检测到重复 reference ID：${referenceId}，已跳过重复附件。`);
                return;
            }
            if (referenceId) seen.add(referenceId);
            references.push({
                referenceId,
                originalName: name,
                name: name || `附件-${index + 1}`,
                status: referenceId ? '待下载' : '缺少 reference ID',
                error: referenceId ? '' : '平台返回的附件没有 reference ID。',
            });
        });

        if (!items.length && payload && typeof payload === 'object') {
            logWarn('附件 API 没有找到 references/uploads 数组。', Object.keys(payload));
        }
        return references;
    }

    async function loadReferences(activityId, routeVersion) {
        if (!activityId || state.loading) return;
        state.loading = true;
        state.listScope = 'activity';
        state.message = '正在读取附件列表…';
        state.messageKind = 'info';
        state.references = [];
        render();

        const controller = new AbortController();
        state.requestController = controller;
        const endpoint = `${window.location.origin}/api/activities/${encodeURIComponent(activityId)}/upload_references`;

        try {
            const payload = await requestJson(endpoint, '读取附件列表', controller.signal);
            if (routeVersion !== state.routeVersion || activityId !== state.activityId) return;
            if (!hasReferenceList(payload)) {
                throw new ApiError('附件列表返回结构异常。', 200, '读取附件列表');
            }

            state.references = normaliseReferences(payload);
            state.message = state.references.length ? '附件列表已更新。' : '当前活动没有可见附件。';
            state.messageKind = state.references.length ? 'success' : 'info';
        } catch (error) {
            if (error && error.name === 'AbortError') return;
            if (routeVersion !== state.routeVersion || activityId !== state.activityId) return;
            state.message = getErrorMessage(error);
            state.messageKind = 'error';
            logError('读取附件列表失败。', error);
        } finally {
            if (routeVersion === state.routeVersion && activityId === state.activityId) {
                state.loading = false;
                state.requestController = null;
                render();
            }
        }
    }

    async function collectCourseReferences(courseId, routeVersion) {
        const courseUrl = `${window.location.origin}/api/courses/${encodeURIComponent(courseId)}/activities?sub_course_id=0`;
        const payload = await requestJson(courseUrl, '读取课程活动列表', null);
        const activities = getCourseActivityArray(payload);
        if (!activities) {
            throw new ApiError('课程活动列表返回结构异常。', 200, '读取课程活动列表');
        }

        const references = [];
        const seenReferences = new Set();
        let failures = 0;

        for (const activity of activities) {
            if (routeVersion !== state.routeVersion || courseId !== state.courseId) {
                throw new CancelledError();
            }
            if (!activity || activity.id === undefined || activity.id === null) {
                failures += 1;
                logWarn('课程活动列表中有项目缺少活动 ID，已跳过。', activity);
                continue;
            }

            const activityId = String(activity.id);
            const activityTitle = pickString(activity.title, activity.name, `活动 ${activityId}`);
            const endpoint = `${window.location.origin}/api/activities/${encodeURIComponent(activityId)}/upload_references`;
            try {
                const activityPayload = await requestJson(endpoint, `读取活动“${activityTitle}”的附件`, null);
                if (!hasReferenceList(activityPayload)) {
                    failures += 1;
                    logWarn(`活动“${activityTitle}”的附件列表结构异常，已跳过。`, activityPayload);
                    continue;
                }

                for (const reference of normaliseReferences(activityPayload)) {
                    if (reference.referenceId && seenReferences.has(reference.referenceId)) {
                        logWarn(`课程内发现重复 reference ID：${reference.referenceId}，已跳过重复附件。`);
                        continue;
                    }
                    if (reference.referenceId) seenReferences.add(reference.referenceId);
                    reference.activityId = activityId;
                    reference.activityTitle = activityTitle;
                    references.push(reference);
                }
            } catch (error) {
                if (error instanceof CancelledError) throw error;
                failures += 1;
                logWarn(`读取活动“${activityTitle}”的附件失败，继续扫描课程其他活动。`, error);
            }
        }

        return { references, failures, activityCount: activities.length };
    }

    async function downloadWholeCourse() {
        if (!state.courseId || state.loading || state.downloading) return;
        const courseId = state.courseId;
        const routeVersion = state.routeVersion;
        state.loading = true;
        state.courseScanFailures = 0;
        state.references = [];
        state.message = '正在读取本课程活动和附件列表…';
        state.messageKind = 'info';
        render();

        let result;
        try {
            result = await collectCourseReferences(courseId, routeVersion);
            if (routeVersion !== state.routeVersion || courseId !== state.courseId) return;
            state.references = result.references;
            state.listScope = 'course';
            state.courseScanFailures = result.failures;
        } catch (error) {
            if (error instanceof CancelledError) return;
            if (routeVersion === state.routeVersion && courseId === state.courseId) {
                state.message = getErrorMessage(error);
                state.messageKind = 'error';
                logError('读取本课程附件列表失败。', error);
            }
            return;
        } finally {
            if (routeVersion === state.routeVersion && courseId === state.courseId) {
                state.loading = false;
                render();
            }
        }

        if (routeVersion !== state.routeVersion || courseId !== state.courseId) return;
        if (!state.references.length) {
            state.message = result.failures
                ? `没有找到可下载附件；${result.failures} 个活动读取失败。`
                : '本课程没有可见附件。';
            state.messageKind = result.failures ? 'warning' : 'info';
            render();
            return;
        }

        state.message = `已收集 ${state.references.length} 个附件（扫描 ${result.activityCount} 个活动），开始按顺序下载…`;
        state.messageKind = result.failures ? 'warning' : 'info';
        render();
        await runDownloads(state.references.slice(), 'course');
    }

    function sanitiseFilename(input, fallback) {
        let name = String(input || '').trim() || fallback;
        name = name.replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_');
        name = name.replace(/[ .]+$/g, '').trim();
        if (!name) name = fallback;
        if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i.test(name)) name = `_${name}`;
        return name.slice(0, 180);
    }

    function previewFilename(originalName, fallback) {
        const source = sanitiseFilename(originalName, fallback);
        if (/\.(pptx?|docx?|xlsx?)$/i.test(source)) {
            return source.replace(/\.[^.]+$/, '.pdf');
        }
        return source.toLowerCase().endsWith('.pdf') ? source : `${source}.pdf`;
    }

    function getUrlFromPayload(payload) {
        if (typeof payload === 'string') return payload.trim();
        if (!payload || typeof payload !== 'object') return '';
        return pickString(
            payload.url,
            payload.download_url,
            payload.downloadUrl,
            payload.data && payload.data.url,
            payload.data && payload.data.download_url,
        );
    }

    function validateDownloadUrl(value) {
        let url;
        try {
            url = new URL(value, window.location.origin);
        } catch (error) {
            throw new Error('平台返回的下载地址无效。');
        }
        if (url.protocol !== 'http:' && url.protocol !== 'https:') {
            throw new Error('平台返回了不支持的下载协议。');
        }
        return url.href;
    }

    async function getReferenceUrl(referenceId, preview, signal) {
        const suffix = preview ? '?preview=true' : '';
        const endpoint = `${window.location.origin}/api/uploads/reference/document/${encodeURIComponent(referenceId)}/url${suffix}`;
        const payload = await requestJson(endpoint, preview ? '获取预览地址' : '获取原文件地址', signal);
        const url = getUrlFromPayload(payload);
        if (!url) {
            const message = preview ? '预览地址为空，预览可能仍在生成或生成失败。' : '原文件地址为空。';
            throw new ApiError(message, 200, preview ? '获取预览地址' : '获取原文件地址');
        }
        return validateDownloadUrl(url);
    }

    function downloadErrorMessage(details) {
        const code = details && (details.error || details.errorCode);
        const known = {
            abort: '下载被取消。',
            not_enabled: '用户脚本管理器未启用下载权限。',
            not_permitted: '浏览器阻止了此次下载，请允许本站点下载多个文件。',
            not_whitelisted: '下载地址未被用户脚本管理器允许。',
            not_found: '下载地址已失效或文件不存在。',
            unknown: '浏览器报告下载失败。',
        };
        return known[code] || (code ? `浏览器下载失败（${code}）。` : '浏览器下载失败。');
    }

    async function downloadViaBlob(url, filename, expectPdf) {
        const response = await fetch(url, { credentials: 'include' });
        if (!response.ok) {
            throw new ApiError(`下载文件返回 HTTP ${response.status}。`, response.status, '下载文件');
        }
        const contentType = (response.headers.get('content-type') || '').toLowerCase();
        const blob = await response.blob();
        if (expectPdf) {
            const header = await blob.slice(0, 5).text();
            const isPdf = contentType.includes('application/pdf')
                || blob.type.toLowerCase().includes('application/pdf')
                || header === '%PDF-'
                || /\.pdf(?:$|[?#])/i.test(url);
            if (!isPdf) throw new Error('预览地址没有返回 PDF，可能仍在生成或只提供了在线查看器。');
        }

        const objectUrl = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = objectUrl;
        anchor.download = filename;
        anchor.rel = 'noopener';
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        window.setTimeout(() => URL.revokeObjectURL(objectUrl), 10000);
    }

    function startDownload(url, filename, expectPdf) {
        if (expectPdf) return downloadViaBlob(url, filename, true);
        if (typeof GM_download !== 'function') {
            logWarn('GM_download 不可用，尝试使用浏览器 Blob 下载。');
            return downloadViaBlob(url, filename, false);
        }

        return new Promise((resolve, reject) => {
            let finished = false;
            const finish = (callback, value) => {
                if (finished) return;
                finished = true;
                callback(value);
            };

            try {
                GM_download({
                    url,
                    name: filename,
                    saveAs: false,
                    conflictAction: 'uniquify',
                    onload: () => finish(resolve),
                    onerror: (details) => finish(reject, new Error(downloadErrorMessage(details))),
                    ontimeout: () => finish(reject, new Error('下载超时。')),
                    onabort: () => finish(reject, new Error('下载被取消。')),
                });
            } catch (error) {
                finish(reject, error);
            }
        }).catch((error) => {
            logWarn('GM_download 失败，尝试 Blob 下载。', error);
            return downloadViaBlob(url, filename);
        });
    }

    function ensureRunActive(run) {
        if (!run || run.cancelled || state.activeRun !== run || run.version !== state.routeVersion
            || run.activityId !== state.activityId || run.courseId !== state.courseId) {
            throw new CancelledError();
        }
    }

    function wait(milliseconds) {
        return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
    }

    async function downloadReference(reference, run) {
        ensureRunActive(run);
        if (!reference.referenceId) {
            reference.status = '失败';
            reference.error = '缺少 reference ID，无法请求下载地址。';
            render();
            return false;
        }

        const originalFilename = sanitiseFilename(reference.originalName || reference.name, '附件');
        reference.status = '获取原文件地址…';
        reference.error = '';
        render();

        try {
            const originalUrl = await getReferenceUrl(reference.referenceId, false, null);
            ensureRunActive(run);
            reference.status = '下载原文件…';
            render();
            await startDownload(originalUrl, originalFilename);
            reference.status = '已完成（原文件）';
            render();
            return true;
        } catch (originalError) {
            ensureRunActive(run);
            logWarn(`原文件不可用：${reference.name}，尝试预览地址。`, originalError);
        }

        reference.status = '获取预览地址…';
        render();
        try {
            const previewUrl = await getReferenceUrl(reference.referenceId, true, null);
            ensureRunActive(run);
            reference.status = '下载预览文件…';
            render();
            await startDownload(previewUrl, previewFilename(reference.originalName || reference.name, '附件'), true);
            reference.status = '已完成（预览 PDF）';
            render();
            return true;
        } catch (previewError) {
            ensureRunActive(run);
            reference.status = '失败';
            reference.error = `原文件和预览均不可用：${getErrorMessage(previewError)}`;
            logError(`附件下载失败：${reference.name}`, previewError);
            render();
            return false;
        }
    }

    async function runDownloads(references, scope = 'activity') {
        if (state.downloading) {
            setMessage('已有下载任务正在进行，请等待当前任务结束。', 'warning');
            return;
        }
        if ((!state.activityId && scope !== 'course') || !references.length) {
            setMessage('当前没有可下载的附件。', 'warning');
            return;
        }

        const run = {
            activityId: state.activityId,
            courseId: state.courseId,
            version: state.routeVersion,
            cancelled: false,
        };
        state.activeRun = run;
        state.downloading = true;
        state.message = '下载任务已开始，将按顺序处理附件。';
        state.messageKind = 'info';
        render();

        let successCount = 0;
        let attemptedCount = 0;
        try {
            for (const reference of references) {
                ensureRunActive(run);
                if (reference.status.startsWith('已完成')) continue;
                attemptedCount += 1;
                if (await downloadReference(reference, run)) successCount += 1;
                await wait(DOWNLOAD_GAP_MS);
            }
            ensureRunActive(run);
            const failedCount = attemptedCount - successCount;
            const scopeName = scope === 'course' ? '本课程' : '当前活动';
            const scanNote = scope === 'course' && state.courseScanFailures
                ? `另有 ${state.courseScanFailures} 个活动读取附件失败。`
                : '';
            state.message = `下载完成（${scopeName}）：${successCount}/${attemptedCount} 个附件成功。${scanNote}`;
            state.messageKind = failedCount === 0 && !state.courseScanFailures ? 'success' : 'warning';
        } catch (error) {
            if (!(error instanceof CancelledError)) {
                state.message = getErrorMessage(error);
                state.messageKind = 'error';
                logError('下载队列中断。', error);
            }
        } finally {
            if (state.activeRun === run) {
                state.activeRun = null;
                state.downloading = false;
                render();
            }
        }
    }

    function createUi() {
        const existingPanel = document.getElementById(PANEL_ID);
        if (existingPanel) {
            existingPanel.remove();
            const existingStyle = document.getElementById(STYLE_ID);
            if (existingStyle) existingStyle.remove();
        }

        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = `
            #${PANEL_ID} { position: fixed; z-index: 2147483647; top: 96px; right: 18px; width: 320px; max-height: calc(100vh - 120px); overflow: auto; box-sizing: border-box; padding: 14px; color: #1f2937; background: #fff; border: 1px solid #d1d5db; border-radius: 10px; box-shadow: 0 8px 28px rgba(0,0,0,.18); font: 14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif; }
            #${PANEL_ID} * { box-sizing: border-box; }
            #${PANEL_ID} .usst-title { margin: 0 0 8px; font-size: 16px; font-weight: 700; }
            #${PANEL_ID} .usst-meta { margin: 4px 0; color: #4b5563; word-break: break-all; }
            #${PANEL_ID} .usst-message { margin: 10px 0; padding: 8px; border-radius: 6px; background: #f3f4f6; }
            #${PANEL_ID} .usst-message.error { color: #991b1b; background: #fee2e2; }
            #${PANEL_ID} .usst-message.warning { color: #92400e; background: #fef3c7; }
            #${PANEL_ID} .usst-message.success { color: #166534; background: #dcfce7; }
            #${PANEL_ID} .usst-actions { display: flex; flex-wrap: wrap; gap: 6px; margin: 10px 0; }
            #${PANEL_ID} button { padding: 6px 9px; color: #fff; background: #2563eb; border: 0; border-radius: 5px; cursor: pointer; font: inherit; }
            #${PANEL_ID} button.secondary { color: #1f2937; background: #e5e7eb; }
            #${PANEL_ID} button:disabled { cursor: not-allowed; opacity: .55; }
            #${PANEL_ID} .usst-list { margin: 8px 0 0; padding: 0; list-style: none; }
            #${PANEL_ID} .usst-item { margin: 6px 0; padding: 8px; background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 6px; }
            #${PANEL_ID} .usst-name { display: block; font-weight: 600; word-break: break-word; }
            #${PANEL_ID} .usst-context { display: block; color: #6b7280; font-size: 12px; word-break: break-word; }
            #${PANEL_ID} .usst-status { display: block; color: #4b5563; font-size: 12px; }
            #${PANEL_ID} .usst-error { display: block; color: #b91c1c; font-size: 12px; word-break: break-word; }
        `;
        document.head.appendChild(style);

        const panel = document.createElement('section');
        panel.id = PANEL_ID;
        panel.setAttribute('aria-label', 'USST 一网畅学课件下载助手');
        panel.innerHTML = `
            <h2 class="usst-title">一网畅学课件下载助手</h2>
            <div class="usst-meta">活动 ID：<span data-field="activity">未识别</span></div>
            <div class="usst-meta">课程 ID：<span data-field="course">未识别</span></div>
            <div class="usst-meta">附件数量：<span data-field="count">0</span></div>
            <div class="usst-actions">
                <button type="button" data-action="refresh">刷新附件</button>
                <button type="button" data-action="current">下载当前课件</button>
                <button type="button" class="secondary" data-action="all">下载本活动附件</button>
                <button type="button" data-action="course">下载本课程全部附件</button>
            </div>
            <div class="usst-message" data-field="message" role="status"></div>
            <ul class="usst-list" data-field="list"></ul>
        `;
        document.body.appendChild(panel);

        ui = {
            panel,
            activity: panel.querySelector('[data-field="activity"]'),
            course: panel.querySelector('[data-field="course"]'),
            count: panel.querySelector('[data-field="count"]'),
            message: panel.querySelector('[data-field="message"]'),
            list: panel.querySelector('[data-field="list"]'),
            refresh: panel.querySelector('[data-action="refresh"]'),
            current: panel.querySelector('[data-action="current"]'),
            all: panel.querySelector('[data-action="all"]'),
            courseAll: panel.querySelector('[data-action="course"]'),
        };

        ui.refresh.addEventListener('click', () => {
            if (state.activityId && !state.loading) {
                state.routeVersion += 1;
                if (state.requestController) state.requestController.abort();
                state.references = [];
                loadReferences(state.activityId, state.routeVersion);
            }
        });
        ui.current.addEventListener('click', () => runDownloads(state.references.slice(0, 1)));
        ui.all.addEventListener('click', () => runDownloads(state.references.slice()));
        ui.courseAll.addEventListener('click', downloadWholeCourse);
        render();
    }

    function render() {
        if (!ui) return;
        ui.activity.textContent = state.activityId || '未识别';
        ui.course.textContent = state.courseId || '未识别';
        ui.count.textContent = String(state.references.length);
        ui.message.textContent = state.message || (state.loading ? '正在处理…' : '');
        ui.message.className = `usst-message ${state.messageKind || 'info'}`;
        ui.refresh.disabled = !state.activityId || state.loading || state.downloading;
        ui.current.disabled = !state.activityId || state.listScope !== 'activity' || !state.references.length || state.loading || state.downloading;
        ui.all.disabled = !state.activityId || state.listScope !== 'activity' || !state.references.length || state.loading || state.downloading;
        ui.courseAll.disabled = !state.courseId || state.loading || state.downloading;

        ui.list.replaceChildren();
        state.references.forEach((reference) => {
            const item = document.createElement('li');
            item.className = 'usst-item';
            const name = document.createElement('span');
            name.className = 'usst-name';
            name.textContent = reference.name;
            if (reference.activityTitle) {
                const context = document.createElement('span');
                context.className = 'usst-context';
                context.textContent = reference.activityTitle;
                item.appendChild(context);
            }
            const status = document.createElement('span');
            status.className = 'usst-status';
            status.textContent = reference.status;
            item.append(name, status);
            if (reference.error) {
                const error = document.createElement('span');
                error.className = 'usst-error';
                error.textContent = reference.error;
                item.appendChild(error);
            }
            ui.list.appendChild(item);
        });
    }

    function syncRoute() {
        const routeKey = window.location.href;
        if (routeKey === state.routeKey) return;
        state.routeKey = routeKey;
        state.routeVersion += 1;
        if (state.requestController) state.requestController.abort();
        if (state.activeRun) state.activeRun.cancelled = true;
        state.activityId = getActivityId();
        state.courseId = getCourseId();
        state.references = [];
        state.listScope = state.activityId ? 'activity' : 'none';
        state.courseScanFailures = 0;
        state.loading = false;
        state.message = state.activityId
            ? '正在识别当前活动…'
            : state.courseId
                ? '课程级附件下载可用；当前活动附件请进入课件详情页。'
                : '未识别到课程或活动页面。';
        state.messageKind = state.activityId || state.courseId ? 'info' : 'warning';
        render();
        if (state.activityId) loadReferences(state.activityId, state.routeVersion);
    }

    function init() {
        createUi();
        syncRoute();
        window.addEventListener('hashchange', syncRoute);
        window.addEventListener('popstate', syncRoute);
        window.setInterval(syncRoute, ROUTE_POLL_INTERVAL);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
        init();
    }
})();

