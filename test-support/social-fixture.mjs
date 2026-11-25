// Answers the three public handle APIs the way they document it: the GitHub users API, the npm registry and the
// Bluesky resolveHandle endpoint. The per-run controls (github, npm, bsky.app) exist; every other handle is missing
// unless listed in taken. Any other request goes to the wrapped fetcher. Synthetic names only.
export function withSocial(fetcher = async () => new Response(null, { status: 404 }), { taken = [], calls } = {}) {
  const exists = new Set(['github', 'lodash', 'bsky.app', ...taken, ...taken.map(name => name + '.bsky.social')]);
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.hostname === 'api.github.com' && url.pathname.startsWith('/users/')) {
      const login = decodeURIComponent(url.pathname.slice('/users/'.length));
      calls?.push(['GitHub', login]);
      return exists.has(login) ? Response.json({ login, id: 1, type: 'Organization' })
        : Response.json({ message: 'Not Found', documentation_url: 'https://docs.github.com/rest/users/users#get-a-user', status: '404' }, { status: 404 });
    }
    if (url.hostname === 'registry.npmjs.org') {
      const name = decodeURIComponent(url.pathname.slice(1));
      calls?.push(['npm', name]);
      return exists.has(name) ? Response.json({ name, 'dist-tags': { latest: '1.0.0' }, versions: {} })
        : Response.json({ error: 'Not found' }, { status: 404 });
    }
    if (url.hostname === 'public.api.bsky.app') {
      const handle = url.searchParams.get('handle');
      calls?.push(['Bluesky', handle]);
      return exists.has(handle) ? Response.json({ did: 'did:plc:' + 'a'.repeat(24) })
        : Response.json({ error: 'InvalidRequest', message: 'Unable to resolve handle' }, { status: 400 });
    }
    return fetcher(input, init);
  };
}
