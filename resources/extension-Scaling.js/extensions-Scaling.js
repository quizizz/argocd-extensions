((window) => {
    const h = React.createElement;
    if (!document.getElementById('ext-theme-vars')) {
        const themeStyle = document.createElement('style');
        themeStyle.id = 'ext-theme-vars';
        themeStyle.textContent = ':root{--ext-surface:#fff;--ext-surface-2:#f8fbfb;--ext-border:#eff3f5;--ext-border-strong:#dee6eb;--ext-text:#363c4a;--ext-strong:#364150;--ext-muted:#6d7f8b;--ext-selected:#e6f7fc;--ext-shadow:rgba(0,0,0,0.1);--ext-hover:rgba(0,0,0,0.08);--ext-active:rgba(0,0,0,0.15)}.theme-dark{--ext-surface:#303237;--ext-surface-2:#28292a;--ext-border:#495763;--ext-border-strong:#6d7f8b;--ext-text:#fff;--ext-strong:#dee6eb;--ext-muted:#a5b5c0;--ext-selected:#004c67;--ext-shadow:rgba(0,0,0,0.5);--ext-hover:rgba(255,255,255,0.08);--ext-active:rgba(255,255,255,0.15)}';
        document.head.appendChild(themeStyle);
    }
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

    const WORKLOAD_KINDS = {Deployment: 'apps', StatefulSet: 'apps', Rollout: 'argoproj.io'};
    const QUANTITY_SCALE = {
        n: 1e-9, u: 1e-6, m: 1e-3, '': 1, k: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15, E: 1e18,
        Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4, Pi: 1024 ** 5, Ei: 1024 ** 6
    };

    const hasSoParent = n => (n.parentRefs || []).some(p => p.kind === 'ScaledObject');
    const sameNs = (a, b) => (a.namespace || '') === (b.namespace || '');
    const hpaForSo = (hpas, so) => {
        const candidates = hpas.filter(n => sameNs(n, so));
        return candidates.find(n => (n.parentRefs || []).some(p => p.kind === 'ScaledObject' && p.name === so.name))
            || candidates.find(n => n.name === `keda-hpa-${so.name}`);
    };

    function scalingNodes(tree) {
        const nodes = (tree && tree.nodes) || [];
        const sos = nodes.filter(n => n.kind === 'ScaledObject' && n.group === 'keda.sh');
        const hpas = nodes.filter(n => n.kind === 'HorizontalPodAutoscaler');
        const pairs = sos.map(so => ({so, hpa: hpaForSo(hpas, so)}));
        const plainHpas = hpas.filter(n => !hasSoParent(n) && !pairs.some(p => p.hpa === n));
        const workloads = nodes.filter(n => Object.prototype.hasOwnProperty.call(WORKLOAD_KINDS, n.kind) && WORKLOAD_KINDS[n.kind] === n.group);
        return {pairs, plainHpas, workloads};
    }

    function parseQuantity(q) {
        if (q === undefined || q === null || q === '') return null;
        if (typeof q === 'number') return q;
        const m = String(q).trim().match(/^([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)([a-zA-Z]*)$/);
        if (!m || !(m[2] in QUANTITY_SCALE)) return null;
        return parseFloat(m[1]) * QUANTITY_SCALE[m[2]];
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

    function guessTriggerTarget(t) {
        const md = t.metadata || {};
        if (t.type === 'cpu' || t.type === 'memory') return `${md.value}${t.metricType === 'Utilization' || !t.metricType ? '%' : ''}`;
        if (t.type === 'cron') return `${md.desiredReplicas} pods`;
        return md.threshold || md.queueLength || md.targetValue || md.value || md.desiredReplicas || '-';
    }

    const isResourceTrigger = t => t.type === 'cpu' || t.type === 'memory';

    function metricKey(m) {
        if (m.type === 'Resource' && m.resource) return `resource:${m.resource.name}`;
        if (m.type === 'ContainerResource' && m.containerResource) return `container:${m.containerResource.name}:${m.containerResource.container}`;
        if (m.type === 'External' && m.external) return `external:${m.external.metric.name}`;
        if (m.type === 'Pods' && m.pods) return `pods:${m.pods.metric.name}`;
        if (m.type === 'Object' && m.object) return `object:${m.object.metric.name}`;
        return null;
    }

    const metricBody = m => m.resource || m.containerResource || m.external || m.pods || m.object || {};

    function triggerKey(t, i) {
        if (!isResourceTrigger(t)) return `s${i}`;
        const container = t.metadata && t.metadata.containerName;
        return container ? `container:${t.type}:${container}` : `resource:${t.type}`;
    }

    function externalIndex(name) {
        const m = String(name).match(/^s(\d+)-/);
        return m ? parseInt(m[1], 10) : null;
    }

    function indexMetrics(metrics, field) {
        const out = {};
        (metrics || []).forEach(m => {
            const key = metricKey(m);
            if (!key) return;
            const value = metricBody(m)[field];
            out[key] = value;
            const idx = m.type === 'External' ? externalIndex(m.external.metric.name) : null;
            if (idx !== null) out[`s${idx}`] = value;
        });
        return out;
    }

    function fmtMetric(m) {
        if (!m) return '-';
        if (m.averageUtilization !== undefined) return `${fmtNumber(m.averageUtilization)}%`;
        const raw = m.averageValue !== undefined ? m.averageValue : m.value;
        return raw === undefined ? '-' : fmtNumber(parseQuantity(raw));
    }

    const fmtTarget = target => (target ? (target.averageUtilization !== undefined ? `${target.averageUtilization}%` : target.averageValue || target.value || '-') : null);

    function cronWindow(t) {
        const md = t.metadata || {};
        return {start: md.start, end: md.end, timezone: md.timezone, desiredReplicas: md.desiredReplicas};
    }

    const refLabel = ref => (ref && ref.name ? `${ref.kind || 'Deployment'}/${ref.name}` : '');
    const condText = c => `${c.reason || ''} ${c.message || ''}`.trim();
    const conditionOf = (obj, type) => ((obj && obj.status && obj.status.conditions) || []).find(c => c.type === type);
    const orNull = v => (v !== undefined ? v : null);

    function hpaIssues(hpa, hpaError, paused) {
        if (!hpa) {
            if (hpaError) return [`HPA fetch failed: ${hpaError}`];
            return paused ? [] : ['HPA not found'];
        }
        const issues = [];
        const active = conditionOf(hpa, 'ScalingActive');
        const able = conditionOf(hpa, 'AbleToScale');
        if (active && active.status === 'False') issues.push(`HPA metrics failing: ${condText(active)}`);
        if (able && able.status === 'False') issues.push(`HPA unable to scale: ${condText(able)}`);
        return issues;
    }

    function scaleState({hpa, issues, current, min, max, paused}) {
        const limited = conditionOf(hpa, 'ScalingLimited');
        const atMax = (limited && limited.status === 'True' && limited.reason === 'TooManyReplicas') || (current !== null && max !== null && current >= max);
        const atMin = current !== null && min !== null && current <= min;
        if (paused) return 'paused';
        if (!hpa) return 'error';
        const state = atMax ? 'at max' : atMin ? 'at min' : 'scaling';
        return issues.length ? `${state} !` : state;
    }

    function hpaReplicas(hpa) {
        const hs = (hpa && hpa.status) || {};
        return {current: orNull(hs.currentReplicas), desired: orNull(hs.desiredReplicas)};
    }

    const baseSummary = obj => ({namespace: (obj.metadata && obj.metadata.namespace) || '', triggers: [], crons: [], issues: [], hpaName: null});

    function isSoPaused(so) {
        const annotations = (so.metadata && so.metadata.annotations) || {};
        const cond = conditionOf(so, 'Paused');
        return (cond && cond.status === 'True') || annotations['autoscaling.keda.sh/paused'] === 'true' || annotations['autoscaling.keda.sh/paused-replicas'] !== undefined;
    }

    function summarizeScaledObject(so, hpa, hpaError) {
        const min = orNull(so.spec.minReplicaCount) === null ? 0 : so.spec.minReplicaCount;
        const max = orNull(so.spec.maxReplicaCount) === null ? 100 : so.spec.maxReplicaCount;
        const {current, desired} = hpaReplicas(hpa);
        const metrics = indexMetrics(hpa && hpa.status && hpa.status.currentMetrics, 'current');
        const targets = indexMetrics(hpa && hpa.spec && hpa.spec.metrics, 'target');
        const soTriggers = so.spec.triggers || [];
        const triggers = soTriggers.map((t, i) => {
            const key = triggerKey(t, i);
            return {type: t.type, label: triggerLabel(t), target: fmtTarget(targets[key]) || guessTriggerTarget(t), current: fmtMetric(metrics[key])};
        });
        const ready = conditionOf(so, 'Ready');
        const fallback = conditionOf(so, 'Fallback');
        const paused = isSoPaused(so);
        const issues = [];
        if (ready && ready.status === 'False') issues.push(`ScaledObject not ready: ${condText(ready)}`);
        if (fallback && fallback.status === 'True') issues.push(`Fallback active: ${fallback.message || fallback.reason || ''}`.trim());
        issues.push(...hpaIssues(hpa, hpaError, paused));
        const state = scaleState({hpa, issues, current, min, max, paused});
        return {...baseSummary(so), kind: 'KEDA', name: so.metadata.name, target: refLabel(so.spec.scaleTargetRef), state, min, max, current, desired, triggers,
            crons: soTriggers.filter(t => t.type === 'cron').map(cronWindow), issues, hpaName: hpa ? hpa.metadata.name : null};
    }

    function hpaMetricTrigger(m, metrics) {
        const key = metricKey(m);
        if (!key) return {type: m.type, label: m.type, target: '-', current: '-'};
        const body = metricBody(m);
        const label = m.type === 'Resource' ? body.name
            : m.type === 'ContainerResource' ? `${body.name} (${body.container})`
                : `${m.type.toLowerCase()} ${body.metric.name}`;
        return {type: m.type, label, target: fmtTarget(body.target) || '-', current: fmtMetric(metrics[key])};
    }

    function summarizeHpa(hpa) {
        const spec = hpa.spec || {};
        const min = orNull(spec.minReplicas) === null ? 1 : spec.minReplicas;
        const max = orNull(spec.maxReplicas);
        const {current, desired} = hpaReplicas(hpa);
        const metrics = indexMetrics(hpa.status && hpa.status.currentMetrics, 'current');
        const issues = hpaIssues(hpa);
        const state = scaleState({hpa, issues, current, min, max, paused: false});
        return {...baseSummary(hpa), kind: 'HPA', name: hpa.metadata.name, target: refLabel(spec.scaleTargetRef), state, min, max, current, desired,
            triggers: (spec.metrics || []).map(m => hpaMetricTrigger(m, metrics)), issues, hpaName: hpa.metadata.name};
    }

    function summarizeWorkload(w, scalerError) {
        const replicas = w.spec && w.spec.replicas !== undefined ? w.spec.replicas : 1;
        const ready = (w.status && w.status.readyReplicas) || 0;
        return {...baseSummary(w), kind: w.kind, name: w.metadata.name, target: `${w.kind}/${w.metadata.name}`,
            state: scalerError ? 'unknown' : 'fixed', min: replicas, max: replicas, current: ready, desired: replicas,
            issues: scalerError ? ['Some autoscalers failed to load; this workload may be autoscaled'] : []};
    }

    const errorSummary = (kind, name, message) => ({kind: 'error', namespace: '', name, target: kind ? `${kind}/${name}` : '', state: 'error',
        min: null, max: null, current: null, desired: null, triggers: [], crons: [], issues: [message], hpaName: null});

    const settle = promise => promise.then(live => ({live}), e => ({error: e.message}));

    async function loadScaling(app, tree) {
        const {pairs, plainHpas, workloads} = scalingNodes(tree || await getTree(app));
        const fetchLive = node => settle(getLive(app, node));
        const [soResults, plainResults] = await Promise.all([
            Promise.all(pairs.map(({so, hpa}) => Promise.all([fetchLive(so), hpa ? fetchLive(hpa) : Promise.resolve({})]))),
            Promise.all(plainHpas.map(fetchLive))
        ]);
        const out = [];
        const scaled = new Set();
        let scalerError = false;
        const addTarget = live => {
            const ref = live.spec && live.spec.scaleTargetRef;
            if (ref) scaled.add(refLabel(ref));
        };
        soResults.forEach(([soRes, hpaRes], i) => {
            if (!soRes.live) {
                scalerError = true;
                out.push(errorSummary('ScaledObject', pairs[i].so.name, `ScaledObject fetch failed: ${soRes.error}`));
                return;
            }
            addTarget(soRes.live);
            const summary = summarizeScaledObject(soRes.live, hpaRes.live || null, hpaRes.error);
            out.push({...summary, hpaName: summary.hpaName || (pairs[i].hpa ? pairs[i].hpa.name : null)});
        });
        plainResults.forEach((res, i) => {
            if (!res.live) {
                scalerError = true;
                out.push(errorSummary('HPA', plainHpas[i].name, `HPA fetch failed: ${res.error}`));
                return;
            }
            addTarget(res.live);
            out.push(summarizeHpa(res.live));
        });
        const nodeLabel = n => `${n.kind}/${n.name}`;
        const toFetch = workloads.filter(w => w.kind === 'Rollout' || !scaled.has(nodeLabel(w)));
        const lives = await Promise.all(toFetch.map(fetchLive));
        const workloadRefs = new Set(lives
            .map(r => r.live && r.live.kind === 'Rollout' && r.live.spec && r.live.spec.workloadRef)
            .filter(Boolean)
            .map(refLabel));
        lives.forEach((r, i) => {
            const node = toFetch[i];
            const label = nodeLabel(node);
            if (scaled.has(label) || workloadRefs.has(label)) return;
            out.push(r.live ? summarizeWorkload(r.live, scalerError) : errorSummary(node.kind, node.name, `${label} fetch failed: ${r.error}`));
        });
        return out;
    }

    function summariesFor(summaries, resource) {
        const md = resource.metadata || {};
        const inNs = s => !s.namespace || !md.namespace || s.namespace === md.namespace;
        const matches = {
            ScaledObject: s => (s.kind === 'KEDA' ? s.name === md.name : s.target === `ScaledObject/${md.name}`),
            HorizontalPodAutoscaler: s => s.hpaName === md.name || s.target === `HPA/${md.name}`
        }[resource.kind] || (s => s.target === `${resource.kind}/${md.name}`);
        return summaries.filter(s => matches(s) && inNs(s));
    }

    const labelStyle = {fontSize: '12px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--ext-muted)', marginBottom: '4px'};
    const selectStyle = {minWidth: '240px', height: '34px', padding: '0 36px 0 12px', border: '1px solid var(--ext-border-strong)', borderRadius: '4px', background: "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'><path d='M1 1l5 5 5-5' fill='none' stroke='%236d7f8b' stroke-width='1.6'/></svg>\") no-repeat right 12px center / 12px 8px var(--ext-surface)", color: 'var(--ext-text)', appearance: 'none', WebkitAppearance: 'none', MozAppearance: 'none', fontSize: '14px', cursor: 'pointer'};
    const cellStyle = {padding: '8px 12px', borderBottom: '1px solid var(--ext-border)', fontSize: '13px', verticalAlign: 'top'};
    const tableStyle = {width: '100%', borderCollapse: 'collapse', background: 'var(--ext-surface)', color: 'var(--ext-text)', borderRadius: '4px', boxShadow: '1px 2px 3px var(--ext-shadow)'};

    const stateColor = state => {
        const base = String(state).replace(' !', '');
        return {'at max': '#e96d76', 'at min': '#8fa4b1', scaling: '#18be94', paused: '#766f94', fixed: '#6d7f8b', unknown: '#f4c030', none: '#ccd6dd', error: '#e96d76'}[base] || '#8fa4b1';
    };

    const StateBadge = ({state}) => h('span', {
        style: {display: 'inline-block', padding: '1px 8px', borderRadius: '8px', fontSize: '12px', color: '#fff', background: stateColor(state), whiteSpace: 'nowrap'}
    }, state);

    const UsageBar = ({min, max, current}) => {
        if (current === null || current === undefined || !max) return h('span', null, '-');
        const pct = Math.min(100, Math.round((current / max) * 100));
        const minPct = Math.min(100, Math.round((min / max) * 100));
        const color = pct >= 100 ? '#e96d76' : pct >= 80 ? '#f4c030' : '#18be94';
        return h('div', {title: `${current} / ${max} (${pct}%)`, style: {position: 'relative', width: '140px', height: '10px', background: 'var(--ext-border)', borderRadius: '5px', marginTop: '4px'}},
            h('div', {style: {width: `${pct}%`, height: '100%', background: color, borderRadius: '5px'}}),
            h('div', {style: {position: 'absolute', left: `${minPct}%`, top: '-2px', width: '2px', height: '14px', background: '#6d7f8b'}})
        );
    };

    const fmtCron = c => `${c.start} → ${c.end}${c.timezone ? ` ${c.timezone}` : ''}: ${c.desiredReplicas}`;

    const TriggerList = ({triggers}) => h('div', null, triggers.filter(t => t.type !== 'cron').map((t, i) =>
        h('div', {key: i, style: {whiteSpace: 'nowrap'}}, `${t.label}: `, h('strong', null, t.current), ` / ${t.target}`)));

    const ScalingCard = ({summary}) => {
        if (!summary) return h('div', {style: {color: 'var(--ext-muted)'}}, h('i', {className: 'fa fa-spinner fa-spin'}), ' Loading scaling...');
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
            s.hpaName && h('div', {style: {color: 'var(--ext-muted)', fontSize: '12px', marginTop: '12px'}}, `HPA: ${s.hpaName}`)
        );
    };

    const ScalingTab = ({application, resource, tree}) => {
        const [summaries, setSummaries] = React.useState(null);
        const [error, setError] = React.useState(null);
        const [refresh, setRefresh] = React.useState(0);
        const md = (resource && resource.metadata) || {};
        const treeRef = React.useRef(tree);
        treeRef.current = tree;
        React.useEffect(() => {
            let cancelled = false;
            setError(null);
            setSummaries(null);
            loadScaling(application, treeRef.current)
                .then(list => { if (!cancelled) setSummaries(summariesFor(list, resource)); })
                .catch(e => { if (!cancelled) setError(e.message); });
            return () => { cancelled = true; };
        }, [application && application.metadata.name, resource && resource.kind, md.namespace, md.name, refresh]);
        const body = error ? h('div', {style: {color: '#e96d76'}}, error)
            : !summaries ? h(ScalingCard, {summary: null})
                : !summaries.length ? h('div', {style: {color: 'var(--ext-muted)'}}, 'No autoscaling configured for this resource.')
                    : summaries.map((s, i) => h('div', {key: i, style: {marginBottom: '24px'}},
                        summaries.length > 1 && h('div', {style: labelStyle}, `${s.kind} ${s.name}`),
                        h(ScalingCard, {summary: s})));
        return h('div', {style: {padding: '16px'}},
            h('div', {style: {display: 'flex', justifyContent: 'flex-end', marginBottom: '8px'}},
                h('button', {className: 'argo-button argo-button--base-o', onClick: () => setRefresh(r => r + 1)}, h('i', {className: 'fa fa-redo'}), ' Refresh')),
            body
        );
    };

    const IN_CLUSTER = new Set(['', 'in-cluster', 'https://kubernetes.default.svc']);
    const destCluster = app => {
        const d = (app.spec && app.spec.destination) || {};
        return d.name || d.server || '';
    };
    const nsKey = app => `${destCluster(app)}|${destNs(app)}`;
    const nsKeyLabel = key => {
        const [cluster, ns] = [key.slice(0, key.lastIndexOf('|')), key.slice(key.lastIndexOf('|') + 1)];
        return IN_CLUSTER.has(cluster) ? ns : `${ns} (${cluster})`;
    };
    const readParams = () => new URLSearchParams(window.location.search);
    const writeParams = updates => {
        const params = readParams();
        Object.entries(updates).forEach(([k, v]) => (v ? params.set(k, v) : params.delete(k)));
        const qs = params.toString();
        if (`?${qs}` === window.location.search || (!qs && !window.location.search)) return;
        window.history.replaceState(window.history.state, '', `${window.location.pathname}${qs ? `?${qs}` : ''}`);
    };
    const clusterOfKey = key => key.slice(0, key.lastIndexOf('|'));
    const scopeFromParams = (index, params) => {
        const ns = params.get('namespace');
        if (!ns) return '';
        const cluster = params.get('cluster');
        const keys = Object.keys(index).filter(k => k.slice(k.lastIndexOf('|') + 1) === ns);
        return keys.find(k => (cluster ? clusterOfKey(k) === cluster : IN_CLUSTER.has(clusterOfKey(k)))) || keys[0] || '';
    };
    const scopeParams = key => ({
        namespace: key ? key.slice(key.lastIndexOf('|') + 1) : '',
        cluster: key && !IN_CLUSTER.has(clusterOfKey(key)) ? clusterOfKey(key) : ''
    });
    const appKey = app => `${app.metadata.namespace}/${app.metadata.name}`;
    const NO_SCALING = {kind: 'none', namespace: '', name: '', target: '', state: 'none', min: null, max: null, current: null, desired: null, triggers: [], crons: [], issues: [], hpaName: null};
    const ratio = s => (s && s.state !== 'fixed' && s.max && s.current !== null ? s.current / s.max : -1);
    const isAtMax = s => String(s.state).startsWith('at max');
    const appRatio = list => (list && list.length ? Math.max(...list.map(ratio)) : -1);
    const dash = x => (x === null || x === undefined ? '-' : x);

    const ScalingRows = ({app, list}) => {
        const name = app.metadata.name;
        const entries = list ? (list.length ? list : [NO_SCALING]) : [null];
        return entries.map((s, i) => h('tr', {key: `${appKey(app)}#${i}`},
            h('td', {style: cellStyle},
                h('a', {href: `/applications/${app.metadata.namespace}/${name}`}, name),
                s && s.target && h('div', {style: {color: 'var(--ext-muted)', fontSize: '11px'}}, `${s.kind === 'KEDA' || s.kind === 'HPA' ? `${s.kind} → ` : ''}${s.target}`)),
            h('td', {style: cellStyle}, branchOf(app)),
            h('td', {style: cellStyle}, s ? dash(s.min) : '...'),
            h('td', {style: {...cellStyle, fontWeight: 600}}, s ? dash(s.current) : '...'),
            h('td', {style: cellStyle}, s ? dash(s.desired) : '...'),
            h('td', {style: cellStyle}, s ? dash(s.max) : '...'),
            h('td', {style: cellStyle}, s ? h(UsageBar, {min: s.min, max: s.max, current: s.current}) : ''),
            h('td', {style: {...cellStyle, fontSize: '12px'}}, s ? h(TriggerList, {triggers: s.triggers}) : ''),
            h('td', {style: {...cellStyle, fontSize: '12px', fontFamily: 'monospace'}}, s ? s.crons.map((c, j) => h('div', {key: j, style: {whiteSpace: 'nowrap'}}, fmtCron(c))) : ''),
            h('td', {style: cellStyle, title: s ? s.issues.join('\n') : ''}, s ? h(StateBadge, {state: s.state}) : '')
        ));
    };

    const ScalingPage = () => {
        const [index, setIndex] = React.useState(null);
        const [indexError, setIndexError] = React.useState(null);
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
                    if (!destNs(a)) return;
                    const key = nsKey(a);
                    idx[key] = idx[key] || {};
                    const br = branchOf(a) || '-';
                    idx[key][br] = (idx[key][br] || 0) + 1;
                });
                const params = readParams();
                const scope = scopeFromParams(idx, params);
                const br = params.get('branch');
                setIndex(idx);
                setNamespace(scope);
                setBranch(scope && br && br !== '-' && idx[scope][br] ? br : ALL_BRANCHES);
                setOnlyCapped(!!scope && params.get('capped') === '1');
            }).catch(e => setIndexError(e.message));
        }, []);

        React.useEffect(() => {
            if (index) writeParams({...scopeParams(namespace), branch: branch === ALL_BRANCHES ? '' : branch, capped: onlyCapped ? '1' : ''});
        }, [index, namespace, branch, onlyCapped]);

        const load = async (key, br) => {
            const id = ++loadId.current;
            setSummaries({});
            setError(null);
            if (!key) {
                setLoading(false);
                return;
            }
            setLoading(true);
            try {
                const selector = br && br !== ALL_BRANCHES ? `branch=${br}` : null;
                const items = (await listApps(selector, ['items.metadata.name', 'items.metadata.namespace', 'items.metadata.labels', 'items.spec.destination']))
                    .filter(a => nsKey(a) === key);
                if (id !== loadId.current) return;
                setApps(items);
                await runPool(items, async app => {
                    if (id !== loadId.current) return;
                    const list = await loadScaling(app).catch(e => [errorSummary(null, app.metadata.name, e.message)]);
                    if (id === loadId.current) setSummaries(s => ({...s, [appKey(app)]: list}));
                });
            } catch (e) {
                if (id === loadId.current) setError(e.message);
            } finally {
                if (id === loadId.current) setLoading(false);
            }
        };

        React.useEffect(() => {
            setApps([]);
            load(namespace, branch);
        }, [namespace, branch]);

        const listFor = app => summaries[appKey(app)];
        const rows = apps
            .filter(a => !onlyCapped || (listFor(a) || []).some(isAtMax))
            .sort((a, b) => appRatio(listFor(b)) - appRatio(listFor(a)) || a.metadata.name.localeCompare(b.metadata.name));
        const cappedCount = Object.values(summaries).filter(list => list.some(isAtMax)).length;
        const namespaces = index ? Object.keys(index).sort((a, b) => nsKeyLabel(a).localeCompare(nsKeyLabel(b))) : [];
        const branches = index && namespace ? Object.keys(index[namespace] || {}).sort() : [];

        return h('div', {style: {padding: '24px', maxWidth: '1600px'}},
            (indexError || error) && h('div', {style: {color: '#e96d76', marginBottom: '12px'}}, indexError || error),
            h('div', {style: {display: 'flex', gap: '24px', alignItems: 'flex-end', marginBottom: '20px', flexWrap: 'wrap'}},
                h('div', null,
                    h('div', {style: labelStyle}, 'Namespace'),
                    h('select', {style: selectStyle, value: namespace, disabled: !index, onChange: e => { setNamespace(e.target.value); setBranch(ALL_BRANCHES); }},
                        h('option', {value: ''}, index ? 'Select namespace' : 'Loading...'),
                        namespaces.map(key => h('option', {key, value: key}, nsKeyLabel(key)))
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
                namespace && h('label', {style: {fontSize: '13px', color: 'var(--ext-text)', display: 'flex', alignItems: 'center', gap: '6px'}},
                    h('input', {type: 'checkbox', checked: onlyCapped, onChange: e => setOnlyCapped(e.target.checked)}),
                    `Only at max (${cappedCount})`)
            ),
            namespace && apps.length === 0 && loading && h('div', {style: {color: 'var(--ext-muted)'}}, h('i', {className: 'fa fa-spinner fa-spin'}), ' Loading applications...'),
            rows.length > 0 && h('table', {style: tableStyle},
                h('thead', null, h('tr', null,
                    ['Application', 'Branch', 'Min', 'Current', 'Desired', 'Max', 'Usage', 'Triggers (current / target)', 'Cron windows', 'State'].map(c =>
                        h('th', {key: c, style: {...cellStyle, ...labelStyle, textAlign: 'left'}}, c))
                )),
                h('tbody', null, rows.flatMap(app => ScalingRows({app, list: listFor(app)})))
            )
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

    const registerPage = () => window.extensionsAPI.registerSystemLevelExtension(ScalingPage, 'Scaling', '/scaling', 'fa-expand-arrows-alt fa-fw ext-nav-icon');
    describeSidebarItem('Scaling', 'Replica counts, KEDA min/max and autoscaling triggers for every app in a namespace.');
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
    [['keda.sh', 'ScaledObject'], ['autoscaling', 'HorizontalPodAutoscaler'], ['apps', 'Deployment'], ['apps', 'StatefulSet'], ['argoproj.io', 'Rollout']]
        .forEach(([group, kind]) => window.extensionsAPI.registerResourceExtension(ScalingTab, group, kind, 'Scaling', {icon: 'fa fa-expand-arrows-alt'}));
})(window);
