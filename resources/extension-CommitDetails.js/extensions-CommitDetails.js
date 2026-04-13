/**
 * Service Commit Extension
 *
 * Replaces Author/Comment rows in SYNC STATUS and LAST SYNC panels with
 * actual service details from _live_build.yml, fetched via ArgoCD's own
 * repo credentials using POST /api/v1/repositories/{repo}/appdetails.
 */
((window) => {

    function getAppNameFromUrl() {
        const parts = window.location.pathname.split('/').filter(Boolean);
        const idx = parts.indexOf('applications');
        if (idx < 0 || idx + 1 >= parts.length) return null;
        const subRoutes = new Set(['events', 'diff', 'sync', 'history', 'parameters', 'summary']);
        const candidates = parts.slice(idx + 1).filter(p => !subRoutes.has(p));
        return candidates[candidates.length - 1] || null;
    }

    async function fetchAppData(appName) {
        try {
            const resp = await fetch(`/api/v1/applications/${encodeURIComponent(appName)}`);
            if (!resp.ok) return null;
            return resp.json();
        } catch (_) {
            return null;
        }
    }

    // targetRevision must be the actual commit SHA (not "main") and versionId
    // must be the history entry id — required to pass ArgoCD's source-in-history check.
    async function fetchBuildParams(source, revision, appName, appProject, versionId) {
        try {
            const resp = await fetch(
                `/api/v1/repositories/${encodeURIComponent(source.repoURL)}/appdetails`,
                {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({source: {...source, targetRevision: revision}, appName, appProject, sourceIndex: 0, versionId})
                }
            );
            if (!resp.ok) return null;
            const details = await resp.json();
            const params = (details.helm && details.helm.parameters) || [];
            const get = name => (params.find(p => p.name === name) || {}).value || null;
            return {commit: get('build.commit'), slackUsername: get('build.slackUsername')};
        } catch (_) {
            return null;
        }
    }

    function parseAppMeta(app) {
        const source = (app.spec.sources && app.spec.sources[0]) || app.spec.source;
        if (!source) return null;

        const history = app.status.history || [];
        const lastEntry = history[history.length - 1] || null;
        const syncRevision = (app.status.sync.revisions && app.status.sync.revisions[0]) || app.status.sync.revision;
        const syncEntry = history.find(h => (h.revisions && h.revisions[0]) === syncRevision) || lastEntry;

        const rev = e => e ? (e.revisions && e.revisions[0]) || e.revision : null;

        return {
            source,
            appProject:       app.spec.project,
            syncRevision:     rev(syncEntry),
            syncVersionId:    syncEntry ? syncEntry.id : null,
            lastSyncRevision: rev(lastEntry),
            lastSyncVersionId: lastEntry ? lastEntry.id : null
        };
    }

    // DOM helpers

    function findRows(panelItem) {
        const rows = panelItem.querySelectorAll('.application-status-panel__item__row');
        let authorRow = null, commentRow = null;
        for (const row of rows) {
            const label = row.querySelector('div:first-child');
            if (!label) continue;
            const text = label.textContent.trim();
            if (text === 'Author:') authorRow = row;
            if (text === 'Comment:') commentRow = row;
        }
        return {authorRow, commentRow};
    }

    const COMMIT_ROW_ATTR = 'data-svc-commit-row';

    function setRowValue(row, value) {
        if (!row || !value) return;
        const valueDiv = row.querySelector('div:last-child');
        if (valueDiv) { valueDiv.textContent = value; valueDiv.title = value; }
    }

    function injectCommitRow(afterRow, commit) {
        if (!afterRow || !commit) return;
        const parent = afterRow.parentElement;
        if (!parent) return;
        let row = parent.querySelector(`[${COMMIT_ROW_ATTR}]`);
        if (!row) {
            row = document.createElement('div');
            row.className = afterRow.className;
            row.setAttribute(COMMIT_ROW_ATTR, 'true');
            const label = document.createElement('div');
            label.textContent = 'Commit:';
            row.appendChild(label);
            row.appendChild(document.createElement('div'));
            afterRow.insertAdjacentElement('afterend', row);
        }
        const valueDiv = row.querySelector('div:last-child');
        if (valueDiv) { valueDiv.textContent = commit; valueDiv.title = commit; }
    }

    function showLoading(panelItem) {
        const {authorRow, commentRow} = findRows(panelItem);
        if (!authorRow) return;
        setRowValue(authorRow, '...');
        if (commentRow) commentRow.style.display = 'none';
    }

    function applyToPanel(panelItem, build) {
        if (!build) return;
        const {authorRow, commentRow} = findRows(panelItem);
        if (!authorRow) return;
        if (commentRow) commentRow.style.display = 'none';
        setRowValue(authorRow, build.slackUsername);
        injectCommitRow(authorRow, build.commit);
    }

    // State

    let cachedSyncBuild = null;
    let cachedLastSyncBuild = null;
    let fetchInFlight = false;

    async function prefetch(appName) {
        if (fetchInFlight || cachedSyncBuild || cachedLastSyncBuild) return;
        fetchInFlight = true;
        const app = await fetchAppData(appName);
        if (app) {
            const meta = parseAppMeta(app);
            if (meta) {
                const {source, appProject, syncRevision, syncVersionId, lastSyncRevision, lastSyncVersionId} = meta;
                [cachedSyncBuild, cachedLastSyncBuild] = await Promise.all([
                    fetchBuildParams(source, syncRevision, appName, appProject, syncVersionId),
                    fetchBuildParams(source, lastSyncRevision, appName, appProject, lastSyncVersionId)
                ]);
            }
        }
        fetchInFlight = false;
        const panels = Array.from(document.querySelectorAll('.application-status-panel__item'));
        if (panels[1]) applyToPanel(panels[1], cachedSyncBuild);
        if (panels[2]) applyToPanel(panels[2], cachedLastSyncBuild);
    }

    function paint() {
        const appName = getAppNameFromUrl();
        if (!appName) return;
        const panels = Array.from(document.querySelectorAll('.application-status-panel__item'));
        const syncPanel = panels[1];
        const lastSyncPanel = panels[2];
        if (!syncPanel && !lastSyncPanel) return;

        if (cachedSyncBuild || cachedLastSyncBuild) {
            if (syncPanel) applyToPanel(syncPanel, cachedSyncBuild);
            if (lastSyncPanel) applyToPanel(lastSyncPanel, cachedLastSyncBuild);
        } else {
            if (syncPanel) showLoading(syncPanel);
            if (lastSyncPanel) showLoading(lastSyncPanel);
            prefetch(appName);
        }
    }

    function debounce(fn, ms) {
        let t;
        return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
    }

    new MutationObserver(debounce(paint, 200)).observe(document.body, {childList: true, subtree: true});

    let lastPath = window.location.pathname;
    setInterval(() => {
        if (window.location.pathname !== lastPath) {
            lastPath = window.location.pathname;
            cachedSyncBuild = null;
            cachedLastSyncBuild = null;
            const appName = getAppNameFromUrl();
            if (appName) prefetch(appName);
        }
    }, 300);

    const initialApp = getAppNameFromUrl();
    if (initialApp) prefetch(initialApp);

})(window);
