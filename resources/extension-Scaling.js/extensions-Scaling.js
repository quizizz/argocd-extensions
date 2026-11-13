((window) => {
    const h = React.createElement;
    const CONCURRENCY = 5;
    const ALL_BRANCHES = '*';

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

    async function listApps(selector, fields) {
        const params = new URLSearchParams();
        if (selector) params.set('selector', selector);
        if (fields) params.set('fields', fields.join(','));
        const qs = params.toString();
        const data = await apiRequest('GET', `/api/v1/applications${qs ? `?${qs}` : ''}`);
        return data.items || [];
    }

    const getTree = app => apiRequest('GET', `${appPath(app.metadata.name)}/resource-tree?appNamespace=${encodeURIComponent(app.metadata.namespace)}`);

    async function getLive(app, node) {
        const params = new URLSearchParams({
            name: node.name,
            appNamespace: app.metadata.namespace,
            namespace: node.namespace || '',
            resourceName: node.name,
            version: node.version || '',
            kind: node.kind,
            group: node.group || ''
        });
        const data = await apiRequest('GET', `${appPath(app.metadata.name)}/resource?${params.toString()}`);
        return data.manifest ? JSON.parse(data.manifest) : null;
    }

    const WORKLOAD_KINDS = {Deployment: 'apps', Rollout: 'argoproj.io'};

    function scalingNodes(tree, soName) {
        const nodes = (tree && tree.nodes) || [];
        const so = nodes.find(n => n.kind === 'ScaledObject' && n.group === 'keda.sh' && (!soName || n.name === soName));
        const hpa = so && (nodes.find(n => n.kind === 'HorizontalPodAutoscaler' && (n.parentRefs || []).some(p => p.kind === 'ScaledObject' && p.name === so.name))
            || nodes.find(n => n.kind === 'HorizontalPodAutoscaler' && n.name === `keda-hpa-${so.name}`));
        const workload = nodes.find(n => WORKLOAD_KINDS[n.kind] === n.group);
        return {so, hpa, workload};
    }

    function parseQuantity(q) {
        if (q === undefined || q === null || q === '') return null;
        if (typeof q === 'number') return q;
        const m = String(q).match(/^(-?[0-9.]+)([a-zA-Z]*)$/);
        if (!m) return null;
        const scale = {m: 1e-3, k: 1e3, M: 1e6, G: 1e9, Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3}[m[2]] || 1;
        return parseFloat(m[1]) * scale;
    }

    function fmtNumber(n) {
        if (n === null || n === undefined || isNaN(n)) return '-';
        if (Math.abs(n) >= 1000) return Math.round(n).toLocaleString();
        return String(Math.round(n * 100) / 100);
    }

    function triggerLabel(t) {
        const md = t.metadata || {};
        if (t.type === 'prometheus') return md.metricName ? `prometheus ${md.metricName}` : 'prometheus';
        if (t.type === 'aws-sqs-queue') return `sqs ${(md.queueURL || '').split('/').pop()}`;
        return t.name ? `${t.type} ${t.name}` : t.type;
    }

    function triggerTarget(t) {
        const md = t.metadata || {};
        if (t.type === 'cpu' || t.type === 'memory') return `${md.value}${t.metricType === 'Utilization' || !t.metricType ? '%' : ''}`;
        if (t.type === 'cron') return `${md.desiredReplicas} pods`;
        return md.threshold || md.queueLength || md.targetValue || md.value || md.desiredReplicas || '-';
    }

    function metricValue(m) {
        if (!m) return null;
        if (m.averageUtilization !== undefined) return {value: m.averageUtilization, pct: true};
        const raw = m.averageValue !== undefined ? m.averageValue : m.value;
        return {value: parseQuantity(raw), pct: false};
    }

    function currentMetricsByKey(hpa) {
        const out = {};
        ((hpa && hpa.status && hpa.status.currentMetrics) || []).forEach(m => {
            if (m.type === 'Resource' && m.resource) out[`resource:${m.resource.name}`] = metricValue(m.resource.current);
            if (m.type === 'ContainerResource' && m.containerResource) out[`resource:${m.containerResource.name}`] = metricValue(m.containerResource.current);
            if (m.type === 'External' && m.external) out[`external:${m.external.metric.name}`] = metricValue(m.external.current);
        });
        return out;
    }

    function externalIndex(name) {
        const m = String(name).match(/^s(\d+)-/);
        return m ? parseInt(m[1], 10) : null;
    }

    function cronWindow(t) {
        const md = t.metadata || {};
        return {start: md.start, end: md.end, timezone: md.timezone, desiredReplicas: md.desiredReplicas};
    }

    function summarize(so, hpa, workload) {
        if (!so) {
            const replicas = workload && workload.spec ? workload.spec.replicas : null;
            const ready = workload && workload.status ? workload.status.readyReplicas || 0 : null;
            return {state: workload ? 'fixed' : 'none', min: replicas, max: replicas, current: ready, desired: replicas, triggers: [], crons: [], issues: []};
        }
        const min = so.spec.minReplicaCount !== undefined ? so.spec.minReplicaCount : 0;
        const max = so.spec.maxReplicaCount !== undefined ? so.spec.maxReplicaCount : 100;
        const hs = (hpa && hpa.status) || {};
        const current = hs.currentReplicas !== undefined ? hs.currentReplicas : null;
        const desired = hs.desiredReplicas !== undefined ? hs.desiredReplicas : null;
        const current_ = currentMetricsByKey(hpa);
        const externalByIndex = {};
        Object.keys(current_).forEach(k => {
            if (!k.startsWith('external:')) return;
            const idx = externalIndex(k.slice('external:'.length));
            if (idx !== null) externalByIndex[idx] = current_[k];
        });
        const triggers = (so.spec.triggers || []).map((t, i) => {
            const cur = t.type === 'cpu' || t.type === 'memory' ? current_[`resource:${t.type}`] : externalByIndex[i];
            return {type: t.type, label: triggerLabel(t), target: triggerTarget(t), current: cur ? `${fmtNumber(cur.value)}${cur.pct ? '%' : ''}` : '-'};
        });
        const crons = (so.spec.triggers || []).filter(t => t.type === 'cron').map(cronWindow);
        const issues = [];
        const hpaCond = type => (hs.conditions || []).find(c => c.type === type);
        const soConds = (so.status && so.status.conditions) || [];
        const soCond = type => soConds.find(c => c.type === type);
        const limited = hpaCond('ScalingLimited');
        const ableToScale = hpaCond('AbleToScale');
        const active = hpaCond('ScalingActive');
        const ready = soCond('Ready');
        const paused = soCond('Paused');
        const fallback = soCond('Fallback');
        if (ready && ready.status === 'False') issues.push(`ScaledObject not ready: ${ready.reason || ''} ${ready.message || ''}`.trim());
        if (fallback && fallback.status === 'True') issues.push(`Fallback active: ${fallback.message || fallback.reason || ''}`.trim());
        if (active && active.status === 'False') issues.push(`HPA metrics failing: ${active.reason || ''} ${active.message || ''}`.trim());
        if (ableToScale && ableToScale.status === 'False') issues.push(`HPA unable to scale: ${ableToScale.reason || ''} ${ableToScale.message || ''}`.trim());
        if (!hpa) issues.push('HPA not found');
        const pausedAnno = so.metadata && so.metadata.annotations && (so.metadata.annotations['autoscaling.keda.sh/paused'] === 'true' || so.metadata.annotations['autoscaling.keda.sh/paused-replicas'] !== undefined);
        const atMax = (limited && limited.status === 'True' && limited.reason === 'TooManyReplicas') || (current !== null && current >= max);
        const atMin = current !== null && current <= min;
        let state = 'scaling';
        if ((paused && paused.status === 'True') || pausedAnno) state = 'paused';
        else if (issues.length && !hpa) state = 'error';
        else if (atMax) state = 'at max';
        else if (atMin) state = 'at min';
        if (state !== 'paused' && state !== 'error' && issues.length) state = `${state} !`;
        return {state, min, max, current, desired, triggers, crons, issues, hpaName: hpa && hpa.metadata.name};
    }

    async function loadScaling(app, tree) {
        const t = tree || await getTree(app);
        const {so, hpa, workload} = scalingNodes(t);
        const [soLive, hpaLive, workloadLive] = await Promise.all([
            so ? getLive(app, so) : null,
            hpa ? getLive(app, hpa).catch(() => null) : null,
            !so && workload ? getLive(app, workload) : null
        ]);
        return summarize(soLive, hpaLive, workloadLive);
    }

    const labelStyle = {fontSize: '12px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: '#6d7f8b', marginBottom: '4px'};
    const selectStyle = {minWidth: '240px', height: '34px', padding: '0 36px 0 12px', border: '1px solid #dee6eb', borderRadius: '4px', background: "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'><path d='M1 1l5 5 5-5' fill='none' stroke='%236d7f8b' stroke-width='1.6'/></svg>\") no-repeat right 12px center / 12px 8px #fff", appearance: 'none', WebkitAppearance: 'none', MozAppearance: 'none', fontSize: '14px', cursor: 'pointer'};
    const cellStyle = {padding: '8px 12px', borderBottom: '1px solid #eff3f5', fontSize: '13px', verticalAlign: 'top'};
    const tableStyle = {width: '100%', borderCollapse: 'collapse', background: '#fff', borderRadius: '4px', boxShadow: '1px 2px 3px rgba(0,0,0,0.1)'};

    const stateColor = state => {
        const base = String(state).replace(' !', '');
        return {'at max': '#e96d76', 'at min': '#8fa4b1', scaling: '#18be94', paused: '#766f94', fixed: '#6d7f8b', none: '#ccd6dd', error: '#e96d76'}[base] || '#8fa4b1';
    };

    const StateBadge = ({state}) => h('span', {
        style: {display: 'inline-block', padding: '1px 8px', borderRadius: '8px', fontSize: '12px', color: '#fff', background: stateColor(state), whiteSpace: 'nowrap'}
    }, state);

    const UsageBar = ({min, max, current}) => {
        if (current === null || current === undefined || !max) return h('span', null, '-');
        const pct = Math.min(100, Math.round((current / max) * 100));
        const minPct = Math.min(100, Math.round((min / max) * 100));
        const color = pct >= 100 ? '#e96d76' : pct >= 80 ? '#f4c030' : '#18be94';
        return h('div', {title: `${current} / ${max} (${pct}%)`, style: {position: 'relative', width: '140px', height: '10px', background: '#eff3f5', borderRadius: '5px', marginTop: '4px'}},
            h('div', {style: {width: `${pct}%`, height: '100%', background: color, borderRadius: '5px'}}),
            h('div', {style: {position: 'absolute', left: `${minPct}%`, top: '-2px', width: '2px', height: '14px', background: '#6d7f8b'}})
        );
    };

    const fmtCron = c => `${c.start} → ${c.end}${c.timezone ? ` ${c.timezone}` : ''}: ${c.desiredReplicas}`;

    const TriggerList = ({triggers}) => h('div', null, triggers.filter(t => t.type !== 'cron').map((t, i) =>
        h('div', {key: i, style: {whiteSpace: 'nowrap'}}, `${t.label}: `, h('strong', null, t.current), ` / ${t.target}`)));

    const ScalingCard = ({summary}) => {
        if (!summary) return h('div', {style: {color: '#6d7f8b'}}, h('i', {className: 'fa fa-spinner fa-spin'}), ' Loading scaling...');
        const s = summary;
        const stat = (label, value) => h('div', {style: {marginRight: '32px'}}, h('div', {style: labelStyle}, label), h('div', {style: {fontSize: '22px'}}, value === null || value === undefined ? '-' : value));
        return h('div', null,
            h('div', {style: {display: 'flex', alignItems: 'flex-end', marginBottom: '16px', flexWrap: 'wrap', gap: '8px'}},
                stat('Min', s.min), stat('Current', s.current), stat('Desired', s.desired), stat('Max', s.max),
                h('div', null, h(StateBadge, {state: s.state}), h(UsageBar, {min: s.min, max: s.max, current: s.current}))
            ),
            s.issues.length > 0 && h('div', {style: {color: '#e96d76', marginBottom: '12px', fontSize: '13px'}}, s.issues.map((m, i) => h('div', {key: i}, m))),
            s.triggers.length > 0 && h('table', {style: {...tableStyle, marginBottom: '16px'}},
                h('thead', null, h('tr', null, ['Trigger', 'Current', 'Target'].map(c => h('th', {key: c, style: {...cellStyle, ...labelStyle, textAlign: 'left'}}, c)))),
                h('tbody', null, s.triggers.map((t, i) => h('tr', {key: i},
                    h('td', {style: cellStyle}, t.label),
                    h('td', {style: cellStyle}, t.current),
                    h('td', {style: cellStyle}, t.target)
                )))
            ),
            s.crons.length > 0 && h('div', null,
                h('div', {style: labelStyle}, 'Cron windows'),
                s.crons.map((c, i) => h('div', {key: i, style: {fontFamily: 'monospace', fontSize: '12px'}}, fmtCron(c)))
            ),
            s.hpaName && h('div', {style: {color: '#6d7f8b', fontSize: '12px', marginTop: '12px'}}, `HPA: ${s.hpaName}`)
        );
    };

    const ScaledObjectTab = ({application, resource, tree}) => {
        const [summary, setSummary] = React.useState(null);
        const [error, setError] = React.useState(null);
        const soName = resource && resource.metadata && resource.metadata.name;
        React.useEffect(() => {
            let cancelled = false;
            const {hpa} = scalingNodes(tree, soName);
            (hpa ? getLive(application, hpa).catch(() => null) : Promise.resolve(null))
                .then(hpaLive => { if (!cancelled) setSummary(summarize(resource, hpaLive, null)); })
                .catch(e => { if (!cancelled) setError(e.message); });
            return () => { cancelled = true; };
        }, [application && application.metadata.name, soName, resource && resource.metadata && resource.metadata.resourceVersion]);
        if (error) return h('div', {style: {color: '#e96d76'}}, error);
        return h('div', {style: {padding: '16px'}}, h(ScalingCard, {summary}));
    };

    const ScalingPage = () => {
        const [index, setIndex] = React.useState(null);
        const [error, setError] = React.useState(null);
        const [namespace, setNamespace] = React.useState('');
        const [branch, setBranch] = React.useState(ALL_BRANCHES);
        const [apps, setApps] = React.useState([]);
        const [summaries, setSummaries] = React.useState({});
        const [loading, setLoading] = React.useState(false);
        const [onlyCapped, setOnlyCapped] = React.useState(false);
        const loadId = React.useRef(0);

        React.useEffect(() => {
            listApps(null, ['items.metadata.name', 'items.metadata.labels', 'items.spec.destination']).then(items => {
                const idx = {};
                items.forEach(a => {
                    const ns = destNs(a);
                    if (!ns) return;
                    idx[ns] = idx[ns] || {};
                    const br = branchOf(a) || '-';
                    idx[ns][br] = (idx[ns][br] || 0) + 1;
                });
                setIndex(idx);
            }).catch(e => setError(e.message));
        }, []);

        const load = async (ns, br) => {
            if (!ns) return;
            const id = ++loadId.current;
            setLoading(true);
            setSummaries({});
            try {
                const selector = br && br !== ALL_BRANCHES ? `branch=${br}` : null;
                const items = (await listApps(selector, ['items.metadata.name', 'items.metadata.namespace', 'items.metadata.labels', 'items.spec.destination']))
                    .filter(a => destNs(a) === ns);
                if (id !== loadId.current) return;
                setApps(items);
                await runPool(items, async app => {
                    let summary;
                    try {
                        summary = await loadScaling(app);
                    } catch (e) {
                        summary = {state: 'error', issues: [e.message], triggers: [], crons: [], min: null, max: null, current: null, desired: null};
                    }
                    if (id === loadId.current) setSummaries(s => ({...s, [app.metadata.name]: summary}));
                });
            } catch (e) {
                setError(e.message);
            } finally {
                if (id === loadId.current) setLoading(false);
            }
        };

        React.useEffect(() => {
            setApps([]);
            load(namespace, branch);
        }, [namespace, branch]);

        const ratio = s => (s && s.state !== 'fixed' && s.max && s.current !== null ? s.current / s.max : -1);
        const rows = apps
            .filter(a => !onlyCapped || (summaries[a.metadata.name] && String(summaries[a.metadata.name].state).startsWith('at max')))
            .sort((a, b) => ratio(summaries[b.metadata.name]) - ratio(summaries[a.metadata.name]) || a.metadata.name.localeCompare(b.metadata.name));
        const cappedCount = Object.values(summaries).filter(s => String(s.state).startsWith('at max')).length;

        const namespaces = index ? Object.keys(index).sort() : [];
        const branches = index && namespace ? Object.keys(index[namespace] || {}).sort() : [];

        return h('div', {style: {padding: '24px', maxWidth: '1600px'}},
            error && h('div', {style: {color: '#e96d76', marginBottom: '12px'}}, error),
            h('div', {style: {display: 'flex', gap: '24px', alignItems: 'flex-end', marginBottom: '20px', flexWrap: 'wrap'}},
                h('div', null,
                    h('div', {style: labelStyle}, 'Namespace'),
                    h('select', {style: selectStyle, value: namespace, disabled: !index, onChange: e => { setNamespace(e.target.value); setBranch(ALL_BRANCHES); }},
                        h('option', {value: ''}, index ? 'Select namespace' : 'Loading...'),
                        namespaces.map(ns => h('option', {key: ns, value: ns}, ns))
                    )
                ),
                h('div', null,
                    h('div', {style: labelStyle}, 'Branch'),
                    h('select', {style: selectStyle, value: branch, disabled: !namespace, onChange: e => setBranch(e.target.value)},
                        h('option', {value: ALL_BRANCHES}, 'All branches'),
                        branches.filter(br => br !== '-').map(br => h('option', {key: br, value: br}, `${br} (${index[namespace][br]})`))
                    )
                ),
                h('button', {className: 'argo-button argo-button--base-o', disabled: !namespace || loading, onClick: () => load(namespace, branch)},
                    h('i', {className: loading ? 'fa fa-spinner fa-spin' : 'fa fa-redo'}), ' Refresh'),
                namespace && h('label', {style: {fontSize: '13px', display: 'flex', alignItems: 'center', gap: '6px'}},
                    h('input', {type: 'checkbox', checked: onlyCapped, onChange: e => setOnlyCapped(e.target.checked)}),
                    `Only at max (${cappedCount})`)
            ),
            namespace && apps.length === 0 && loading && h('div', {style: {color: '#6d7f8b'}}, h('i', {className: 'fa fa-spinner fa-spin'}), ' Loading applications...'),
            rows.length > 0 && h('table', {style: tableStyle},
                h('thead', null, h('tr', null,
                    ['Application', 'Branch', 'Min', 'Current', 'Desired', 'Max', 'Usage', 'Triggers (current / target)', 'Cron windows', 'State'].map(c =>
                        h('th', {key: c, style: {...cellStyle, ...labelStyle, textAlign: 'left'}}, c))
                )),
                h('tbody', null, rows.map(app => {
                    const name = app.metadata.name;
                    const s = summaries[name];
                    const v = x => (x === null || x === undefined ? '-' : x);
                    return h('tr', {key: name},
                        h('td', {style: cellStyle}, h('a', {href: `/applications/${app.metadata.namespace}/${name}`}, name)),
                        h('td', {style: cellStyle}, branchOf(app)),
                        h('td', {style: cellStyle}, s ? v(s.min) : '...'),
                        h('td', {style: {...cellStyle, fontWeight: 600}}, s ? v(s.current) : '...'),
                        h('td', {style: cellStyle}, s ? v(s.desired) : '...'),
                        h('td', {style: cellStyle}, s ? v(s.max) : '...'),
                        h('td', {style: cellStyle}, s ? h(UsageBar, {min: s.min, max: s.max, current: s.current}) : ''),
                        h('td', {style: {...cellStyle, fontSize: '12px'}}, s ? h(TriggerList, {triggers: s.triggers}) : ''),
                        h('td', {style: {...cellStyle, fontSize: '12px', fontFamily: 'monospace'}}, s ? s.crons.map((c, i) => h('div', {key: i, style: {whiteSpace: 'nowrap'}}, fmtCron(c))) : ''),
                        h('td', {style: cellStyle, title: s ? s.issues.join('\n') : ''}, s ? h(StateBadge, {state: s.state}) : '')
                    );
                }))
            )
        );
    };

    const registerPage = () => window.extensionsAPI.registerSystemLevelExtension(ScalingPage, 'Scaling', '/scaling', 'fa-expand-arrows-alt fa-fw');
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
    window.extensionsAPI.registerResourceExtension(ScaledObjectTab, 'keda.sh', 'ScaledObject', 'Scaling', {icon: 'fa fa-expand-arrows-alt'});
})(window);
