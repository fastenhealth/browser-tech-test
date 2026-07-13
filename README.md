# Browser technology context test

An Angular test bench for comparing browser capabilities in the top-level page
and in an iframe. Each context runs the same three probes and reports its result
independently:

- **WebSocket** opens Postman's public
  [`wss://ws.postman-echo.com/raw`](https://learning.postman.com/docs/developer/echo-api)
  endpoint, sends a unique value, and verifies the echoed response.
- **Partitioned cookie** writes, reads, and removes a short-lived secure cookie
  with `SameSite=None` and `Partitioned`.
- **Local storage** writes, reads, and removes a unique `localStorage` value.

The WebSocket probe depends on a third-party service. A timeout or network
policy can therefore produce a failure even when the browser implements the
[WebSocket API](https://developer.mozilla.org/en-US/docs/Web/API/WebSockets_API).

## Run locally

Use Node.js 24 and the npm version recorded in `package.json`.

```bash
npm ci
npm start
```

Open <http://localhost:4200/>. The default iframe loads another copy of the
same application.

Run the unit tests once:

```bash
npm test -- --watch=false
```

Run a production build with a relative base URL:

```bash
npm run build -- --configuration production --base-href ./
```

The deployable files are written to `dist/browser-tech-test/browser/`. The
relative base URL lets the same artifact work below different GitHub Pages
project paths.

## Choose the iframe origin

By default, the iframe uses the current deployment. Override it with an
absolute URL in the `frame` query parameter. URL-encode the value when building
the link:

```text
https://fastenhealth.github.io/browser-tech-test/?frame=https%3A%2F%2Fsecond-owner.github.io%2Fbrowser-tech-test%2F
```

The target should host the same built artifact so it can run the frame view and
return the expected result messages.

When the configured iframe has a different origin, starting a run opens that
deployment briefly as a first-party control. The control seeds a short-lived
partitioned cookie and a namespaced local-storage value, then the iframe checks
whether those seeds are shared or isolated. The control removes both values and
closes after the run. If the browser blocks the control window, the app still
runs basic read/write probes and reports the partition comparison as
inconclusive.

### Partitioned-cookie limitation

The default parent and iframe both run at
`fastenhealth.github.io/browser-tech-test/`. They have the same scheme, host,
and port, so they are the same origin. Deploying another project site under the
same GitHub owner only changes the path and is still the same origin. In that
configuration, the cookie probe checks whether the cookie can make a basic
round trip and reports that the same-origin bucket is shared; it cannot
demonstrate that the browser isolates the cookie by top-level site.

A definitive third-party partition test requires the frame artifact on a
second, cross-site Pages owner, such as `second-owner.github.io`, or on an
unrelated custom domain. Point `?frame=` at that deployment. This distinction
matters because [CHIPS cookies are keyed by both their host and the top-level
site](https://developer.mozilla.org/en-US/docs/Web/Privacy/Guides/Third-party_cookies/Partitioned_cookies),
and `github.io` is a
[public suffix](https://web.dev/articles/url-parts#effective_top-level_domain_etld),
making different owner hostnames different sites.

Browser privacy settings can deny cookies or storage independently. A failed
probe is therefore a result for the current browser, settings, and context, not
a general compatibility verdict. `localStorage` is also
[scoped to the document origin](https://developer.mozilla.org/en-US/docs/Web/API/Window/localStorage).

## Deploy to GitHub Pages

The workflow at `.github/workflows/deploy-pages.yml` installs locked
dependencies, runs the tests once, creates the production build, uploads only
`dist/browser-tech-test/browser/`, and deploys that artifact.

1. In the repository settings, open **Pages** and set **Source** to **GitHub
   Actions**.
2. Push to `main`, or run **Deploy to GitHub Pages** manually from the Actions
   tab.
3. Open <https://fastenhealth.github.io/browser-tech-test/> after the deployment
   completes.

For the cross-site frame setup, fork or mirror the repository under a second
GitHub owner, enable Pages there, deploy the same commit, and pass that Pages URL
through `?frame=` on the primary site.

See GitHub's documentation for
[custom Pages workflows](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages),
[publishing-source configuration](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site),
and [Pages URL formats](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages).
Angular's related build guidance is in the
[Angular deployment documentation](https://angular.dev/tools/cli/deployment).
