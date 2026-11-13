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

Merging a change under `resources/` to `main` runs [release.yml](.github/workflows/release.yml), which:

1. Bumps the major version (`v1.0.0` → `v2.0.0`).
2. Packages each `resources/extension-<Name>.js/` directory as `<name>.tar` (kebab-case, e.g. `commit-details.tar`) in the layout `argocd-extension-installer` expects, and publishes them as a GitHub release.
3. Opens a PR on `quizizz/terraform`, assigned to whoever merged, that points every `argocd.yaml` `extensionList` at the new release and adds an entry for any new extension.

Atlantis applies that PR, and argocd-server pods restart with the new extensions. The workflow can also be run by hand from the Actions tab.

It needs a `TERRAFORM_PR_TOKEN` repo secret with contents and pull request write access on `quizizz/terraform`.

Removing an extension directory fails the terraform step until its `extensionList` entry is removed by hand.
