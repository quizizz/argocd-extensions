((window) => {
    const h = React.createElement;
    const CONCURRENCY = 5;
    const FALLBACK_AUTO_SYNC_POLICY = {prune: false};

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
    const fmtTime = t => (t ? new Date(t).toLocaleString() : '');
    const configRepo = entry => {
        const {sources} = entrySources(entry);
        const s = sources.find(x => x && x.repoURL);
        return s ? s.repoURL.replace(/\.git$/, '') : '';
    };
    const configRevision = entry => entrySources(entry).revisions.find(Boolean) || '';
    const initiator = entry => {
        const by = entry.initiatedBy || {};
        return by.username || (by.automated ? 'auto-sync' : '');
    };
    const githubCommitSearch = (repoURL, sha) => {
        const m = /github\.com[/:]([^/]+)\//.exec(repoURL || '');
        return m ? `https://github.com/search?q=${encodeURIComponent(`org:${m[1]} ${sha}`)}&type=commits` : '';
    };

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
                const time = params.find(p => p.name === 'build.commitTime');
                if (commit) result = {commit: commit.value, slackUsername: slack ? slack.value : null, commitTime: time && Number(time.value) ? Number(time.value) * 1000 : null};
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
                const t = byCommit[meta.commit] || {commit: meta.commit, slackUsername: meta.slackUsername, commitTime: meta.commitTime, apps: new Set(), current: new Set()};
                if (!t.deployedAt || (entry.deployedAt || '') > t.deployedAt) {
                    t.deployedAt = entry.deployedAt || t.deployedAt;
                    t.initiatedBy = initiator(entry);
                    t.configRepo = configRepo(entry);
                    t.configRevision = configRevision(entry);
                }
                t.apps.add(app.metadata.name);
                if (currentCommit(app, histories) === meta.commit) t.current.add(app.metadata.name);
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

    const appSetPolicyCache = {};

    async function desiredAutoSyncPolicy(app) {
        const owner = (app.metadata.ownerReferences || []).find(o => o.kind === 'ApplicationSet');
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

    const RESTARTABLE = {'apps/Deployment': true, 'apps/StatefulSet': true, 'apps/DaemonSet': true, 'argoproj.io/Rollout': true};
    const nodeKey = n => `${n.group || ''}/${n.kind}`;

    async function workloadRefs(app, rollouts) {
        const refs = new Set();
        for (const r of rollouts) {
            const params = new URLSearchParams({
                name: app.metadata.name, appNamespace: app.metadata.namespace, namespace: r.namespace || '',
                resourceName: r.name, version: r.version, kind: r.kind, group: r.group
            });
            const data = await apiRequest('GET', `${appPath(app.metadata.name)}/resource?${params}`);
            const manifest = JSON.parse(data.manifest || '{}');
            const ref = manifest.spec && manifest.spec.workloadRef;
            if (ref && ref.name) refs.add(`${(ref.apiVersion || '').split('/')[0]}/${ref.kind}/${r.namespace || ''}/${ref.name}`);
        }
        return refs;
    }

    async function restartTargets(app) {
        const tree = await apiRequest('GET', `${appPath(app.metadata.name)}/resource-tree?appNamespace=${encodeURIComponent(app.metadata.namespace)}`);
        const nodes = (tree.nodes || []).filter(n => RESTARTABLE[nodeKey(n)] && !(n.parentRefs && n.parentRefs.length));
        const refs = await workloadRefs(app, nodes.filter(n => n.kind === 'Rollout'));
        return nodes.filter(n => !refs.has(`${n.group || ''}/${n.kind}/${n.namespace || ''}/${n.name}`));
    }

    async function restartApp(app) {
        const targets = await restartTargets(app);
        if (targets.length === 0) return {status: 'skipped', message: 'no Deployment/Rollout'};
        for (const n of targets) {
            await apiRequest('POST', `${appPath(app.metadata.name)}/resource/actions/v2`, {
                name: app.metadata.name, appNamespace: app.metadata.namespace, namespace: n.namespace || '',
                resourceName: n.name, version: n.version, kind: n.kind, group: n.group || '', action: 'restart', resourceActionParameters: []
            });
        }
        return {status: 'ok', message: targets.map(n => `${n.kind}/${n.name}`).join(', ')};
    }

    const labelStyle = {fontSize: '12px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: '#6d7f8b', marginBottom: '4px'};
    const selectStyle = {width: '240px', maxWidth: '100%', height: '34px', padding: '0 36px 0 12px', border: '1px solid #dee6eb', borderRadius: '4px', background: "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'><path d='M1 1l5 5 5-5' fill='none' stroke='%236d7f8b' stroke-width='1.6'/></svg>\") no-repeat right 12px center / 12px 8px #fff", appearance: 'none', WebkitAppearance: 'none', MozAppearance: 'none', fontSize: '14px', cursor: 'pointer'};
    const cellStyle = {padding: '8px 12px', borderBottom: '1px solid #eff3f5', fontSize: '13px', verticalAlign: 'middle', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'};
    const tableStyle = {width: '100%', minWidth: '820px', tableLayout: 'fixed', borderCollapse: 'collapse', background: '#fff', borderRadius: '4px', boxShadow: '1px 2px 3px rgba(0,0,0,0.1)'};
    const buttonStyle = {whiteSpace: 'nowrap', flexShrink: 0};
    const sectionTitleStyle = {...labelStyle, fontSize: '13px', margin: '28px 0 8px'};
    const linkProps = href => ({href, target: '_blank', rel: 'noopener noreferrer'});

    const Table = ({columns, children}) => h('div', {style: {overflowX: 'auto'}},
        h('table', {style: tableStyle},
            h('colgroup', null, columns.map(c => h('col', {key: c.label, style: {width: c.width}}))),
            h('thead', null, h('tr', null, columns.map(c => h('th', {key: c.label, style: {...cellStyle, ...labelStyle, textAlign: 'left'}}, c.label)))),
            h('tbody', null, children)
        )
    );

    const statusColor = {
        Synced: '#18be94', OutOfSync: '#f4c030', Healthy: '#18be94', Progressing: '#0dadea',
        Degraded: '#e96d76', Missing: '#f4c030', Suspended: '#766f94', Unknown: '#ccd6dd',
        ok: '#18be94', current: '#0dadea', error: '#e96d76', running: '#0dadea', skipped: '#6d7f8b'
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

    const BranchSection = ({namespace, branch, onBusy}) => {
        const [apps, setApps] = React.useState([]);
        const [histories, setHistories] = React.useState({});
        const [loading, setLoading] = React.useState(false);
        const [resolving, setResolving] = React.useState(false);
        const [error, setError] = React.useState(null);
        const [results, setResults] = React.useState({});
        const [busy, setBusy] = React.useState(false);
        const [targetCommit, setTargetCommit] = React.useState('');
        const [enableAutoSync, setEnableAutoSync] = React.useState(true);
        const [confirm, setConfirm] = React.useState(null);
        const loadId = React.useRef(0);

        const loadApps = async () => {
            const id = ++loadId.current;
            setLoading(true);
            setError(null);
            try {
                const items = (await listApps(`branch=${branch}`)).filter(a => destNs(a) === namespace).sort((a, b) => a.metadata.name.localeCompare(b.metadata.name));
                if (id !== loadId.current) return;
                setApps(items);
                setResolving(true);
                const resolved = await resolveAppHistories(items);
                if (id === loadId.current) setHistories(resolved);
            } catch (e) {
                if (id === loadId.current) setError(e.message);
            } finally {
                if (id === loadId.current) {
                    setLoading(false);
                    setResolving(false);
                }
            }
        };

        React.useEffect(() => {
            setApps([]);
            setHistories({});
            setResults({});
            setTargetCommit('');
            loadApps();
        }, [namespace, branch]);

        React.useEffect(() => {
            if (onBusy) onBusy(branch, busy);
        }, [busy]);

        const setResult = (name, status, message) => setResults(r => ({...r, [name]: {status, message}}));

        const runBulk = async (items, fn) => {
            setBusy(true);
            items.forEach(({app}) => setResult(app.metadata.name, 'running', ''));
            await runPool(items, async item => {
                try {
                    const r = (await fn(item)) || {};
                    setResult(item.app.metadata.name, r.status || 'ok', r.message || '');
                } catch (e) {
                    setResult(item.app.metadata.name, 'error', e.message);
                }
            });
            setBusy(false);
            loadApps();
        };

        const targets = React.useMemo(() => rollbackTargets(apps, histories), [apps, histories]);
        const isProd = apps.some(a => (a.metadata.labels || {}).environment === 'prod');
        const scope = `Namespace ${namespace}, branch ${branch}.`;

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
                `${scope} Each app will sync to the latest revision in git (latest CI build for the branch).`,
                enableAutoSync ? 'Auto-sync will be re-enabled on every app.' : 'Auto-sync settings are left unchanged.'
            ],
            apps: apps.map(a => a.metadata.name),
            requireText: isProd ? namespace : null,
            run: () => runBulk(apps.map(app => ({app})), ({app}) => syncApp(app, enableAutoSync))
        });

        const onRestartAll = () => setConfirm({
            title: `Restart ${apps.length} application(s)`,
            lines: [
                `${scope} Runs the ArgoCD "restart" action on every Deployment, StatefulSet, DaemonSet and Argo Rollout in each app.`,
                'Deployments do a rolling restart; Rollouts restart pods via spec.restartAt, respecting maxUnavailable. Deployments referenced by a Rollout workloadRef are left alone. No git or image change.'
            ],
            apps: apps.map(a => a.metadata.name),
            requireText: isProd ? namespace : null,
            run: () => runBulk(apps.map(app => ({app})), ({app}) => restartApp(app))
        });

        const onRollbackAll = () => {
            const {plan, skipped} = planRollback();
            skipped.forEach(({app, reason}) => setResult(app.metadata.name, 'skipped', reason));
            if (plan.length === 0) return;
            setConfirm({
                title: `Rollback ${plan.length} application(s) to ${shortSha(targetCommit)}`,
                lines: [
                    `${scope} Auto-sync will be disabled on each app before rollback.`,
                    'This does not change launchpad. Syncing or re-enabling auto-sync later redeploys the latest build; revert _live_build.yml for a permanent rollback.',
                    skipped.length ? `${skipped.length} app(s) skipped (see table).` : ''
                ].filter(Boolean),
                apps: plan.map(p => p.app.metadata.name),
                requireText: isProd ? namespace : null,
                run: () => runBulk(plan, ({app, entryId}) => rollbackApp(app, entryId))
            });
        };

        return h('div', null,
            confirm && h(ConfirmModal, {
                title: confirm.title, lines: confirm.lines, apps: confirm.apps, requireText: confirm.requireText,
                onCancel: () => setConfirm(null),
                onConfirm: () => { const run = confirm.run; setConfirm(null); run(); }
            }),
            error && h('div', {style: {color: '#e96d76', marginBottom: '12px'}}, error),
            h('div', {style: {display: 'flex', gap: '12px 24px', marginBottom: '16px', flexWrap: 'wrap', alignItems: 'center'}},
                h('div', {style: {display: 'flex', gap: '12px', alignItems: 'center'}},
                    h('button', {className: 'argo-button argo-button--base', style: buttonStyle, disabled: busy || loading || apps.length === 0, onClick: onSyncAll},
                        h('i', {className: 'fa fa-sync'}), ' Sync all'),
                    h('label', {style: {fontSize: '13px', display: 'flex', alignItems: 'center', gap: '6px', whiteSpace: 'nowrap', margin: 0}},
                        h('input', {type: 'checkbox', checked: enableAutoSync, onChange: e => setEnableAutoSync(e.target.checked), style: {margin: 0}}),
                        'Re-enable auto-sync')
                ),
                h('button', {className: 'argo-button argo-button--base', style: buttonStyle, disabled: busy || loading || apps.length === 0, onClick: onRestartAll},
                    h('i', {className: 'fa fa-redo-alt'}), ' Restart all'),
                h('button', {className: 'argo-button argo-button--base', style: buttonStyle, disabled: busy || !targetCommit, onClick: onRollbackAll, title: targetCommit ? '' : 'Select a build in Rollback history below'},
                    h('i', {className: 'fa fa-step-backward'}), targetCommit ? ` Rollback all to ${shortSha(targetCommit)}` : ' Rollback all'),
                h('button', {className: 'argo-button argo-button--base-o', style: {...buttonStyle, marginLeft: 'auto'}, disabled: loading || busy, onClick: loadApps},
                    h('i', {className: loading ? 'fa fa-spinner fa-spin' : 'fa fa-redo'}), ' Refresh')
            ),

            loading && apps.length === 0
                ? h('div', {style: {color: '#6d7f8b'}}, h('i', {className: 'fa fa-spinner fa-spin'}), ' Loading applications...')
                : !error && apps.length === 0
                    ? h('div', {style: {color: '#6d7f8b', fontSize: '13px'}}, 'No applications.')
                    : apps.length > 0 && h(Table, {columns: [
                        {label: 'Application', width: '30%'}, {label: 'Sync', width: '110px'}, {label: 'Health', width: '120px'},
                        {label: 'Auto-sync', width: '90px'}, {label: 'Build commit', width: '120px'}, {label: 'Result', width: '30%'}
                    ]}, apps.map(app => {
                        const name = app.metadata.name;
                        const res = results[name];
                        const cur = currentCommit(app, histories);
                        return h('tr', {key: name},
                            h('td', {style: cellStyle, title: name}, h('a', {href: `/applications/${app.metadata.namespace}/${name}`}, name)),
                            h('td', {style: cellStyle}, h(Badge, {text: app.status.sync && app.status.sync.status})),
                            h('td', {style: cellStyle}, h(Badge, {text: app.status.health && app.status.health.status})),
                            h('td', {style: cellStyle}, isAutoSync(app) ? 'on' : 'off'),
                            h('td', {style: {...cellStyle, fontFamily: 'monospace'}, title: cur || ''}, resolving ? '...' : shortSha(cur) || '-'),
                            h('td', {style: cellStyle, title: res && res.message ? res.message : ''}, res ? h('span', null, h(Badge, {text: res.status}), res.message ? ` ${res.message}` : '') : '')
                        );
                    })),

            apps.length > 0 && h('div', null,
                h('div', {style: sectionTitleStyle}, 'Rollback history', resolving && h('span', {style: {textTransform: 'none', fontWeight: 400, marginLeft: '8px'}}, h('i', {className: 'fa fa-spinner fa-spin'}), ' resolving build commits...')),
                !resolving && targets.length === 0
                    ? h('div', {style: {color: '#6d7f8b', fontSize: '13px'}}, 'No build commits found in app history.')
                    : h(Table, {columns: [
                        {label: '', width: '36px'}, {label: 'Build commit', width: '130px'}, {label: 'Built by', width: '120px'},
                        {label: 'Committed', width: '170px'}, {label: 'Last deployed', width: '170px'}, {label: 'Deployed by', width: '140px'},
                        {label: 'Launchpad commit', width: '140px'}, {label: 'Apps', width: '120px'}
                    ]}, targets.map(t => {
                        const selected = targetCommit === t.commit;
                        const isCurrent = t.current.size === apps.length;
                        const search = githubCommitSearch(t.configRepo, t.commit);
                        const pick = () => !busy && setTargetCommit(selected ? '' : t.commit);
                        return h('tr', {key: t.commit, onClick: pick, style: {cursor: busy ? 'default' : 'pointer', background: selected ? '#e6f7fc' : undefined}},
                            h('td', {style: cellStyle}, h('input', {type: 'radio', checked: selected, disabled: busy, onChange: pick, onClick: e => e.stopPropagation(), style: {margin: 0}})),
                            h('td', {style: {...cellStyle, fontFamily: 'monospace'}, title: t.commit},
                                search ? h('a', {...linkProps(search), onClick: e => e.stopPropagation()}, shortSha(t.commit)) : shortSha(t.commit),
                                isCurrent && h('span', {style: {marginLeft: '6px', fontFamily: 'inherit'}}, h(Badge, {text: 'current'}))),
                            h('td', {style: cellStyle}, t.slackUsername || '-'),
                            h('td', {style: cellStyle}, fmtTime(t.commitTime) || '-'),
                            h('td', {style: cellStyle}, fmtTime(t.deployedAt) || '-'),
                            h('td', {style: cellStyle}, t.initiatedBy || '-'),
                            h('td', {style: {...cellStyle, fontFamily: 'monospace'}, title: t.configRevision || ''},
                                t.configRevision && t.configRepo
                                    ? h('a', {...linkProps(`${t.configRepo}/commit/${t.configRevision}`), onClick: e => e.stopPropagation()}, shortSha(t.configRevision))
                                    : shortSha(t.configRevision) || '-'),
                            h('td', {style: cellStyle, title: Array.from(t.apps).join('\n')}, `${t.apps.size}/${apps.length}${t.current.size && !isCurrent ? ` (${t.current.size} current)` : ''}`)
                        );
                    }))
            )
        );
    };

    const BulkSyncPage = () => {
        const [index, setIndex] = React.useState(null);
        const [indexError, setIndexError] = React.useState(null);
        const [namespace, setNamespace] = React.useState('');
        const [branch, setBranch] = React.useState('');
        const [open, setOpen] = React.useState({});
        const [busyBranches, setBusyBranches] = React.useState({});

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

        const namespaces = index ? Object.keys(index).sort() : [];
        const branches = index && namespace ? Object.keys(index[namespace] || {}).sort() : [];
        const busy = Object.values(busyBranches).some(Boolean);
        const onBusy = React.useCallback((br, value) => setBusyBranches(m => ({...m, [br]: value})), []);

        React.useEffect(() => {
            setBusyBranches({});
            setOpen(branches.length === 1 ? {[branches[0]]: true} : {});
        }, [namespace, index]);

        const toggle = br => setOpen(o => ({...o, [br]: !o[br]}));

        return h('div', {style: {padding: '24px 16px', maxWidth: '1400px', boxSizing: 'border-box'}},
            indexError && h('div', {style: {color: '#e96d76', marginBottom: '12px'}}, indexError),
            h('div', {style: {display: 'flex', gap: '16px 24px', alignItems: 'flex-end', marginBottom: '20px', flexWrap: 'wrap'}},
                h('div', {style: {maxWidth: '100%'}},
                    h('div', {style: labelStyle}, 'Namespace'),
                    h('select', {style: selectStyle, value: namespace, disabled: !index || busy, onChange: e => { setNamespace(e.target.value); setBranch(''); }},
                        h('option', {value: ''}, index ? 'Select namespace' : 'Loading...'),
                        namespaces.map(ns => h('option', {key: ns, value: ns}, ns))
                    )
                ),
                h('div', {style: {maxWidth: '100%'}},
                    h('div', {style: labelStyle}, 'Branch'),
                    h('select', {style: selectStyle, value: branch, disabled: !namespace || busy, onChange: e => setBranch(e.target.value)},
                        h('option', {value: ''}, namespace ? `All branches (${branches.length})` : 'All branches'),
                        branches.map(br => h('option', {key: br, value: br}, `${br} (${index[namespace][br]})`))
                    )
                )
            ),

            index && !namespace && h('div', {style: {color: '#6d7f8b', fontSize: '13px'}}, 'Select a namespace to see its branches.'),

            namespace && branch && h(BranchSection, {key: `${namespace}/${branch}`, namespace, branch, onBusy}),

            namespace && !branch && branches.map(br => {
                const isOpen = !!open[br];
                const mounted = br in open;
                return h('div', {key: `${namespace}/${br}`, style: {background: '#fff', borderRadius: '4px', boxShadow: '1px 2px 3px rgba(0,0,0,0.1)', marginBottom: '12px'}},
                    h('div', {onClick: () => toggle(br), style: {display: 'flex', alignItems: 'center', gap: '10px', padding: '12px 16px', cursor: 'pointer', userSelect: 'none'}},
                        h('i', {className: `fa fa-fw fa-chevron-${isOpen ? 'down' : 'right'}`, style: {color: '#6d7f8b'}}),
                        h('strong', null, br),
                        h('span', {style: {color: '#6d7f8b', fontSize: '13px'}}, `${index[namespace][br]} app${index[namespace][br] === 1 ? '' : 's'}`),
                        busyBranches[br] && h('i', {className: 'fa fa-spinner fa-spin', style: {color: '#0dadea'}})
                    ),
                    mounted && h('div', {style: {display: isOpen ? 'block' : 'none', padding: '16px', borderTop: '1px solid #eff3f5', background: '#f8fbfb'}},
                        h(BranchSection, {namespace, branch: br, onBusy}))
                );
            })
        );
    };

    const describeSidebarItem = (title, description) => {
        const attach = el => {
            if (el.dataset.extDescription || el.textContent !== title) return;
            el.dataset.extDescription = '1';
            const d = document.createElement('div');
            d.textContent = description;
            d.style.cssText = 'font-size:12px;font-weight:400;opacity:0.8;margin-top:4px;max-width:240px;white-space:normal;line-height:1.4';
            el.appendChild(d);
        };
        new MutationObserver(mutations => mutations.forEach(m => m.addedNodes.forEach(n => {
            if (n.nodeType !== 1) return;
            if (n.classList.contains('sidebar__tooltip')) attach(n);
            else if (n.matches('[data-tippy-root], .tippy-popper')) n.querySelectorAll('.sidebar__tooltip').forEach(attach);
        }))).observe(document.body, {childList: true, subtree: true});
    };

    const registerPage = () => window.extensionsAPI.registerSystemLevelExtension(BulkSyncPage, 'Bulk Sync', '/bulk-sync', 'fa-layer-group fa-fw');
    describeSidebarItem('Bulk Sync', 'Sync, restart or roll back every app of a namespace together, branch by branch.');
    const appRoot = document.getElementById('app');
    if (!appRoot || appRoot.childElementCount) {
        registerPage();
    } else {
        new MutationObserver((_, observer) => {
            if (!appRoot.childElementCount) return;
            observer.disconnect();
            registerPage();
        }).observe(appRoot, {childList: true});
    }
})(window);
