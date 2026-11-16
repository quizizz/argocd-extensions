# argocd-extensions

Custom UI extensions for ArgoCD.

## Extensions

| Extension | Description |
|-----------|-------------|
| [Rollback](resources/extension-Rollback.js/extensions-Rollback.js) | Adds a Rollback button to the application top bar with a deployment history flyout showing commit, deployer, and one-click rollback |
| [BulkOps](resources/extension-BulkOps.js/extensions-BulkOps.js) | Adds a "Bulk Sync" sidebar page: pick a destination namespace (and optionally a `branch` label; otherwise each branch gets its own collapsible section), then sync all matching apps (optionally re-enabling auto-sync), restart all their Deployments and Argo Rollouts, or roll them all back to a chosen `build.commit` |
| [CommitDetails](resources/extension-CommitDetails.js/extensions-CommitDetails.js) | Replaces the launchpad Author/Comment in SYNC STATUS and LAST SYNC panels with actual service commit SHA and slackUsername from _live_build.yml |
| [Pinned](resources/extension-Pinned.js/extensions-Pinned.js) | Pinned page: pin namespaces or individual apps for a quick view of their sync, health, branch, auto-sync and last sync. Pins are stored in browser localStorage only |
| [Scaling](resources/extension-Scaling.js/extensions-Scaling.js) | Read-only Scaling page (per namespace/branch) and a ScaledObject tab showing KEDA min/max/current/desired replicas, trigger metrics vs targets, cron windows, and which apps are capped at max |

---

## Local Development

Copy `webpack.config.js` from this repo into the ArgoCD UI source directory to test extensions locally without touching the cluster.

```bash
cp dev/webpack.config.js <path-to-argo-cd>/ui/src/app/webpack.config.js
```

Then start the dev server:

```bash
cd <path-to-argo-cd>/ui
ARGOCD_API_URL=https://<your-argocd-host> \
EXTENSIONS_DIR=<path-to-argocd-extensions>/resources \
yarn start
```

Open **http://localhost:4000**. Any changes to files under `resources/` are picked up on browser refresh — no cluster deployment needed.

---

## Releasing

Each extension is released as its own tar file. The structure mirrors the layout expected by `argocd-extension-installer`.

### Rollback

```bash
tar -cf rollback.tar resources/extension-Rollback.js/
```

### BulkOps

```bash
tar -cf bulk-ops.tar resources/extension-BulkOps.js/
```

### CommitDetails

```bash
tar -cf commit-details.tar resources/extension-CommitDetails.js/
```

### Pinned

```bash
tar -cf pinned.tar resources/extension-Pinned.js/
### Scaling

```bash
tar -cf scaling.tar resources/extension-Scaling.js/
```

Verify before uploading:

```bash
tar -tvf commit-details.tar
# resources/extension-CommitDetails.js/
# resources/extension-CommitDetails.js/extensions-CommitDetails.js
```

Upload the tar as a GitHub release asset, then add an entry to `extensionList` in `argocd.yaml`:

```yaml
- name: commit-details-extension
  env:
    - name: EXTENSION_URL
      value: https://github.com/quizizz/argocd-extensions/releases/download/v{version}/commit-details.tar
```

Then restart the ArgoCD server to pick up the new extension:

```bash
kubectl rollout restart deployment/argocd-server -n argocd
```
