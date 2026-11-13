((window) => {
    const h = React.createElement;
    const CONCURRENCY = 5;
    const AUTO_SYNC_POLICY = {prune: true};

    async function apiRequest(method, path, body) {
        const resp = await fetch(path, {
            method,
            headers: {'Content-Type': 'application/json'},
            body: body ? JSON.stringify(body) : undefined
        });
        if (!resp.ok) {
            const data = await resp.json().catch(() => ({}));
            throw new Error(data.message || `Request failed: ${resp.status} ${resp.statusText}`);
        }
        return resp.json().catch(() => ({}));
    }

    async function runPool(items, worker) {
        let next = 0;
        const runners = Array.from({length: Math.min(CONCURRENCY, items.length)}, async () => {
            while (next < items.length) {
                const item = items[next++];
                await worker(item);
            }
        });
        await Promise.all(runners);
    }

    const appPath = name => `/api/v1/applications/${encodeURIComponent(name)}`;
    const destNs = app => (app.spec && app.spec.destination && app.spec.destination.namespace) || '';
    const branchOf = app => (app.metadata.labels && app.metadata.labels.branch) || '';
    const isAutoSync = app => !!(app.spec.syncPolicy && app.spec.syncPolicy.automated);
    const historyOf = app => (app.status && app.status.history) || [];
    const shortSha = sha => (sha ? sha.slice(0, 10) : '');

    async function listApps(selector, fields) {
        const params = new URLSearchParams();
        if (selector) params.set('selector', selector);
        if (fields) params.set('fields', fields.join(','));
        const qs = params.toString();
        const data = await apiRequest('GET', `/api/v1/applications${qs ? `?${qs}` : ''}`);
        return data.items || [];
    }

    const buildCommitCache = {};

    function entrySources(entry) {
        const multi = entry.sources && entry.sources.length > 0;
        return {
            sources: multi ? entry.sources : [entry.source],
            revisions: multi ? entry.revisions || [] : [entry.revision]
        };
    }

    async function resolveBuildCommit(app, entry) {
        const {sources, revisions} = entrySources(entry);
        const key = `${app.metadata.name}|${revisions.join(',')}`;
        if (buildCommitCache[key] !== undefined) return buildCommitCache[key];
        let result = null;
        for (let i = 0; i < sources.length && !result; i++) {
            const source = sources[i];
            if (!source || !source.repoURL) continue;
            try {
                const data = await apiRequest('POST', `/api/v1/repositories/${encodeURIComponent(source.repoURL)}/appdetails`, {
                    source: {...source, targetRevision: revisions[i]},
                    appName: app.metadata.name,
                    appProject: app.spec.project,
                    sourceIndex: i,
                    versionId: entry.id
                });
                const params = (data.helm && data.helm.parameters) || [];
                const commit = params.find(p => p.name === 'build.commit');
                const slack = params.find(p => p.name === 'build.slackUsername');
                if (commit) result = {commit: commit.value, slackUsername: slack ? slack.value : null};
            } catch (_) {}
        }
        buildCommitCache[key] = result;
        return result;
    }

    async function resolveAppHistories(apps) {
        const tasks = [];
        apps.forEach(app => historyOf(app).forEach(entry => tasks.push({app, entry})));
        const out = {};
        await runPool(tasks, async ({app, entry}) => {
            const meta = await resolveBuildCommit(app, entry);
            out[app.metadata.name] = out[app.metadata.name] || {};
            out[app.metadata.name][entry.id] = meta;
        });
        return out;
    }

    function rollbackTargets(apps, histories) {
        const byCommit = {};
        apps.forEach(app => {
            const metas = histories[app.metadata.name] || {};
            historyOf(app).forEach(entry => {
                const meta = metas[entry.id];
                if (!meta) return;
                const t = byCommit[meta.commit] || {commit: meta.commit, slackUsername: meta.slackUsername, deployedAt: entry.deployedAt, apps: new Set()};
                if (entry.deployedAt && (!t.deployedAt || entry.deployedAt > t.deployedAt)) t.deployedAt = entry.deployedAt;
                t.apps.add(app.metadata.name);
                byCommit[meta.commit] = t;
            });
        });
        return Object.values(byCommit).sort((a, b) => (b.deployedAt || '').localeCompare(a.deployedAt || ''));
    }

    function findEntryForCommit(app, histories, commit) {
        const metas = histories[app.metadata.name] || {};
        const matches = historyOf(app).filter(e => metas[e.id] && metas[e.id].commit === commit);
        if (matches.length === 0) return null;
        return matches.reduce((a, b) => (b.id > a.id ? b : a));
    }

    function currentCommit(app, histories) {
        const hist = historyOf(app);
        if (hist.length === 0) return null;
        const latest = hist.reduce((a, b) => (b.id > a.id ? b : a));
        const meta = (histories[app.metadata.name] || {})[latest.id];
        return meta ? meta.commit : null;
    }

    async function setAutoSync(name, enabled) {
        const fresh = await apiRequest('GET', appPath(name));
        const has = isAutoSync(fresh);
        if (has === enabled) return;
        fresh.spec.syncPolicy = fresh.spec.syncPolicy || {};
        fresh.spec.syncPolicy.automated = enabled ? AUTO_SYNC_POLICY : null;
        await apiRequest('PUT', appPath(name), fresh);
    }

    async function rollbackApp(app, entryId) {
        await setAutoSync(app.metadata.name, false);
        await apiRequest('POST', `${appPath(app.metadata.name)}/rollback`, {id: entryId, prune: false, appNamespace: app.metadata.namespace});
    }

    async function syncApp(app, enableAutoSync) {
        if (enableAutoSync) await setAutoSync(app.metadata.name, true);
        try {
            await apiRequest('POST', `${appPath(app.metadata.name)}/sync`, {prune: false, appNamespace: app.metadata.namespace});
        } catch (e) {
            if (!(enableAutoSync && /operation is already in progress/i.test(e.message))) throw e;
        }
    }

    const labelStyle = {fontSize: '12px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: '#6d7f8b', marginBottom: '4px'};
    const selectStyle = {minWidth: '240px', height: '34px', padding: '0 8px', border: '1px solid #dee6eb', borderRadius: '4px', background: '#fff', fontSize: '14px'};
    const cellStyle = {padding: '8px 12px', borderBottom: '1px solid #eff3f5', fontSize: '13px', verticalAlign: 'middle'};

    const statusColor = {
        Synced: '#18be94', OutOfSync: '#f4c030', Healthy: '#18be94', Progressing: '#0dadea',
        Degraded: '#e96d76', Missing: '#f4c030', Suspended: '#766f94', Unknown: '#ccd6dd',
        ok: '#18be94', error: '#e96d76', running: '#0dadea', skipped: '#6d7f8b'
    };

    const Badge = ({text}) => h('span', {
        style: {display: 'inline-block', padding: '1px 8px', borderRadius: '8px', fontSize: '12px', color: '#fff', background: statusColor[text] || '#8fa4b1'}
    }, text || '-');

    const ConfirmModal = ({title, lines, apps, requireText, onConfirm, onCancel}) => {
        const [typed, setTyped] = React.useState('');
        const ok = !requireText || typed === requireText;
        return h('div', {className: 'popup-overlay'},
            h('div', {className: 'popup-container', style: {maxWidth: '640px'}},
                h('div', {className: 'row popup-container__header popup-container__header__normal'}, h('strong', null, title)),
                h('div', {className: 'row popup-container__body'},
                    h('div', {className: 'columns large-12 popup-container__body__hasNoIcon', style: {fontSize: '14px'}},
                        lines.map((l, i) => h('p', {key: i}, l)),
                        h('div', {style: {maxHeight: '220px', overflowY: 'auto', background: '#f8fbfb', border: '1px solid #eff3f5', borderRadius: '4px', padding: '8px 12px', margin: '8px 0', fontFamily: 'monospace', fontSize: '12px'}},
                            apps.map(a => h('div', {key: a}, a))
                        ),
                        requireText && h('div', null,
                            h('p', null, 'Type ', h('strong', null, requireText), ' to confirm:'),
                            h('input', {className: 'argo-field', value: typed, onChange: e => setTyped(e.target.value), style: {width: '100%'}})
                        )
                    )
                ),
                h('div', {className: 'row popup-container__footer'},
                    h('div', {style: {display: 'flex', gap: '8px'}},
                        h('button', {className: 'argo-button argo-button--base', disabled: !ok, onClick: onConfirm}, 'OK'),
                        h('button', {className: 'argo-button argo-button--base-o', onClick: onCancel}, 'Cancel')
                    )
                )
            )
        );
    };

    const BulkOpsPage = () => {
        const [index, setIndex] = React.useState(null);
        const [indexError, setIndexError] = React.useState(null);
        const [namespace, setNamespace] = React.useState('');
        const [branch, setBranch] = React.useState('');
        const [apps, setApps] = React.useState([]);
        const [histories, setHistories] = React.useState({});
        const [loading, setLoading] = React.useState(false);
        const [resolving, setResolving] = React.useState(false);
        const [results, setResults] = React.useState({});
        const [busy, setBusy] = React.useState(false);
        const [targetCommit, setTargetCommit] = React.useState('');
        const [enableAutoSync, setEnableAutoSync] = React.useState(true);
        const [confirm, setConfirm] = React.useState(null);

        React.useEffect(() => {
            listApps(null, ['items.metadata.name', 'items.metadata.labels', 'items.spec.destination']).then(items => {
                const idx = {};
                items.forEach(a => {
                    const ns = destNs(a);
                    const br = branchOf(a);
                    if (!ns || !br) return;
                    idx[ns] = idx[ns] || {};
                    idx[ns][br] = (idx[ns][br] || 0) + 1;
                });
                setIndex(idx);
            }).catch(e => setIndexError(e.message));
        }, []);

        const loadApps = async (ns, br, withHistory) => {
            if (!ns || !br) return;
            setLoading(true);
            try {
                const items = (await listApps(`branch=${br}`)).filter(a => destNs(a) === ns).sort((a, b) => a.metadata.name.localeCompare(b.metadata.name));
                setApps(items);
                if (withHistory) {
                    setResolving(true);
                    setHistories(await resolveAppHistories(items));
                    setResolving(false);
                }
            } catch (e) {
                setIndexError(e.message);
            } finally {
                setLoading(false);
            }
        };

        React.useEffect(() => {
            setApps([]);
            setHistories({});
            setResults({});
            setTargetCommit('');
            loadApps(namespace, branch, true);
        }, [namespace, branch]);

        const setResult = (name, status, message) => setResults(r => ({...r, [name]: {status, message}}));

        const runBulk = async (items, fn) => {
            setBusy(true);
            items.forEach(({app}) => setResult(app.metadata.name, 'running', ''));
            await runPool(items, async item => {
                try {
                    await fn(item);
                    setResult(item.app.metadata.name, 'ok', '');
                } catch (e) {
                    setResult(item.app.metadata.name, 'error', e.message);
                }
            });
            setBusy(false);
            loadApps(namespace, branch, true);
        };

        const targets = React.useMemo(() => rollbackTargets(apps, histories), [apps, histories]);
        const environments = Array.from(new Set(apps.map(a => (a.metadata.labels || {}).environment).filter(Boolean)));
        const isProd = environments.includes('prod');

        const planRollback = () => {
            const plan = [];
            const skipped = [];
            apps.forEach(app => {
                const entry = findEntryForCommit(app, histories, targetCommit);
                if (!entry) skipped.push({app, reason: 'commit not in history'});
                else if (currentCommit(app, histories) === targetCommit && app.status.sync.status === 'Synced') skipped.push({app, reason: 'already on commit'});
                else plan.push({app, entryId: entry.id});
            });
            return {plan, skipped};
        };

        const onSyncAll = () => setConfirm({
            title: `Sync ${apps.length} application(s)`,
            lines: [
                `Namespace ${namespace}, branch ${branch}. Each app will sync to the latest revision in git (latest CI build for the branch).`,
                enableAutoSync ? 'Auto-sync will be re-enabled on every app.' : 'Auto-sync settings are left unchanged.'
            ],
            apps: apps.map(a => a.metadata.name),
            requireText: isProd ? namespace : null,
            run: () => runBulk(apps.map(app => ({app})), ({app}) => syncApp(app, enableAutoSync))
        });

        const onRollbackAll = () => {
            const {plan, skipped} = planRollback();
            skipped.forEach(({app, reason}) => setResult(app.metadata.name, 'skipped', reason));
            if (plan.length === 0) return;
            setConfirm({
                title: `Rollback ${plan.length} application(s) to ${shortSha(targetCommit)}`,
                lines: [
                    `Namespace ${namespace}, branch ${branch}. Auto-sync will be disabled on each app before rollback.`,
                    'This does not change launchpad. Syncing or re-enabling auto-sync later redeploys the latest build; revert _live_build.yml for a permanent rollback.',
                    skipped.length ? `${skipped.length} app(s) skipped (see table).` : ''
                ].filter(Boolean),
                apps: plan.map(p => p.app.metadata.name),
                requireText: isProd ? namespace : null,
                run: () => runBulk(plan, ({app, entryId}) => rollbackApp(app, entryId))
            });
        };

        const namespaces = index ? Object.keys(index).sort() : [];
        const branches = index && namespace ? Object.keys(index[namespace] || {}).sort() : [];

        return h('div', {style: {padding: '24px', maxWidth: '1400px'}},
            confirm && h(ConfirmModal, {
                title: confirm.title, lines: confirm.lines, apps: confirm.apps, requireText: confirm.requireText,
                onCancel: () => setConfirm(null),
                onConfirm: () => { const run = confirm.run; setConfirm(null); run(); }
            }),
            indexError && h('div', {style: {color: '#e96d76', marginBottom: '12px'}}, indexError),
            h('div', {style: {display: 'flex', gap: '24px', alignItems: 'flex-end', marginBottom: '20px', flexWrap: 'wrap'}},
                h('div', null,
                    h('div', {style: labelStyle}, 'Namespace'),
                    h('select', {style: selectStyle, value: namespace, disabled: !index || busy, onChange: e => { setNamespace(e.target.value); setBranch(''); }},
                        h('option', {value: ''}, index ? 'Select namespace' : 'Loading...'),
                        namespaces.map(ns => h('option', {key: ns, value: ns}, ns))
                    )
                ),
                h('div', null,
                    h('div', {style: labelStyle}, 'Branch'),
                    h('select', {style: selectStyle, value: branch, disabled: !namespace || busy, onChange: e => setBranch(e.target.value)},
                        h('option', {value: ''}, 'Select branch'),
                        branches.map(br => h('option', {key: br, value: br}, `${br} (${index[namespace][br]})`))
                    )
                ),
                h('button', {className: 'argo-button argo-button--base-o', disabled: !branch || loading || busy, onClick: () => loadApps(namespace, branch, true)},
                    h('i', {className: 'fa fa-redo'}), ' Refresh')
            ),

            branch && h('div', {style: {display: 'flex', gap: '32px', marginBottom: '20px', flexWrap: 'wrap', alignItems: 'flex-end'}},
                h('div', {style: {display: 'flex', gap: '12px', alignItems: 'center'}},
                    h('button', {className: 'argo-button argo-button--base', disabled: busy || loading || apps.length === 0, onClick: onSyncAll},
                        h('i', {className: 'fa fa-sync'}), ' Sync all'),
                    h('label', {style: {fontSize: '13px', display: 'flex', alignItems: 'center', gap: '6px'}},
                        h('input', {type: 'checkbox', checked: enableAutoSync, onChange: e => setEnableAutoSync(e.target.checked)}),
                        'Re-enable auto-sync')
                ),
                h('div', {style: {display: 'flex', gap: '12px', alignItems: 'center'}},
                    h('select', {style: {...selectStyle, minWidth: '360px'}, value: targetCommit, disabled: busy || resolving || targets.length === 0, onChange: e => setTargetCommit(e.target.value)},
                        h('option', {value: ''}, resolving ? 'Resolving build commits...' : 'Select build commit to roll back to'),
                        targets.map(t => h('option', {key: t.commit, value: t.commit},
                            `${shortSha(t.commit)}  ${t.slackUsername || ''}  ${t.deployedAt ? new Date(t.deployedAt).toLocaleString() : ''}  (${t.apps.size}/${apps.length} apps)`))
                    ),
                    h('button', {className: 'argo-button argo-button--base', disabled: busy || !targetCommit, onClick: onRollbackAll},
                        h('i', {className: 'fa fa-step-backward'}), ' Rollback all')
                )
            ),

            loading && apps.length === 0
                ? h('div', {style: {color: '#6d7f8b'}}, h('i', {className: 'fa fa-spinner fa-spin'}), ' Loading applications...')
                : apps.length > 0 && h('table', {style: {width: '100%', borderCollapse: 'collapse', background: '#fff', borderRadius: '4px', boxShadow: '1px 2px 3px rgba(0,0,0,0.1)'}},
                    h('thead', null, h('tr', null,
                        ['Application', 'Sync', 'Health', 'Auto-sync', 'Build commit', 'Result'].map(c =>
                            h('th', {key: c, style: {...cellStyle, ...labelStyle, textAlign: 'left'}}, c))
                    )),
                    h('tbody', null, apps.map(app => {
                        const name = app.metadata.name;
                        const res = results[name];
                        const cur = currentCommit(app, histories);
                        return h('tr', {key: name},
                            h('td', {style: cellStyle}, h('a', {href: `/applications/${app.metadata.namespace}/${name}`}, name)),
                            h('td', {style: cellStyle}, h(Badge, {text: app.status.sync && app.status.sync.status})),
                            h('td', {style: cellStyle}, h(Badge, {text: app.status.health && app.status.health.status})),
                            h('td', {style: cellStyle}, isAutoSync(app) ? 'on' : 'off'),
                            h('td', {style: {...cellStyle, fontFamily: 'monospace'}}, resolving ? '...' : shortSha(cur) || '-'),
                            h('td', {style: cellStyle}, res ? h('span', null, h(Badge, {text: res.status}), res.message ? ` ${res.message}` : '') : '')
                        );
                    }))
                )
        );
    };

    window.extensionsAPI.registerSystemLevelExtension(BulkOpsPage, 'Bulk Ops', '/bulk-ops', 'fa-layer-group');
})(window);
