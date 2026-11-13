/**
 * Rollback Extension
 *
 * Adds a "Rollback" button to the top action bar of the Application detail view.
 * Clicking it opens a flyout listing all previous deployments with their commit SHAs
 * and a one-click Rollback button for each entry.
 *
 * Deploy: copy this file to /tmp/extensions/<any-subdir>/extension-rollback.js
 * on the argocd-server pod (filename must match ^extension(.*)\.js$).
 */
((window) => {
    const h = React.createElement;
    if (!document.getElementById('ext-theme-vars')) {
        const themeStyle = document.createElement('style');
        themeStyle.id = 'ext-theme-vars';
        themeStyle.textContent = ':root{--ext-surface:#fff;--ext-surface-2:#f8fbfb;--ext-border:#eff3f5;--ext-border-strong:#dee6eb;--ext-text:#363c4a;--ext-strong:#364150;--ext-muted:#6d7f8b;--ext-selected:#e6f7fc;--ext-shadow:rgba(0,0,0,0.1);--ext-hover:rgba(0,0,0,0.08);--ext-active:rgba(0,0,0,0.15)}.theme-dark{--ext-surface:#303237;--ext-surface-2:#28292a;--ext-border:#495763;--ext-border-strong:#6d7f8b;--ext-text:#fff;--ext-strong:#dee6eb;--ext-muted:#a5b5c0;--ext-selected:#004c67;--ext-shadow:rgba(0,0,0,0.5);--ext-hover:rgba(255,255,255,0.08);--ext-active:rgba(255,255,255,0.15)}';
        document.head.appendChild(themeStyle);
    }

    // Returns the full commit SHA string for a history entry.
    // Handles both single-source (entry.revision) and multi-source (entry.revisions[]).
    function fullRev(entry) {
        if (entry.revisions && entry.revisions.length > 0) {
            return entry.revisions.join(', ');
        }
        return entry.revision || 'unknown';
    }

    function formatDate(iso) {
        if (!iso) return '';
        return new Date(iso).toLocaleString();
    }

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

    const metaKey = (application, id) => `${application.metadata.namespace}/${application.metadata.name}#${id}`;
    const buildMeta = (application, id) => buildCommitCache[metaKey(application, id)];

    async function callRollback(application, id) {
        const appName = application.metadata.name;
        const appNamespace = application.metadata.namespace;

        if (application.spec.syncPolicy && application.spec.syncPolicy.automated) {
            await apiRequest('PATCH', `/api/v1/applications/${encodeURIComponent(appName)}`, {
                name: appName, appNamespace, patchType: 'merge', patch: JSON.stringify({spec: {syncPolicy: {automated: null}}})
            });
        }

        await apiRequest('POST', `/api/v1/applications/${encodeURIComponent(appName)}/rollback`, {id, appNamespace});
    }

    // Confirmation modal — reuses ArgoCD's popup CSS classes for identical look
    const ConfirmModal = ({application, appName, entry, autoSync, isLatest, onConfirm, onCancel}) => {
        const [closeHover, setCloseHover] = React.useState(false);
        const [closeActive, setCloseActive] = React.useState(false);
        const title = h('strong', null, isLatest ? 'Redeploy application' : 'Rollback application');
        const boldName = h('strong', null, appName);
        const meta = buildMeta(application, entry.id);
        const boldCommit = h('strong', null, (meta && meta.commit) || fullRev(entry));
        const baseMessage = isLatest
            ? h('p', null, `Are you sure you want to redeploy application `, boldName, ` to commit `, boldCommit, '?')
            : h('p', null, `Are you sure you want to rollback application `, boldName, ` to commit `, boldCommit, '?');
        const message = h('div', null,
            baseMessage,
            !isLatest && autoSync && h('p', {style: {color: 'var(--ext-muted)', marginTop: '4px'}}, 'Note: Auto-Sync will be disabled.')
        );

        return h(
            'div', {className: 'popup-overlay'},
            h(
                'div', {className: 'popup-container'},
                h('div', {className: 'row popup-container__header popup-container__header__normal'},
                    title,
                    h('i', {
                        className: 'argo-icon-close',
                        onClick: onCancel,
                        onMouseEnter: () => setCloseHover(true),
                        onMouseLeave: () => { setCloseHover(false); setCloseActive(false); },
                        onMouseDown: () => setCloseActive(true),
                        onMouseUp: () => setCloseActive(false),
                        style: {
                            cursor: 'pointer',
                            display: 'inline-flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            width: '28px',
                            height: '28px',
                            borderRadius: '50%',
                            background: closeActive ? 'var(--ext-active)' : closeHover ? 'var(--ext-hover)' : 'transparent',
                            transition: 'background 0.15s',
                            position: 'absolute',
                            right: '12px',
                            top: '16px',
                            fontSize: '16px'
                        }
                    })
                ),
                h('div', {className: 'row popup-container__body'},
                    h('div', {className: 'columns large-12 popup-container__body__hasNoIcon', style: {fontSize: '15px'}},
                        message
                    )
                ),
                h('div', {className: 'row popup-container__footer'},
                    h('div', {style: {display: 'flex', gap: '8px'}},
                        h('button', {className: 'argo-button argo-button--base', onClick: onConfirm}, 'OK'),
                        h('button', {className: 'argo-button argo-button--base-o', onClick: onCancel}, 'Cancel')
                    )
                )
            )
        );
    };

    // Snackbar — auto-dismisses after 4 seconds, with manual close button
    const Snackbar = ({message, type, onClose}) => {
        const bg = type === 'success' ? '#364150' : '#e96d76';
        const icon = type === 'success' ? 'fa-check-circle' : 'fa-times-circle';
        const iconColor = '#fff';
        return h('div', {
            style: {
                position: 'fixed',
                bottom: '32px',
                left: '50%',
                transform: 'translateX(-50%)',
                background: bg,
                color: '#fff',
                border: 'none',
                padding: '16px 32px',
                borderRadius: '10px',
                fontSize: '16px',
                fontWeight: 500,
                display: 'flex',
                alignItems: 'center',
                gap: '12px',
                boxShadow: '0 4px 12px rgba(0,0,0,0.2)',
                zIndex: 20000,
                whiteSpace: 'nowrap'
            }
        },
        h('i', {className: `fa ${icon}`, style: {color: iconColor}}),
        message,
        h('i', {
            className: 'fa fa-times',
            onClick: onClose,
            style: {cursor: 'pointer', marginLeft: '8px', opacity: 0.7}
        })
        );
    };

    // Flyout panel — lists deployment history with rollback buttons
    const RollbackFlyout = ({application}) => {
        const [rolling, setRolling] = React.useState(null);
        const [snackbar, setSnackbar] = React.useState(null); // {message, type}
        const [confirmEntry, setConfirmEntry] = React.useState(null);
        const [metaLoading, setMetaLoading] = React.useState(true);
        React.useEffect(() => {
            prefetchBuildCommits(application).then(() => setMetaLoading(false));
        }, []);

        const showSnackbar = (message, type) => {
            setSnackbar({message, type});
            setTimeout(() => setSnackbar(null), 4000);
        };

        const appName = application.metadata.name;
        const appNamespace = application.metadata.namespace;
        const autoSync = !!(application.spec.syncPolicy && application.spec.syncPolicy.automated);
        const history = (application.status.history || []).slice().reverse();


        const doRollback = async (entry) => {
            setConfirmEntry(null);
            setRolling(entry.id);
            try {
                await callRollback(application, entry.id);
                showSnackbar(`Rollback triggered for ${fullRev(entry)}.`, 'success');
            } catch (e) {
                showSnackbar(e.message, 'error');
            } finally {
                setRolling(null);
            }
        };

        return h(
            'div',
            {style: {padding: '20px'}},

            confirmEntry && h(ConfirmModal, {
                application,
                appName,
                entry: confirmEntry,
                autoSync,
                isLatest: history[0]?.id === confirmEntry.id,
                onConfirm: () => doRollback(confirmEntry),
                onCancel: () => setConfirmEntry(null)
            }),

            h('h3', {style: {margin: '0 0 16px', fontSize: '20px', fontWeight: 600}}, 'Deployment History'),

            h('div', {style: {marginBottom: '12px'}},
                h('span', {
                    style: {
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '6px',
                        background: '#6d7f8b',
                        color: '#fff',
                        fontSize: '12px',
                        fontWeight: 500,
                        padding: '4px 12px',
                        borderRadius: '10px'
                    }
                },
                h('i', {className: 'fa fa-info-circle'}),
                autoSync ? 'Auto-Sync is enabled. Rolling back will disable it.' : 'Auto-Sync is disabled.'
            )),

            snackbar && h(Snackbar, {message: snackbar.message, type: snackbar.type, onClose: () => setSnackbar(null)}),

            metaLoading
                ? h('div', {style: {height: 'calc(100vh - 160px)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '12px', color: 'var(--ext-muted)'}},
                    h('i', {className: 'fa fa-spinner fa-spin', style: {fontSize: '24px'}}),
                    h('span', {style: {fontSize: '13px'}}, 'Loading deployment history...')
                  )
            : history.length === 0
                ? h('div', {style: {color: 'var(--ext-muted)', fontSize: '14px'}}, 'No deployment history available.')
                : h('div', {className: 'application-deployment-history'},
                    history.map((entry, i) => {
                        const isLatest = i === 0;
                        const rev = fullRev(entry);
                        const isRolling = rolling === entry.id;

                        const meta = buildMeta(application, entry.id);
                        const buildCommit = (meta && meta.commit) || rev;
                        const slackUser = meta && meta.slackUsername;

                        return h('div', {key: entry.id, className: 'row application-deployment-history__item'},
                            // Left: date only
                            h('div', {className: 'columns small-3'},
                                h('div', null,
                                    h('i', {className: 'fa fa-clock'}), ' Deployed At:',
                                    h('br'),
                                    formatDate(entry.deployedAt)
                                )
                            ),
                            // Right: commit SHA + meta + current badge + button
                            h('div', {className: 'columns small-9'},
                                h('div', {style: {display: 'flex', alignItems: 'center', justifyContent: 'space-between'}},
                                    h('div', {style: {flex: 1, minWidth: 0}},
                                        h('div', {style: {display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '2px'}},
                                            h('span', {style: {fontSize: '13px', fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--ext-strong)', width: '70px', flexShrink: 0}}, 'Commit:'),
                                            buildCommit && h('span', {style: {fontSize: '14px', fontWeight: 500, color: 'var(--ext-strong)'}}, buildCommit),
                                            isLatest && h('span', {
                                                style: {
                                                    fontSize: '10px',
                                                    fontWeight: 500,
                                                    background: 'rgba(24,190,148,0.12)',
                                                    color: '#18be94',
                                                    padding: '1px 6px',
                                                    borderRadius: '6px',
                                                    whiteSpace: 'nowrap',
                                                    border: '1px solid rgba(24,190,148,0.3)'
                                                }
                                            }, 'current')
                                        ),
                                        h('div', {style: {display: 'flex', alignItems: 'center', gap: '6px'}},
                                            h('span', {style: {fontSize: '13px', fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--ext-strong)', width: '70px', flexShrink: 0}}, 'User:'),
                                            slackUser && h('span', {style: {fontSize: '14px', fontWeight: 500, color: 'var(--ext-strong)'}}, slackUser)
                                        )
                                    ),
                                    h('button', {
                                        className: 'argo-button argo-button--base-o',
                                        disabled: rolling !== null,
                                        style: {marginLeft: '12px', flexShrink: 0},
                                        onClick: e => { e.stopPropagation(); setConfirmEntry(entry); }
                                    }, isRolling ? 'Processing...' : isLatest ? 'Redeploy' : 'Rollback')
                                )
                            )
                        );
                    })
                )
        );
    };

    const buildCommitCache = {};

    async function prefetchBuildCommits(application) {
        const appName = application.metadata.name;
        const history = (application.status.history || []).slice();
        const uncached = history.filter(e => buildMeta(application, e.id) === undefined);
        if (uncached.length === 0) return;

        // Deduplicate by first revision — same revision means same values, no need to call twice.
        const seen = {};
        const unique = [];
        for (const entry of uncached) {
            const isMultiSource = entry.sources && entry.sources.length > 0;
            const rev = isMultiSource ? (entry.revisions || [])[0] : entry.revision;
            const key = rev || entry.id;
            if (seen[key]) {
                seen[key].push(entry.id);
            } else {
                seen[key] = [entry.id];
                unique.push(entry);
            }
        }

        await Promise.all(unique.map(async (entry) => {
            const isMultiSource = entry.sources && entry.sources.length > 0;
            const sources = isMultiSource ? entry.sources : [entry.source];
            const revisions = isMultiSource ? entry.revisions : [entry.revision];
            const isMultiSrcKey = isMultiSource ? (entry.revisions || [])[0] : entry.revision;
            const key = isMultiSrcKey || entry.id;
            const ids = seen[key] || [entry.id];

            let failed = false;
            for (let i = 0; i < sources.length; i++) {
                const source = sources[i];
                if (!source || !source.repoURL) continue;
                try {
                    const data = await apiRequest('POST',
                        `/api/v1/repositories/${encodeURIComponent(source.repoURL)}/appdetails`,
                        {source: {...source, targetRevision: revisions[i]}, appName, appProject: application.spec.project, sourceIndex: i, versionId: entry.id}
                    );
                    const params = data.helm && data.helm.parameters;
                    const commit = params && params.find(p => p.name === 'build.commit');
                    const slack = params && params.find(p => p.name === 'build.slackUsername');
                    if (commit) {
                        ids.forEach(id => { buildCommitCache[metaKey(application, id)] = {commit: commit.value, slackUsername: slack ? slack.value : null}; });
                        return;
                    }
                } catch (_) {
                    failed = true;
                }
            }
            if (!failed) ids.forEach(id => { buildCommitCache[metaKey(application, id)] = null; });
        }));
    }

    // Toolbar button — pre-fetches build commits as soon as the app page loads.
    const ToolbarButton = ({application}) => {
        React.useEffect(() => { prefetchBuildCommits(application); }, []);
        return React.createElement(React.Fragment, null, 'Rollback');
    };

    window.extensionsAPI.registerTopBarActionMenuExt(
        ToolbarButton,   // component shown in the top action bar
        'Rollback',      // title
        'rollback_ext',  // unique id
        RollbackFlyout,  // flyout component
        () => true,      // shouldDisplay: show for all apps
        'fa fa-step-backward',    // Font Awesome icon class
        false            // isMiddle
    );

    // Rename "History and rollback" button to "History" via DOM mutation.
    const renameHistoryButton = () => {
        document.querySelectorAll('span').forEach(el => {
            if (el.textContent.trim() === 'History and rollback') {
                el.textContent = 'History';
            }
        });
    };
    const observer = new MutationObserver(renameHistoryButton);
    observer.observe(document.body, {childList: true, subtree: true});
    renameHistoryButton();
})(window);
