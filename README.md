# argocd-extensions

Custom UI extensions for ArgoCD.

## Extensions

| Extension | Description |
|-----------|-------------|
| [Rollback](extensions/extension-Rollback.js) | Adds a Rollback button to the application top bar with a deployment history flyout showing commit, deployer, and one-click rollback |

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
EXTENSIONS_DIR=<path-to-argocd-extensions>/extensions \
yarn start
```

Open **http://localhost:4000**. Any changes to files under `extensions/` are picked up on browser refresh — no cluster deployment needed.
