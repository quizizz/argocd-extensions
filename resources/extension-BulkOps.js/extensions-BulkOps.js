((window) => {
    const h = React.createElement;
    const CONCURRENCY = 5;
    const NO_BRANCH = '__none__';
    const OP_POLL_MS = 3000;
    const OP_TIMEOUT_MS = 10 * 60 * 1000;
    const SECTION_FIELDS = [
        'items.metadata.name', 'items.metadata.namespace', 'items.metadata.labels', 'items.metadata.ownerReferences',
        'items.spec', 'items.status.sync.status', 'items.status.health.status', 'items.status.history', 'items.status.operationState'
    ];
    const OPERATION_FIELDS = ['items.metadata.name', 'items.metadata.namespace', 'items.metadata.labels', 'items.status.operationState'];
    const INDEX_FIELDS = ['items.metadata.name', 'items.metadata.labels', 'items.spec.destination'];
    const SYNC_POLICY_POINTERS = new Set(['/spec', '/spec/syncPolicy', '/spec/syncPolicy/automated']);
    const SYNC_POLICY_JQ = new Set(['.spec', '.spec.syncPolicy', '.spec.syncPolicy.automated']);
    const APPSET_NO_UPDATE = new Set(['create-only', 'create-delete']);
    const IN_CLUSTER = new Set(['', 'in-cluster', 'https://kubernetes.default.svc']);
    const RESTARTABLE = new Set(['apps/Deployment', 'apps/StatefulSet', 'apps/DaemonSet', 'argoproj.io/Rollout']);
    const REVERTED_BY_APPSET = 'auto-sync re-enabled by ApplicationSet; rollback will be reverted';

    async function apiRequest(method, path, body) {
        const resp = await fetch(path, {
            method,
            headers: {'Content-Type': 'application/json'},
            body: body ? JSON.stringify(body) : undefined
        });
        if (!resp.ok) {
            const data = await resp.json().catch(() => ({}));
            const err = new Error(data.message || `Request failed: ${resp.status} ${resp.statusText}`);
            err.status = resp.status;
            err.serverMessage = data.message || '';
            throw err;
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
    const nsQuery = app => `appNamespace=${encodeURIComponent(app.metadata.namespace)}`;
    const appKey = app => `${app.metadata.namespace}/${app.metadata.name}`;
    const branchLabel = branch => (branch === NO_BRANCH ? '(no branch)' : branch);
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const destNs = app => (app.spec && app.spec.destination && app.spec.destination.namespace) || '';
    const destCluster = app => {
        const d = (app.spec && app.spec.destination) || {};
        return d.name || d.server || '';
    };
    const nsKey = app => `${destCluster(app)}|${destNs(app)}`;
    const nsOfKey = key => key.slice(key.lastIndexOf('|') + 1);
    const nsKeyLabel = key => {
        const cluster = key.slice(0, key.lastIndexOf('|'));
        return IN_CLUSTER.has(cluster) ? nsOfKey(key) : `${nsOfKey(key)} (${cluster})`;
    };
    const branchOf = app => (app.metadata.labels && app.metadata.labels.branch) || NO_BRANCH;
    const isAutoSync = app => !!(app.spec.syncPolicy && app.spec.syncPolicy.automated);
    const autoSyncPolicy = app => (isAutoSync(app) ? app.spec.syncPolicy.automated : null);
    const historyOf = app => (app.status && app.status.history) || [];
    const latestEntry = app => historyOf(app).reduce((a, b) => (!a || b.id > a.id ? b : a), null);
    const operationStart = app => (app.status && app.status.operationState && app.status.operationState.startedAt) || '';
    const shortSha = sha => (sha ? sha.slice(0, 10) : '');
    const fmtTime = t => (t ? new Date(t).toLocaleString() : '');
    const configRepo = entry => {
        const s = entrySources(entry).sources.find(x => x && x.repoURL);
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

    const listBranchApps = async (branch, fields) =>
        (await listApps(branch === NO_BRANCH ? null : `branch=${branch}`, fields)).filter(a => branchOf(a) === branch);

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
        const key = `${appKey(app)}|${revisions.join(',')}`;
        if (buildCommitCache[key] !== undefined) return buildCommitCache[key];
        let result = null;
        let failure = null;
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
                const param = name => params.find(p => p.name === name);
                const commit = param('build.commit');
                const slack = param('build.slackUsername');
                const time = param('build.commitTime');
                if (commit) result = {commit: commit.value, slackUsername: slack ? slack.value : null, commitTime: time && Number(time.value) ? Number(time.value) * 1000 : null};
            } catch (e) {
                failure = e;
            }
        }
        if (!result && failure) throw failure;
        buildCommitCache[key] = result;
        return result;
    }

    async function resolveAppHistories(apps) {
        const out = {};
        const tasks = [];
        apps.forEach(app => {
            out[appKey(app)] = {byId: {}, failed: false};
            historyOf(app).forEach(entry => tasks.push({app, entry}));
        });
        await runPool(tasks, async ({app, entry}) => {
            const record = out[appKey(app)];
            try {
                record.byId[entry.id] = await resolveBuildCommit(app, entry);
            } catch (_) {
                record.failed = true;
            }
        });
        return out;
    }

    const historyRecord = (histories, app) => histories[appKey(app)] || {byId: {}, failed: false};
    const buildMeta = (histories, app, entry) => (entry ? historyRecord(histories, app).byId[entry.id] : null);

    function currentCommit(app, histories) {
        const meta = buildMeta(histories, app, latestEntry(app));
        return meta ? meta.commit : null;
    }

    function findEntryForCommit(app, histories, commit) {
        return historyOf(app)
            .filter(e => (buildMeta(histories, app, e) || {}).commit === commit)
            .reduce((a, b) => (!a || b.id > a.id ? b : a), null);
    }

    function rollbackTargets(apps, histories) {
        const byCommit = {};
        apps.forEach(app => {
            const current = currentCommit(app, histories);
            historyOf(app).forEach(entry => {
                const meta = buildMeta(histories, app, entry);
                if (!meta) return;
                const t = byCommit[meta.commit] || {commit: meta.commit, slackUsername: meta.slackUsername, commitTime: meta.commitTime, apps: new Set(), current: new Set()};
                if (!t.deployedAt || (entry.deployedAt || '') > t.deployedAt) {
                    t.deployedAt = entry.deployedAt || t.deployedAt;
                    t.initiatedBy = initiator(entry);
                    t.configRepo = configRepo(entry);
                    t.configRevision = configRevision(entry);
                }
                t.apps.add(appKey(app));
                if (current === meta.commit) t.current.add(appKey(app));
                byCommit[meta.commit] = t;
            });
        });
        return Object.values(byCommit).sort((a, b) => (b.deployedAt || '').localeCompare(a.deployedAt || ''));
    }

    function planRollback(apps, histories, targetCommit) {
        const plan = [];
        const skipped = [];
        apps.forEach(app => {
            const entry = findEntryForCommit(app, histories, targetCommit);
            if (historyRecord(histories, app).failed) skipped.push({app, reason: 'could not resolve all build commits, retry'});
            else if (!entry) skipped.push({app, reason: 'commit not in history'});
            else if (currentCommit(app, histories) === targetCommit) skipped.push({app, reason: 'already on commit'});
            else plan.push({app, entryId: entry.id});
        });
        return {plan, skipped};
    }

    const appSetOwner = app => (app.metadata.ownerReferences || []).find(o => o.kind === 'ApplicationSet');

    const ignoresSyncPolicy = (set, appName) => ((set.spec && set.spec.ignoreApplicationDifferences) || []).some(rule =>
        (!rule.name || rule.name === appName) && (
            (rule.jsonPointers || []).some(p => SYNC_POLICY_POINTERS.has(p)) ||
            (rule.jqPathExpressions || []).some(p => SYNC_POLICY_JQ.has(p.trim()))
        ));

    function appSetPolicyLookup() {
        const sets = {};
        return async app => {
            const owner = appSetOwner(app);
            if (!owner) return {automated: null, reenablesAutoSync: false};
            const key = `${app.metadata.namespace}/${owner.name}`;
            sets[key] = sets[key] || apiRequest('GET', `/api/v1/applicationsets/${encodeURIComponent(owner.name)}?appsetNamespace=${encodeURIComponent(app.metadata.namespace)}`)
                .catch(e => {
                    delete sets[key];
                    throw new Error(`ApplicationSet ${owner.name}: ${e.message}`);
                });
            const set = await sets[key];
            const spec = set.spec || {};
            const template = (spec.template && spec.template.spec && spec.template.spec.syncPolicy) || {};
            const automated = template.automated || null;
            const frozen = APPSET_NO_UPDATE.has((spec.syncPolicy || {}).applicationsSync) || ignoresSyncPolicy(set, app.metadata.name);
            return {automated, reenablesAutoSync: !!automated && !frozen};
        };
    }

    const getApp = app => apiRequest('GET', `${appPath(app.metadata.name)}?${nsQuery(app)}`);

    const patchAutoSync = (app, automated) => apiRequest('PATCH', appPath(app.metadata.name), {
        name: app.metadata.name,
        appNamespace: app.metadata.namespace,
        patch: JSON.stringify({spec: {syncPolicy: {automated}}}),
        patchType: 'merge'
    });

    async function disableAutoSync(app) {
        const previous = autoSyncPolicy(await getApp(app));
        if (previous) await patchAutoSync(app, null);
        return previous;
    }

    async function restoreAutoSync(app, appSetPolicy) {
        const fresh = await getApp(app);
        if (isAutoSync(fresh)) return false;
        const {automated} = await appSetPolicy(fresh);
        if (!automated) return false;
        await patchAutoSync(fresh, automated);
        return true;
    }

    async function rollbackApp(app, entryId) {
        const previous = await disableAutoSync(app);
        const post = () => apiRequest('POST', `${appPath(app.metadata.name)}/rollback`, {id: entryId, prune: false, appNamespace: app.metadata.namespace});
        try {
            try {
                await post();
            } catch (e) {
                if (!(previous && /auto-sync|automated/i.test(e.message))) throw e;
                await sleep(2000);
                await post();
            }
        } catch (e) {
            if (previous) {
                const fresh = await getApp(app).catch(() => null);
                if (fresh && !isAutoSync(fresh)) await patchAutoSync(app, previous).catch(() => {});
            }
            throw e;
        }
        return {track: true, verify: async () => (isAutoSync(await getApp(app)) ? REVERTED_BY_APPSET : null)};
    }

    async function syncApp(app, enableAutoSync, appSetPolicy) {
        let enabled = false;
        let note = '';
        if (enableAutoSync) {
            try {
                enabled = await restoreAutoSync(app, appSetPolicy);
                if (enabled) note = 'auto-sync re-enabled';
            } catch (e) {
                note = `auto-sync not restored: ${e.message}`;
            }
        }
        try {
            await apiRequest('POST', `${appPath(app.metadata.name)}/sync`, {prune: false, appNamespace: app.metadata.namespace});
        } catch (e) {
            if (enabled && /operation is already in progress/i.test(e.message)) return {track: true, message: 'auto-sync started it'};
            throw new Error([e.message, note].filter(Boolean).join(' | '));
        }
        return {track: true, message: note};
    }

    const nodeKey = n => `${n.group || ''}/${n.kind}`;
    const nodeId = (group, kind, namespace, name) => `${group || ''}/${kind}/${namespace || ''}/${name}`;

    async function workloadRefs(app, rollouts) {
        const refs = new Set();
        for (const r of rollouts) {
            const params = new URLSearchParams({
                name: app.metadata.name, appNamespace: app.metadata.namespace, namespace: r.namespace || '',
                resourceName: r.name, version: r.version, kind: r.kind, group: r.group
            });
            const data = await apiRequest('GET', `${appPath(app.metadata.name)}/resource?${params}`);
            const ref = (JSON.parse(data.manifest || '{}').spec || {}).workloadRef;
            if (ref && ref.name) refs.add(nodeId((ref.apiVersion || '').split('/')[0], ref.kind, r.namespace, ref.name));
        }
        return refs;
    }

    async function restartTargets(app) {
        const tree = await apiRequest('GET', `${appPath(app.metadata.name)}/resource-tree?${nsQuery(app)}`);
        const nodes = (tree.nodes || []).filter(n => RESTARTABLE.has(nodeKey(n)) && !(n.parentRefs && n.parentRefs.length));
        const refs = await workloadRefs(app, nodes.filter(n => n.kind === 'Rollout'));
        return nodes.filter(n => !refs.has(nodeId(n.group, n.kind, n.namespace, n.name)));
    }

    let legacyActionsApi = false;
    const isMissingRoute = e => [405, 501].includes(e.status) || (e.status === 404 && /^(not found)?$/i.test(e.serverMessage.trim()));

    async function runRestartAction(app, n) {
        const target = {namespace: n.namespace || '', resourceName: n.name, version: n.version, kind: n.kind, group: n.group || ''};
        if (!legacyActionsApi) {
            try {
                await apiRequest('POST', `${appPath(app.metadata.name)}/resource/actions/v2`, {
                    name: app.metadata.name, appNamespace: app.metadata.namespace, ...target, action: 'restart', resourceActionParameters: []
                });
                return;
            } catch (e) {
                if (!isMissingRoute(e)) throw e;
                legacyActionsApi = true;
            }
        }
        const params = new URLSearchParams({appNamespace: app.metadata.namespace, ...target});
        await apiRequest('POST', `${appPath(app.metadata.name)}/resource/actions?${params}`, 'restart');
    }

    async function restartApp(app) {
        const targets = await restartTargets(app);
        if (targets.length === 0) return {status: 'skipped', message: 'no Deployment/Rollout'};
        const done = [];
        const failed = [];
        for (const n of targets) {
            try {
                await runRestartAction(app, n);
                done.push(`${n.kind}/${n.name}`);
            } catch (e) {
                failed.push(`${n.kind}/${n.name}: ${e.message}`);
            }
        }
        if (failed.length === 0) return {status: 'ok', message: done.join(', ')};
        return {status: 'error', message: [done.length ? `restarted ${done.join(', ')}` : '', `failed ${failed.join('; ')}`].filter(Boolean).join(' | ')};
    }

    async function waitForOperations(listOperations, pending, onDone) {
        const deadline = Date.now() + OP_TIMEOUT_MS;
        const left = new Map(pending.map(p => [p.key, p]));
        while (left.size && Date.now() < deadline) {
            await sleep(OP_POLL_MS);
            let items;
            try {
                items = await listOperations();
            } catch (_) {
                continue;
            }
            for (const app of items) {
                const p = left.get(appKey(app));
                const op = app.status && app.status.operationState;
                if (!p || !op || !op.phase || op.phase === 'Running' || op.phase === 'Terminating' || (op.startedAt || '') === p.before) continue;
                left.delete(p.key);
                await onDone(p, op.phase === 'Succeeded' ? 'ok' : 'error', [op.phase, op.message].filter(Boolean).join(': '));
            }
        }
        for (const p of left.values()) await onDone(p, 'error', 'timed out waiting for operation');
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

    const mutedStyle = {color: '#6d7f8b', fontSize: '13px'};
    const monoCell = {...cellStyle, fontFamily: 'monospace'};
    const stopPropagation = e => e.stopPropagation();

    const AppStatusTable = ({apps, histories, resolving, results}) => h(Table, {columns: [
        {label: 'Application', width: '30%'}, {label: 'Sync', width: '110px'}, {label: 'Health', width: '120px'},
        {label: 'Auto-sync', width: '90px'}, {label: 'Build commit', width: '120px'}, {label: 'Result', width: '30%'}
    ]}, apps.map(app => {
        const key = appKey(app);
        const res = results[key];
        const cur = currentCommit(app, histories);
        return h('tr', {key},
            h('td', {style: cellStyle, title: key}, h('a', {href: `/applications/${key}`}, app.metadata.name)),
            h('td', {style: cellStyle}, h(Badge, {text: app.status.sync && app.status.sync.status})),
            h('td', {style: cellStyle}, h(Badge, {text: app.status.health && app.status.health.status})),
            h('td', {style: cellStyle}, isAutoSync(app) ? 'on' : 'off'),
            h('td', {style: monoCell, title: cur || ''}, resolving ? '...' : shortSha(cur) || '-'),
            h('td', {style: cellStyle, title: res ? res.message : ''}, res && h('span', null, h(Badge, {text: res.status}), res.message ? ` ${res.message}` : ''))
        );
    }));

    const RollbackHistoryRow = ({target, total, selected, busy, onPick}) => {
        const isCurrent = target.current.size === total;
        const search = githubCommitSearch(target.configRepo, target.commit);
        const pick = () => !busy && onPick(selected ? '' : target.commit);
        return h('tr', {onClick: pick, style: {cursor: busy ? 'default' : 'pointer', background: selected ? '#e6f7fc' : undefined}},
            h('td', {style: cellStyle}, h('input', {type: 'radio', checked: selected, disabled: busy, onChange: pick, onClick: stopPropagation, style: {margin: 0}})),
            h('td', {style: monoCell, title: target.commit},
                search ? h('a', {...linkProps(search), onClick: stopPropagation}, shortSha(target.commit)) : shortSha(target.commit),
                isCurrent && h('span', {style: {marginLeft: '6px'}}, h(Badge, {text: 'current'}))),
            h('td', {style: cellStyle}, target.slackUsername || '-'),
            h('td', {style: cellStyle}, fmtTime(target.commitTime) || '-'),
            h('td', {style: cellStyle}, fmtTime(target.deployedAt) || '-'),
            h('td', {style: cellStyle}, target.initiatedBy || '-'),
            h('td', {style: monoCell, title: target.configRevision || ''},
                target.configRevision && target.configRepo
                    ? h('a', {...linkProps(`${target.configRepo}/commit/${target.configRevision}`), onClick: stopPropagation}, shortSha(target.configRevision))
                    : shortSha(target.configRevision) || '-'),
            h('td', {style: cellStyle, title: Array.from(target.apps).join('\n')},
                `${target.apps.size}/${total}${target.current.size && !isCurrent ? ` (${target.current.size} current)` : ''}`)
        );
    };

    const RollbackHistoryTable = ({targets, total, targetCommit, busy, resolving, onPick}) => h('div', null,
        h('div', {style: sectionTitleStyle}, 'Rollback history',
            resolving && h('span', {style: {textTransform: 'none', fontWeight: 400, marginLeft: '8px'}}, h('i', {className: 'fa fa-spinner fa-spin'}), ' resolving build commits...')),
        !resolving && targets.length === 0
            ? h('div', {style: mutedStyle}, 'No build commits found in app history.')
            : h(Table, {columns: [
                {label: '', width: '36px'}, {label: 'Build commit', width: '130px'}, {label: 'Built by', width: '120px'},
                {label: 'Committed', width: '170px'}, {label: 'Last deployed', width: '170px'}, {label: 'Deployed by', width: '140px'},
                {label: 'Launchpad commit', width: '140px'}, {label: 'Apps', width: '120px'}
            ]}, targets.map(t => h(RollbackHistoryRow, {key: t.commit, target: t, total, selected: targetCommit === t.commit, busy, onPick})))
    );

    const BranchSection = ({scopeKey, branch, onBusy}) => {
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
        const namespace = nsOfKey(scopeKey);

        const fetchApps = async () => (await listBranchApps(branch, SECTION_FIELDS))
            .filter(a => nsKey(a) === scopeKey)
            .sort((a, b) => a.metadata.name.localeCompare(b.metadata.name));

        const loadApps = async () => {
            const id = ++loadId.current;
            setLoading(true);
            setError(null);
            try {
                const items = await fetchApps();
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
        }, [scopeKey, branch]);

        React.useEffect(() => {
            if (onBusy) onBusy(branch, busy);
        }, [busy]);

        const setResult = (key, status, message) => setResults(r => ({...r, [key]: {status, message}}));

        const runBulk = async (items, fn) => {
            setBusy(true);
            try {
                items.forEach(({app}) => setResult(appKey(app), 'running', ''));
                let before;
                try {
                    before = Object.fromEntries((await fetchApps()).map(a => [appKey(a), operationStart(a)]));
                } catch (e) {
                    items.forEach(({app}) => setResult(appKey(app), 'error', `could not read operation state: ${e.message}`));
                    return;
                }
                const pending = [];
                await runPool(items, async item => {
                    const key = appKey(item.app);
                    try {
                        const r = (await fn(item)) || {};
                        if (r.track) {
                            pending.push({key, before: before[key] || '', note: r.message || '', verify: r.verify});
                            setResult(key, 'running', ['waiting for operation', r.message].filter(Boolean).join(', '));
                        } else {
                            setResult(key, r.status || 'ok', r.message || '');
                        }
                    } catch (e) {
                        setResult(key, 'error', e.message);
                    }
                });
                if (pending.length === 0) return;
                await waitForOperations(() => listBranchApps(branch, OPERATION_FIELDS), pending, async (p, status, message) => {
                    const problem = status === 'ok' && p.verify ? await p.verify().catch(e => `could not verify auto-sync: ${e.message}`) : null;
                    setResult(p.key, problem ? 'error' : status, problem || [message, p.note].filter(Boolean).join(' | '));
                });
            } finally {
                setBusy(false);
                loadApps();
            }
        };

        const targets = React.useMemo(() => rollbackTargets(apps, histories), [apps, histories]);
        const isProd = apps.some(a => (a.metadata.labels || {}).environment === 'prod');
        const requireText = isProd ? namespace : null;
        const scope = `Namespace ${nsKeyLabel(scopeKey)}, branch ${branchLabel(branch)}.`;
        const stale = loading || resolving;
        const noApps = busy || loading || apps.length === 0;
        const appNames = list => list.map(a => a.metadata.name);

        const freshPlan = async () => {
            const items = await fetchApps();
            const resolved = await resolveAppHistories(items);
            return {items, resolved, ...planRollback(items, resolved, targetCommit)};
        };

        const onSyncAll = () => setConfirm({
            title: `Sync ${apps.length} application(s)`,
            lines: [
                `${scope} Each app will sync to the latest revision in git (latest CI build for the branch).`,
                enableAutoSync ? 'Auto-sync will be re-enabled on apps whose ApplicationSet template enables it; other apps are left as they are.' : 'Auto-sync settings are left unchanged.'
            ],
            apps: appNames(apps),
            requireText,
            run: () => {
                const appSetPolicy = appSetPolicyLookup();
                return runBulk(apps.map(app => ({app})), ({app}) => syncApp(app, enableAutoSync, appSetPolicy));
            }
        });

        const onRestartAll = () => setConfirm({
            title: `Restart ${apps.length} application(s)`,
            lines: [
                `${scope} Runs the ArgoCD "restart" action on every Deployment, StatefulSet, DaemonSet and Argo Rollout in each app.`,
                'Deployments do a rolling restart; Rollouts restart pods via spec.restartAt, respecting maxUnavailable. Deployments referenced by a Rollout workloadRef are left alone. No git or image change.'
            ],
            apps: appNames(apps),
            requireText,
            run: () => runBulk(apps.map(app => ({app})), ({app}) => restartApp(app))
        });

        const applySkipped = skipped => skipped.forEach(({app, reason}) => setResult(appKey(app), 'skipped', reason));

        const appSetWarning = async plan => {
            const appSetPolicy = appSetPolicyLookup();
            const flags = await Promise.all(plan.map(({app}) => appSetPolicy(app).then(p => p.reenablesAutoSync, () => true)));
            const reverting = plan.filter((_, i) => flags[i]).map(p => p.app.metadata.name);
            return reverting.length
                ? `Warning: the ApplicationSet will re-enable auto-sync and undo the rollback for ${reverting.length} app(s) (${reverting.join(', ')}). Add /spec/syncPolicy to its ignoreApplicationDifferences to keep the rollback.`
                : '';
        };

        const onRollbackAll = async () => {
            const commit = targetCommit;
            setBusy(true);
            let fresh;
            let warning;
            try {
                fresh = await freshPlan();
                warning = await appSetWarning(fresh.plan);
            } catch (e) {
                setError(e.message);
                return;
            } finally {
                setBusy(false);
            }
            loadId.current++;
            setApps(fresh.items);
            setHistories(fresh.resolved);
            applySkipped(fresh.skipped);
            if (fresh.plan.length === 0) return;
            const confirmed = new Set(fresh.plan.map(p => appKey(p.app)));
            setConfirm({
                title: `Rollback ${fresh.plan.length} application(s) to ${shortSha(commit)}`,
                lines: [
                    `${scope} Auto-sync will be disabled on each app before rollback, and restored if the rollback request fails.`,
                    'This does not change launchpad. Syncing or re-enabling auto-sync later redeploys the latest build; revert _live_build.yml for a permanent rollback.',
                    warning,
                    fresh.skipped.length ? `${fresh.skipped.length} app(s) skipped (see table).` : ''
                ].filter(Boolean),
                apps: appNames(fresh.plan.map(p => p.app)),
                requireText,
                run: async () => {
                    setBusy(true);
                    let latest;
                    try {
                        latest = await freshPlan();
                    } catch (e) {
                        setError(e.message);
                        setBusy(false);
                        return;
                    }
                    applySkipped(latest.skipped.filter(s => confirmed.has(appKey(s.app))));
                    await runBulk(latest.plan.filter(p => confirmed.has(appKey(p.app))), ({app, entryId}) => rollbackApp(app, entryId));
                }
            });
        };

        const appsView = () => {
            if (loading && apps.length === 0) return h('div', {style: {color: '#6d7f8b'}}, h('i', {className: 'fa fa-spinner fa-spin'}), ' Loading applications...');
            if (apps.length === 0) return !error && h('div', {style: mutedStyle}, 'No applications.');
            return h('div', null,
                h(AppStatusTable, {apps, histories, resolving, results}),
                h(RollbackHistoryTable, {targets, total: apps.length, targetCommit, busy, resolving, onPick: setTargetCommit})
            );
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
                    h('button', {className: 'argo-button argo-button--base', style: buttonStyle, disabled: noApps, onClick: onSyncAll},
                        h('i', {className: 'fa fa-sync'}), ' Sync all'),
                    h('label', {style: {fontSize: '13px', display: 'flex', alignItems: 'center', gap: '6px', whiteSpace: 'nowrap', margin: 0}},
                        h('input', {type: 'checkbox', checked: enableAutoSync, onChange: e => setEnableAutoSync(e.target.checked), style: {margin: 0}}),
                        'Re-enable auto-sync')
                ),
                h('button', {className: 'argo-button argo-button--base', style: buttonStyle, disabled: noApps, onClick: onRestartAll},
                    h('i', {className: 'fa fa-redo-alt'}), ' Restart all'),
                h('button', {className: 'argo-button argo-button--base', style: buttonStyle, disabled: busy || stale || !targetCommit, onClick: onRollbackAll, title: targetCommit ? '' : 'Select a build in Rollback history below'},
                    h('i', {className: 'fa fa-step-backward'}), targetCommit ? ` Rollback all to ${shortSha(targetCommit)}` : ' Rollback all'),
                h('button', {className: 'argo-button argo-button--base-o', style: {...buttonStyle, marginLeft: 'auto'}, disabled: loading || busy, onClick: loadApps},
                    h('i', {className: loading ? 'fa fa-spinner fa-spin' : 'fa fa-redo'}), ' Refresh')
            ),
            appsView()
        );
    };

    const BranchAccordion = ({scopeKey, branch, count, open, busy, onToggle, onBusy}) =>
        h('div', {style: {background: '#fff', borderRadius: '4px', boxShadow: '1px 2px 3px rgba(0,0,0,0.1)', marginBottom: '12px'}},
            h('div', {onClick: () => onToggle(branch), style: {display: 'flex', alignItems: 'center', gap: '10px', padding: '12px 16px', cursor: 'pointer', userSelect: 'none'}},
                h('i', {className: `fa fa-fw fa-chevron-${open ? 'down' : 'right'}`, style: {color: '#6d7f8b'}}),
                h('strong', null, branchLabel(branch)),
                h('span', {style: mutedStyle}, `${count} app${count === 1 ? '' : 's'}`),
                busy && h('i', {className: 'fa fa-spinner fa-spin', style: {color: '#0dadea'}})
            ),
            open !== undefined && h('div', {style: {display: open ? 'block' : 'none', padding: '16px', borderTop: '1px solid #eff3f5', background: '#f8fbfb'}},
                h(BranchSection, {scopeKey, branch, onBusy}))
        );

    const buildIndex = items => {
        const idx = {};
        items.forEach(a => {
            if (!destNs(a)) return;
            const key = nsKey(a);
            const br = branchOf(a);
            idx[key] = idx[key] || {};
            idx[key][br] = (idx[key][br] || 0) + 1;
        });
        return idx;
    };

    const BulkSyncPage = () => {
        const [index, setIndex] = React.useState(null);
        const [indexError, setIndexError] = React.useState(null);
        const [scopeKey, setScopeKey] = React.useState('');
        const [branch, setBranch] = React.useState('');
        const [open, setOpen] = React.useState({});
        const [busyBranches, setBusyBranches] = React.useState({});

        React.useEffect(() => {
            listApps(null, INDEX_FIELDS).then(items => setIndex(buildIndex(items))).catch(e => setIndexError(e.message));
        }, []);

        const counts = (index && index[scopeKey]) || {};
        const scopes = index ? Object.keys(index).sort((a, b) => nsKeyLabel(a).localeCompare(nsKeyLabel(b))) : [];
        const branches = scopeKey ? Object.keys(counts).sort() : [];
        const busy = Object.values(busyBranches).some(Boolean);
        const onBusy = React.useCallback((br, value) => setBusyBranches(m => ({...m, [br]: value})), []);
        const toggle = br => setOpen(o => ({...o, [br]: !o[br]}));

        React.useEffect(() => {
            setBusyBranches({});
            setOpen(branches.length === 1 ? {[branches[0]]: true} : {});
        }, [scopeKey, index]);

        return h('div', {style: {padding: '24px 16px', maxWidth: '1400px', boxSizing: 'border-box'}},
            indexError && h('div', {style: {color: '#e96d76', marginBottom: '12px'}}, indexError),
            h('div', {style: {display: 'flex', gap: '16px 24px', alignItems: 'flex-end', marginBottom: '20px', flexWrap: 'wrap'}},
                h('div', {style: {maxWidth: '100%'}},
                    h('div', {style: labelStyle}, 'Namespace'),
                    h('select', {style: selectStyle, value: scopeKey, disabled: !index || busy, onChange: e => { setScopeKey(e.target.value); setBranch(''); }},
                        h('option', {value: ''}, index ? 'Select namespace' : 'Loading...'),
                        scopes.map(key => h('option', {key, value: key}, nsKeyLabel(key)))
                    )
                ),
                h('div', {style: {maxWidth: '100%'}},
                    h('div', {style: labelStyle}, 'Branch'),
                    h('select', {style: selectStyle, value: branch, disabled: !scopeKey || busy, onChange: e => setBranch(e.target.value)},
                        h('option', {value: ''}, scopeKey ? `All branches (${branches.length})` : 'All branches'),
                        branches.map(br => h('option', {key: br, value: br}, `${branchLabel(br)} (${counts[br]})`))
                    )
                )
            ),

            index && !scopeKey && h('div', {style: mutedStyle}, 'Select a namespace to see its branches.'),

            scopeKey && branch && h(BranchSection, {key: `${scopeKey}/${branch}`, scopeKey, branch, onBusy}),

            scopeKey && !branch && branches.map(br => h(BranchAccordion, {
                key: `${scopeKey}/${br}`, scopeKey, branch: br, count: counts[br], open: open[br], busy: busyBranches[br], onToggle: toggle, onBusy
            }))
        );
    };

    const describeSidebarItem = (title, description) => {
        const registry = window.extSidebarDescriptions || (window.extSidebarDescriptions = {items: {}, observer: null});
        registry.items[title] = description;
        if (registry.observer) return;
        if (!document.getElementById('ext-nav-icon-style')) {
            const style = document.createElement('style');
            style.id = 'ext-nav-icon-style';
            style.textContent = '.sidebar__nav-item i.fa.ext-nav-icon{margin:0 19px 0 0;padding-right:0;width:26px;display:inline-block;vertical-align:middle;line-height:1;text-align:center}.sidebar--collapsed .sidebar__nav-item i.fa.ext-nav-icon{margin-left:7px}';
            document.head.appendChild(style);
        }
        const attach = el => {
            const text = registry.items[el.textContent];
            if (el.dataset.extDescription || !text) return;
            el.dataset.extDescription = '1';
            const d = document.createElement('div');
            d.textContent = text;
            d.style.cssText = 'font-size:12px;font-weight:400;opacity:0.8;margin-top:4px;max-width:240px;white-space:normal;line-height:1.4';
            el.appendChild(d);
        };
        registry.observer = new MutationObserver(mutations => mutations.forEach(m => m.addedNodes.forEach(n => {
            if (n.nodeType !== 1) return;
            if (n.classList.contains('sidebar__tooltip')) attach(n);
            else if (n.matches('[data-tippy-root], .tippy-popper')) n.querySelectorAll('.sidebar__tooltip').forEach(attach);
        })));
        registry.observer.observe(document.body, {childList: true, subtree: true});
    };

    const registerPage = () => window.extensionsAPI.registerSystemLevelExtension(BulkSyncPage, 'Bulk Sync', '/bulk-sync', 'fa-layer-group fa-fw ext-nav-icon');
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
