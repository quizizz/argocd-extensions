((window) => {
    const h = React.createElement;
    const CONCURRENCY = 5;
    const FALLBACK_AUTO_SYNC_POLICY = {prune: false};
    const ALL = '*';

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
    const ownerAppSet = app => (app.metadata.ownerReferences || []).find(o => o.kind === 'ApplicationSet');
    const isProd = app => (app.metadata.labels && app.metadata.labels.environment) === 'prod';

    async function listApps(selector, fields) {
        const params = new URLSearchParams();
        if (selector) params.set('selector', selector);
        if (fields) params.set('fields', fields.join(','));
        const qs = params.toString();
        const data = await apiRequest('GET', `/api/v1/applications${qs ? `?${qs}` : ''}`);
        return data.items || [];
    }

    async function listAppSetPolicies() {
        const data = await apiRequest('GET', '/api/v1/applicationsets');
        const out = {};
        (data.items || []).forEach(set => {
            const policy = set.spec && set.spec.template && set.spec.template.spec && set.spec.template.spec.syncPolicy;
            out[`${set.metadata.namespace}/${set.metadata.name}`] = (policy && policy.automated) || null;
        });
        return out;
    }

    const buildCommitCache = {};

    function entrySources(entry) {
        const multi = entry.sources && entry.sources.length > 0;
        return {
            sources: multi ? entry.sources : [entry.source],
            revisions: multi ? entry.revisions || [] : [entry.revision]
        };
    }

    async function appDetailsBuild(app, sources, revisions, versionId) {
        for (let i = 0; i < sources.length; i++) {
            const source = sources[i];
            if (!source || !source.repoURL) continue;
            try {
                const body = {
                    source: {...source, targetRevision: revisions[i]},
                    appName: app.metadata.name,
                    appProject: app.spec.project,
                    sourceIndex: i
                };
                if (versionId !== undefined) body.versionId = versionId;
                const data = await apiRequest('POST', `/api/v1/repositories/${encodeURIComponent(source.repoURL)}/appdetails`, body);
                const params = (data.helm && data.helm.parameters) || [];
                const commit = params.find(p => p.name === 'build.commit');
                const slack = params.find(p => p.name === 'build.slackUsername');
                if (commit) return {commit: commit.value, slackUsername: slack ? slack.value : null};
            } catch (_) {}
        }
        return null;
    }

    async function resolveBuildCommit(app, entry) {
        const {sources, revisions} = entrySources(entry);
        const key = `${app.metadata.name}|${revisions.join(',')}`;
        if (buildCommitCache[key] === undefined) buildCommitCache[key] = await appDetailsBuild(app, sources, revisions, entry.id);
        return buildCommitCache[key];
    }

    async function resolveLatestBuild(app) {
        const multi = app.spec.sources && app.spec.sources.length > 0;
        const sources = multi ? app.spec.sources : [app.spec.source];
        const revisions = sources.map(s => (s && s.targetRevision) || 'HEAD');
        return appDetailsBuild(app, sources, revisions);
    }

    function latestEntry(app) {
        const hist = historyOf(app);
        return hist.length ? hist.reduce((a, b) => (b.id > a.id ? b : a)) : null;
    }

    async function resolveRunning(app) {
        const entry = latestEntry(app);
        return entry ? resolveBuildCommit(app, entry) : null;
    }

    const appSetPolicyCache = {};

    async function desiredAutoSyncPolicy(app) {
        const owner = ownerAppSet(app);
        if (!owner) return FALLBACK_AUTO_SYNC_POLICY;
        if (!appSetPolicyCache[owner.name]) {
            appSetPolicyCache[owner.name] = apiRequest('GET', `/api/v1/applicationsets/${encodeURIComponent(owner.name)}?appsetNamespace=${encodeURIComponent(app.metadata.namespace)}`)
                .then(set => {
                    const policy = set.spec && set.spec.template && set.spec.template.spec && set.spec.template.spec.syncPolicy;
                    return (policy && policy.automated) || FALLBACK_AUTO_SYNC_POLICY;
                })
                .catch(() => FALLBACK_AUTO_SYNC_POLICY);
        }
        return appSetPolicyCache[owner.name];
    }

    async function setAutoSync(name, enabled) {
        const fresh = await apiRequest('GET', appPath(name));
        const has = isAutoSync(fresh);
        if (has === enabled) return;
        fresh.spec.syncPolicy = fresh.spec.syncPolicy || {};
        fresh.spec.syncPolicy.automated = enabled ? await desiredAutoSyncPolicy(fresh) : null;
        await apiRequest('PUT', appPath(name), fresh);
    }

    async function resumeApp(app) {
        await setAutoSync(app.metadata.name, true);
        try {
            await apiRequest('POST', `${appPath(app.metadata.name)}/sync`, {prune: false, appNamespace: app.metadata.namespace});
        } catch (e) {
            if (!/operation is already in progress/i.test(e.message)) throw e;
        }
    }

    function pinnedSince(app) {
        const op = app.status && app.status.operationState;
        if (!op) return null;
        return {
            at: op.finishedAt || op.startedAt || null,
            by: (op.operation && op.operation.initiatedBy && (op.operation.initiatedBy.username || (op.operation.initiatedBy.automated ? 'auto' : ''))) || ''
        };
    }

    function ago(ts) {
        if (!ts) return '-';
        const s = Math.max(0, Math.floor((Date.now() - new Date(ts).getTime()) / 1000));
        if (s < 3600) return `${Math.floor(s / 60)}m`;
        if (s < 86400) return `${Math.floor(s / 3600)}h`;
        return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
    }

    const labelStyle = {fontSize: '12px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: '#6d7f8b', marginBottom: '4px'};
    const selectStyle = {minWidth: '240px', height: '34px', padding: '0 8px', border: '1px solid #dee6eb', borderRadius: '4px', background: '#fff', fontSize: '14px'};
    const cellStyle = {padding: '8px 12px', borderBottom: '1px solid #eff3f5', fontSize: '13px', verticalAlign: 'middle'};
    const tableStyle = {width: '100%', borderCollapse: 'collapse', background: '#fff', borderRadius: '4px', boxShadow: '1px 2px 3px rgba(0,0,0,0.1)', marginBottom: '24px'};

    const statusColor = {
        Synced: '#18be94', OutOfSync: '#f4c030', Healthy: '#18be94', Progressing: '#0dadea',
        Degraded: '#e96d76', Missing: '#f4c030', Suspended: '#766f94', Unknown: '#ccd6dd',
        ok: '#18be94', error: '#e96d76', running: '#0dadea', skipped: '#6d7f8b', behind: '#f4c030', current: '#18be94'
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

    const APP_FIELDS = [
        'items.metadata.name', 'items.metadata.namespace', 'items.metadata.labels', 'items.metadata.ownerReferences',
        'items.spec', 'items.status.history', 'items.status.operationState', 'items.status.sync', 'items.status.health'
    ];

    const PinnedPage = () => {
        const [apps, setApps] = React.useState(null);
        const [notice, setNotice] = React.useState(null);
        const [error, setError] = React.useState(null);
        const [builds, setBuilds] = React.useState({});
        const [namespace, setNamespace] = React.useState(ALL);
        const [selected, setSelected] = React.useState({});
        const [results, setResults] = React.useState({});
        const [busy, setBusy] = React.useState(false);
        const [confirm, setConfirm] = React.useState(null);
        const loadId = React.useRef(0);

        const load = async () => {
            const id = ++loadId.current;
            setApps(null);
            setBuilds({});
            setSelected({});
            setResults({});
            setError(null);
            setNotice(null);
            try {
                const [items, policies] = await Promise.all([
                    listApps(null, APP_FIELDS),
                    listAppSetPolicies().catch(e => {
                        setNotice(`Could not list ApplicationSets (${e.message}); showing every appset-owned app with auto-sync off.`);
                        return null;
                    })
                ]);
                if (id !== loadId.current) return;
                const pinned = items.filter(app => {
                    const owner = ownerAppSet(app);
                    if (!owner || isAutoSync(app)) return false;
                    if (!policies) return true;
                    return !!policies[`${app.metadata.namespace}/${owner.name}`];
                }).sort((a, b) => destNs(a).localeCompare(destNs(b)) || branchOf(a).localeCompare(branchOf(b)) || a.metadata.name.localeCompare(b.metadata.name));
                setApps(pinned);
                await runPool(pinned, async app => {
                    const [running, latest] = await Promise.all([resolveRunning(app), resolveLatestBuild(app)]);
                    if (id === loadId.current) setBuilds(b => ({...b, [app.metadata.name]: {running, latest}}));
                });
            } catch (e) {
                if (id === loadId.current) setError(e.message);
            }
        };

        React.useEffect(() => { load(); }, []);

        const visible = (apps || []).filter(a => namespace === ALL || destNs(a) === namespace);
        const namespaces = Array.from(new Set((apps || []).map(destNs))).sort();
        const groups = [];
        visible.forEach(app => {
            const key = `${destNs(app)} / ${branchOf(app) || '-'}`;
            const last = groups[groups.length - 1];
            if (last && last.key === key) last.apps.push(app);
            else groups.push({key, apps: [app]});
        });
        const selectedApps = visible.filter(a => selected[a.metadata.name]);
        const setResult = (name, status, message) => setResults(r => ({...r, [name]: {status, message}}));

        const runResume = async targets => {
            setConfirm(null);
            setBusy(true);
            targets.forEach(a => setResult(a.metadata.name, 'running'));
            await runPool(targets, async app => {
                try {
                    await resumeApp(app);
                    setResult(app.metadata.name, 'ok', 'auto-sync on, syncing');
                } catch (e) {
                    setResult(app.metadata.name, 'error', e.message);
                }
            });
            setBusy(false);
        };

        const askResume = targets => setConfirm({
            title: `Resume auto-sync for ${targets.length} app${targets.length === 1 ? '' : 's'}`,
            lines: [
                'Auto-sync will be re-enabled with each ApplicationSet\'s policy and a sync triggered.',
                'This deploys the latest launchpad build and undoes any rollback.'
            ],
            apps: targets.map(a => {
                const b = builds[a.metadata.name] || {};
                return `${a.metadata.name}  ${shortSha(b.running && b.running.commit) || '?'} → ${shortSha(b.latest && b.latest.commit) || '?'}`;
            }),
            requireText: targets.some(isProd) ? 'resume' : null,
            onConfirm: () => runResume(targets)
        });

        const toggleGroup = (group, value) => setSelected(s => {
            const next = {...s};
            group.apps.forEach(a => { next[a.metadata.name] = value; });
            return next;
        });

        return h('div', {style: {padding: '24px', maxWidth: '1600px'}},
            confirm && h(ConfirmModal, {...confirm, onCancel: () => setConfirm(null)}),
            error && h('div', {style: {color: '#e96d76', marginBottom: '12px'}}, error),
            notice && h('div', {style: {color: '#6d7f8b', marginBottom: '12px', fontSize: '13px'}}, notice),
            h('div', {style: {display: 'flex', gap: '16px', alignItems: 'flex-end', marginBottom: '20px', flexWrap: 'wrap'}},
                h('div', null,
                    h('div', {style: labelStyle}, 'Namespace'),
                    h('select', {style: selectStyle, value: namespace, onChange: e => setNamespace(e.target.value)},
                        h('option', {value: ALL}, `All (${(apps || []).length})`),
                        namespaces.map(ns => h('option', {key: ns, value: ns}, `${ns} (${(apps || []).filter(a => destNs(a) === ns).length})`))
                    )
                ),
                h('button', {className: 'argo-button argo-button--base-o', disabled: busy, onClick: load},
                    h('i', {className: apps === null && !error ? 'fa fa-spinner fa-spin' : 'fa fa-redo'}), ' Refresh'),
                h('button', {className: 'argo-button argo-button--base', disabled: busy || selectedApps.length === 0, onClick: () => askResume(selectedApps)},
                    h('i', {className: 'fa fa-play'}), ` Resume selected (${selectedApps.length})`)
            ),
            apps === null && !error && h('div', {style: {color: '#6d7f8b'}}, h('i', {className: 'fa fa-spinner fa-spin'}), ' Loading applications...'),
            apps && visible.length === 0 && h('div', {style: {color: '#6d7f8b'}}, 'No pinned apps.'),
            groups.map(group => {
                const allOn = group.apps.every(a => selected[a.metadata.name]);
                return h('div', {key: group.key},
                    h('div', {style: {display: 'flex', alignItems: 'center', gap: '12px', margin: '8px 0'}},
                        h('strong', null, group.key),
                        h('span', {style: {color: '#6d7f8b', fontSize: '13px'}}, `${group.apps.length} pinned`),
                        h('button', {className: 'argo-button argo-button--base-o', style: {marginLeft: 'auto'}, disabled: busy, onClick: () => askResume(group.apps)}, 'Resume group')
                    ),
                    h('table', {style: tableStyle},
                        h('thead', null, h('tr', null,
                            h('th', {style: {...cellStyle, width: '32px'}}, h('input', {type: 'checkbox', checked: allOn, onChange: e => toggleGroup(group, e.target.checked)})),
                            ['Application', 'Running', 'Latest build', 'Drift', 'Pinned for', 'Last op by', 'Sync', 'Health', 'Result', ''].map(c =>
                                h('th', {key: c, style: {...cellStyle, ...labelStyle, textAlign: 'left'}}, c))
                        )),
                        h('tbody', null, group.apps.map(app => {
                            const name = app.metadata.name;
                            const b = builds[name];
                            const running = b && b.running && b.running.commit;
                            const latest = b && b.latest && b.latest.commit;
                            const since = pinnedSince(app);
                            const drift = !b ? '...' : running && latest ? (running === latest ? 'current' : 'behind') : '?';
                            const res = results[name];
                            return h('tr', {key: name},
                                h('td', {style: cellStyle}, h('input', {type: 'checkbox', checked: !!selected[name], onChange: e => setSelected(s => ({...s, [name]: e.target.checked}))})),
                                h('td', {style: cellStyle}, h('a', {href: `/applications/${app.metadata.namespace}/${name}`}, name)),
                                h('td', {style: {...cellStyle, fontFamily: 'monospace'}, title: running || ''}, b ? shortSha(running) || '-' : '...'),
                                h('td', {style: {...cellStyle, fontFamily: 'monospace'}, title: latest ? `${latest}${b.latest.slackUsername ? ` by ${b.latest.slackUsername}` : ''}` : ''}, b ? shortSha(latest) || '-' : '...'),
                                h('td', {style: cellStyle}, drift === '...' || drift === '?' ? drift : h(Badge, {text: drift})),
                                h('td', {style: cellStyle, title: since && since.at ? `since last operation finished at ${since.at}` : ''}, ago(since && since.at)),
                                h('td', {style: cellStyle}, (since && since.by) || '-'),
                                h('td', {style: cellStyle}, h(Badge, {text: app.status && app.status.sync && app.status.sync.status})),
                                h('td', {style: cellStyle}, h(Badge, {text: app.status && app.status.health && app.status.health.status})),
                                h('td', {style: cellStyle, title: (res && res.message) || ''}, res ? h(Badge, {text: res.status}) : ''),
                                h('td', {style: cellStyle}, h('button', {className: 'argo-button argo-button--base-o', disabled: busy, onClick: () => askResume([app])}, 'Resume'))
                            );
                        }))
                    )
                );
            })
        );
    };

    window.extensionsAPI.registerSystemLevelExtension(PinnedPage, 'Pinned Apps', '/pinned-apps', 'fa-thumbtack');
})(window);
