# argocd-extensions

Custom UI extensions for ArgoCD.

## Extensions

| Extension | Description |
|-----------|-------------|
| [Rollback](resources/extension-Rollback.js/extensions-Rollback.js) | Adds a Rollback button to the application top bar with a deployment history flyout showing commit, deployer, and one-click rollback |
| [CommitDetails](resources/extension-CommitDetails.js/extensions-CommitDetails.js) | Replaces the launchpad Author/Comment in SYNC STATUS and LAST SYNC panels with actual service commit SHA and slackUsername from _live_build.yml |

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

### CommitDetails

```bash
tar -cf commit-details.tar resources/extension-CommitDetails.js/
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
