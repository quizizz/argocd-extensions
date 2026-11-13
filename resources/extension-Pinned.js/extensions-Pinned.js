((window) => {
    const h = React.createElement;
    if (!document.getElementById('ext-theme-vars')) {
        const themeStyle = document.createElement('style');
        themeStyle.id = 'ext-theme-vars';
        themeStyle.textContent = ':root{--ext-surface:#fff;--ext-surface-2:#f8fbfb;--ext-border:#eff3f5;--ext-border-strong:#dee6eb;--ext-text:#363c4a;--ext-strong:#364150;--ext-muted:#6d7f8b;--ext-selected:#e6f7fc;--ext-shadow:rgba(0,0,0,0.1);--ext-hover:rgba(0,0,0,0.08);--ext-active:rgba(0,0,0,0.15)}.theme-dark{--ext-surface:#303237;--ext-surface-2:#28292a;--ext-border:#495763;--ext-border-strong:#6d7f8b;--ext-text:#fff;--ext-strong:#dee6eb;--ext-muted:#a5b5c0;--ext-selected:#004c67;--ext-shadow:rgba(0,0,0,0.5);--ext-hover:rgba(255,255,255,0.08);--ext-active:rgba(255,255,255,0.15)}';
        document.head.appendChild(themeStyle);
    }
    const STORE_KEY = 'argocd-ext.pinned.v1';
    const REFRESH_MS = 30000;
    const REQUEST_TIMEOUT_MS = 20000;
    const APP_FIELDS = [
        'items.metadata.name', 'items.metadata.namespace', 'items.metadata.labels', 'items.spec.destination', 'items.spec.syncPolicy',
        'items.status.sync.status', 'items.status.health', 'items.status.operationState.phase', 'items.status.operationState.finishedAt'
    ];

    async function apiRequest(method, path) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        try {
            const resp = await fetch(path, {method, headers: {'Content-Type': 'application/json'}, signal: controller.signal});
            if (!resp.ok) {
                const data = await resp.json().catch(() => ({}));
                throw new Error(data.message || `Request failed: ${resp.status} ${resp.statusText}`);
            }
            return await resp.json().catch(() => ({}));
        } catch (e) {
            if (e.name === 'AbortError') throw new Error(`Request timed out after ${REQUEST_TIMEOUT_MS / 1000}s`);
            throw e;
        } finally {
            clearTimeout(timer);
        }
    }

    async function listApps() {
        const data = await apiRequest('GET', `/api/v1/applications?${new URLSearchParams({fields: APP_FIELDS.join(',')})}`);
        return data.items || [];
    }

    const appKey = app => `${app.metadata.namespace}/${app.metadata.name}`;
    const destNs = app => (app.spec && app.spec.destination && app.spec.destination.namespace) || '';
    const branchOf = app => (app.metadata.labels && app.metadata.labels.branch) || '';
    const pageHref = (path, ns, br) => `${path}?${new URLSearchParams(br ? {namespace: ns, branch: br} : {namespace: ns})}`;
    const bulkOpsHref = (ns, br) => pageHref('/bulk-sync', ns, br);
    const scalingHref = (ns, br) => pageHref('/scaling', ns, br);
    const isAutoSync = app => !!(app.spec && app.spec.syncPolicy && app.spec.syncPolicy.automated);
    const syncStatus = app => app.status && app.status.sync && app.status.sync.status;
    const healthStatus = app => app.status && app.status.health && app.status.health.status;
    const lastSync = app => app.status && app.status.operationState && app.status.operationState.finishedAt;

    const emptyPins = () => ({apps: [], namespaces: [], collapsed: {}});

    function readPins() {
        try {
            const v = JSON.parse(window.localStorage.getItem(STORE_KEY) || '{}');
            return {
                apps: Array.isArray(v.apps) ? v.apps : [],
                namespaces: Array.isArray(v.namespaces) ? v.namespaces : [],
                collapsed: v.collapsed && typeof v.collapsed === 'object' ? v.collapsed : {}
            };
        } catch (_) {
            return emptyPins();
        }
    }

    function writePins(pins) {
        try {
            window.localStorage.setItem(STORE_KEY, JSON.stringify(pins));
        } catch (_) {}
    }

    function ago(ts) {
        if (!ts) return '-';
        const s = Math.max(0, Math.floor((Date.now() - new Date(ts).getTime()) / 1000));
        if (s < 60) return 'just now';
        if (s < 3600) return `${Math.floor(s / 60)}m ago`;
        if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
        return `${Math.floor(s / 86400)}d ago`;
    }

    const labelStyle = {fontSize: '12px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--ext-muted)', marginBottom: '4px'};
    const fieldStyle = {height: '34px', border: '1px solid var(--ext-border-strong)', borderRadius: '4px', background: 'var(--ext-surface)', color: 'var(--ext-text)', fontSize: '14px', boxSizing: 'border-box'};
    const selectStyle = {...fieldStyle, width: '160px', padding: '0 36px 0 12px', background: "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'><path d='M1 1l5 5 5-5' fill='none' stroke='%236d7f8b' stroke-width='1.6'/></svg>\") no-repeat right 12px center / 12px 8px var(--ext-surface)", color: 'var(--ext-text)', appearance: 'none', WebkitAppearance: 'none', MozAppearance: 'none', cursor: 'pointer'};
    const inputStyle = {...fieldStyle, width: '360px', maxWidth: '100%', padding: '0 12px'};
    const cellStyle = {padding: '8px 12px', borderBottom: '1px solid var(--ext-border)', fontSize: '13px', verticalAlign: 'middle', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'};
    const tableStyle = {width: '100%', minWidth: '760px', tableLayout: 'fixed', borderCollapse: 'collapse', background: 'var(--ext-surface)', color: 'var(--ext-text)'};
    const cardStyle = {background: 'var(--ext-surface)', color: 'var(--ext-text)', borderRadius: '4px', boxShadow: '1px 2px 3px var(--ext-shadow)', marginBottom: '16px', overflow: 'hidden'};
    const sectionTitleStyle = {...labelStyle, fontSize: '13px', margin: '24px 0 8px'};
    const iconButtonStyle = {background: 'none', border: 'none', padding: '4px 6px', cursor: 'pointer', fontSize: '14px', lineHeight: 1};

    const statusColor = {
        Synced: '#18be94', OutOfSync: '#f4c030', Healthy: '#18be94', Progressing: '#0dadea',
        Degraded: '#e96d76', Missing: '#f4c030', Suspended: '#766f94', Unknown: '#ccd6dd', 'not found': '#e96d76'
    };

    const Badge = ({text, color}) => h('span', {
        style: {display: 'inline-block', padding: '1px 8px', borderRadius: '8px', fontSize: '12px', color: '#fff', background: color || statusColor[text] || '#8fa4b1'}
    }, text || '-');

    const PinButton = ({pinned, onClick, label}) => h('button', {
        style: {...iconButtonStyle, color: pinned ? '#0dadea' : '#ccd6dd'},
        title: pinned ? `Unpin ${label}` : `Pin ${label}`,
        onClick
    }, h('i', {className: 'fa fa-thumbtack'}));

    const PageLinks = ({ns, br}) => h('span', {style: {display: 'inline-flex', gap: '2px'}},
        h('a', {href: bulkOpsHref(ns, br), title: 'Open in Bulk Sync', style: {...iconButtonStyle, color: 'var(--ext-muted)'}}, h('i', {className: 'fa fa-fw fa-layer-group'})),
        h('a', {href: scalingHref(ns, br), title: 'Open in Scaling', style: {...iconButtonStyle, color: 'var(--ext-muted)'}}, h('i', {className: 'fa fa-fw fa-expand-arrows-alt'})));

    const AppTable = ({rows, showNamespace, pinnedApps, onToggleApp}) => {
        const columns = [
            {label: '', width: '40px'}, {label: 'Application', width: '32%'},
            showNamespace && {label: 'Namespace', width: '16%'},
            {label: 'Branch', width: '14%'}, {label: 'Sync', width: '110px'}, {label: 'Health', width: '120px'},
            {label: 'Auto-sync', width: '90px'}, {label: 'Last sync', width: '110px'}, {label: '', width: '84px'}
        ].filter(Boolean);
        return h('div', {style: {overflowX: 'auto'}},
            h('table', {style: tableStyle},
                h('colgroup', null, columns.map((c, i) => h('col', {key: i, style: {width: c.width}}))),
                h('thead', null, h('tr', null, columns.map((c, i) => h('th', {key: i, style: {...cellStyle, ...labelStyle, textAlign: 'left'}}, c.label)))),
                h('tbody', null, rows.map(row => {
                    const app = row.app;
                    const ns = app ? destNs(app) : '';
                    const br = app ? branchOf(app) : '';
                    return h('tr', {key: row.key},
                        h('td', {style: {...cellStyle, padding: '4px 6px'}}, h(PinButton, {pinned: pinnedApps.has(row.key), label: row.name, onClick: () => onToggleApp(row.key)})),
                        h('td', {style: cellStyle, title: row.name}, app ? h('a', {href: `/applications/${app.metadata.namespace}/${app.metadata.name}`}, row.name) : row.name),
                        showNamespace && h('td', {style: cellStyle, title: ns}, ns ? h('a', {href: bulkOpsHref(ns), title: `Open ${ns} in Bulk Sync`}, ns) : '-'),
                        h('td', {style: cellStyle, title: br}, ns && br ? h('a', {href: bulkOpsHref(ns, br), title: `Open ${ns} / ${br} in Bulk Sync`}, br) : br || '-'),
                        h('td', {style: cellStyle}, h(Badge, {text: app ? syncStatus(app) : 'not found'})),
                        h('td', {style: cellStyle}, app ? h(Badge, {text: healthStatus(app)}) : ''),
                        h('td', {style: cellStyle}, app ? (isAutoSync(app) ? 'on' : 'off') : ''),
                        h('td', {style: cellStyle, title: app && lastSync(app) ? new Date(lastSync(app)).toLocaleString() : ''}, app ? ago(lastSync(app)) : ''),
                        h('td', {style: {...cellStyle, padding: '4px 6px', textAlign: 'right'}}, ns && h(PageLinks, {ns, br}))
                    );
                }))
            )
        );
    };

    const summarize = apps => {
        const counts = {};
        const bump = (label, status) => { counts[label] = counts[label] || {n: 0, status}; counts[label].n++; };
        apps.forEach(a => {
            const s = syncStatus(a) || 'Unknown';
            const hs = healthStatus(a) || 'Unknown';
            if (s !== 'Synced') bump(s === 'Unknown' ? 'sync Unknown' : s, s);
            if (hs !== 'Healthy') bump(hs === 'Unknown' ? 'health Unknown' : hs, hs);
        });
        return Object.entries(counts);
    };

    const PinnedPage = () => {
        const [pins, setPins] = React.useState(readPins);
        const [apps, setApps] = React.useState(null);
        const [error, setError] = React.useState(null);
        const [loadedAt, setLoadedAt] = React.useState(null);
        const [loading, setLoading] = React.useState(false);
        const [kind, setKind] = React.useState('namespace');
        const [query, setQuery] = React.useState('');
        const loadId = React.useRef(0);
        const inFlight = React.useRef(false);

        const load = async () => {
            const id = ++loadId.current;
            inFlight.current = true;
            setLoading(true);
            try {
                const items = await listApps();
                if (id !== loadId.current) return;
                setApps(items.sort((a, b) => branchOf(a).localeCompare(branchOf(b)) || a.metadata.name.localeCompare(b.metadata.name)));
                setLoadedAt(new Date().toISOString());
                setError(null);
            } catch (e) {
                if (id === loadId.current) setError(e.message);
            } finally {
                if (id === loadId.current) {
                    inFlight.current = false;
                    setLoading(false);
                }
            }
        };

        React.useEffect(() => {
            load();
            const timer = setInterval(() => { if (!inFlight.current) load(); }, REFRESH_MS);
            const onStorage = e => { if (e.key === STORE_KEY) setPins(readPins()); };
            window.addEventListener('storage', onStorage);
            return () => {
                loadId.current++;
                clearInterval(timer);
                window.removeEventListener('storage', onStorage);
            };
        }, []);

        const update = fn => setPins(prev => {
            const next = fn(prev);
            writePins(next);
            return next;
        });
        const toggleIn = (list, value) => (list.includes(value) ? list.filter(v => v !== value) : [...list, value]);
        const toggleApp = key => update(p => ({...p, apps: toggleIn(p.apps, key)}));
        const toggleNamespace = ns => update(p => ({...p, namespaces: toggleIn(p.namespaces, ns)}));
        const toggleCollapsed = ns => update(p => ({...p, collapsed: {...p.collapsed, [ns]: !p.collapsed[ns]}}));

        const all = apps || [];
        const byKey = {};
        const byNs = {};
        all.forEach(a => {
            byKey[appKey(a)] = a;
            (byNs[destNs(a)] = byNs[destNs(a)] || []).push(a);
        });
        const namespaceOptions = Object.keys(byNs).filter(Boolean).sort();
        const appOptions = all.map(appKey).sort();
        const options = kind === 'namespace' ? namespaceOptions : appOptions;
        const normalized = kind === 'application' && query && !query.includes('/') ? appOptions.find(k => k.endsWith(`/${query}`)) || query : query;
        const canPin = options.includes(normalized) && !(kind === 'namespace' ? pins.namespaces : pins.apps).includes(normalized);
        const pinnedApps = new Set(pins.apps);

        const submit = () => {
            if (!canPin) return;
            if (kind === 'namespace') toggleNamespace(normalized);
            else toggleApp(normalized);
            setQuery('');
        };

        const appRows = pins.apps.map(key => ({key, name: key.split('/').slice(1).join('/'), app: byKey[key]}));
        const nothingPinned = pins.apps.length === 0 && pins.namespaces.length === 0;

        return h('div', {style: {padding: '24px 16px 56px', maxWidth: '1400px', boxSizing: 'border-box'}},
            error && h('div', {style: {color: '#e96d76', marginBottom: '12px'}},
                apps ? `Refresh failed, showing data from ${ago(loadedAt)}: ${error}` : error),
            h('div', {style: {display: 'flex', gap: '12px', alignItems: 'flex-end', flexWrap: 'wrap'}},
                h('div', null,
                    h('div', {style: labelStyle}, 'Pin a'),
                    h('select', {style: selectStyle, value: kind, onChange: e => { setKind(e.target.value); setQuery(''); }},
                        h('option', {value: 'namespace'}, 'Namespace'),
                        h('option', {value: 'application'}, 'Application')
                    )
                ),
                h('div', {style: {maxWidth: '100%'}},
                    h('div', {style: labelStyle}, kind === 'namespace' ? 'Namespace' : 'Application'),
                    h('input', {
                        style: inputStyle, list: 'pinned-ext-options', value: query,
                        placeholder: apps ? `Search ${options.length} ${kind === 'namespace' ? 'namespaces' : 'applications'}` : 'Loading...',
                        onChange: e => setQuery(e.target.value),
                        onKeyDown: e => { if (e.key === 'Enter') submit(); }
                    }),
                    h('datalist', {id: 'pinned-ext-options'}, options.map(o => h('option', {key: o, value: o})))
                ),
                h('button', {className: 'argo-button argo-button--base', style: {whiteSpace: 'nowrap'}, disabled: !canPin, onClick: submit},
                    h('i', {className: 'fa fa-thumbtack'}), ' Pin'),
                h('button', {className: 'argo-button argo-button--base-o', style: {whiteSpace: 'nowrap', marginLeft: 'auto'}, disabled: loading, onClick: load},
                    h('i', {className: loading ? 'fa fa-spinner fa-spin' : 'fa fa-redo'}), ' Refresh')
            ),

            apps === null && !error && h('div', {style: {color: 'var(--ext-muted)', marginTop: '20px'}}, h('i', {className: 'fa fa-spinner fa-spin'}), ' Loading applications...'),
            apps && nothingPinned && h('div', {style: {color: 'var(--ext-muted)', marginTop: '24px', fontSize: '14px'}}, 'Nothing pinned yet. Pin a namespace or an application above.'),

            apps && pins.namespaces.length > 0 && h('div', null,
                h('div', {style: sectionTitleStyle}, 'Namespaces'),
                pins.namespaces.map(ns => {
                    const nsApps = byNs[ns] || [];
                    const collapsed = !!pins.collapsed[ns];
                    return h('div', {key: ns, style: cardStyle},
                        h('div', {style: {display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 12px', cursor: 'pointer', userSelect: 'none', borderBottom: collapsed ? 'none' : '1px solid var(--ext-border)'}, onClick: () => toggleCollapsed(ns)},
                            h('i', {className: `fa fa-fw fa-chevron-${collapsed ? 'right' : 'down'}`, style: {color: 'var(--ext-muted)'}}),
                            h('strong', null, ns),
                            h('span', {style: {color: 'var(--ext-muted)', fontSize: '13px'}}, nsApps.length ? `${nsApps.length} app${nsApps.length === 1 ? '' : 's'}` : 'no apps found'),
                            summarize(nsApps).map(([label, {n, status}]) => h('span', {key: label, style: {fontSize: '12px'}}, h(Badge, {text: `${n} ${label}`, color: statusColor[status]}))),
                            h('span', {style: {marginLeft: 'auto'}, onClick: e => e.stopPropagation()},
                                h('a', {href: `/applications?namespace=${encodeURIComponent(ns)}`, style: {fontSize: '13px', marginRight: '12px'}}, 'Open in list'),
                                h('a', {href: bulkOpsHref(ns), style: {fontSize: '13px', marginRight: '12px'}}, 'Bulk Sync'),
                                h('a', {href: scalingHref(ns), style: {fontSize: '13px', marginRight: '8px'}}, 'Scaling'),
                                h(PinButton, {pinned: true, label: ns, onClick: () => toggleNamespace(ns)}))
                        ),
                        !collapsed && nsApps.length > 0 && h(AppTable, {
                            rows: nsApps.map(a => ({key: appKey(a), name: a.metadata.name, app: a})),
                            showNamespace: false, pinnedApps, onToggleApp: toggleApp
                        })
                    );
                })
            ),

            apps && appRows.length > 0 && h('div', null,
                h('div', {style: sectionTitleStyle}, 'Applications'),
                h('div', {style: cardStyle}, h(AppTable, {rows: appRows, showNamespace: true, pinnedApps, onToggleApp: toggleApp}))
            ),

            h('div', {style: {position: 'fixed', right: '16px', bottom: '12px', zIndex: 10, fontSize: '12px', color: 'var(--ext-muted)', background: 'var(--ext-surface)', border: '1px solid var(--ext-border)', borderRadius: '4px', padding: '4px 10px', boxShadow: '0 1px 2px var(--ext-shadow)'}},
                h('i', {className: 'fa fa-info-circle'}), ' Pins are stored in this browser only, not synced to other devices or users.')
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

    const registerPage = () => window.extensionsAPI.registerSystemLevelExtension(PinnedPage, 'Pinned', '/pinned', 'fa-thumbtack fa-fw ext-nav-icon');
    describeSidebarItem('Pinned', 'Quick view of the namespaces and apps you pinned, with live sync and health. Saved in this browser.');
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
