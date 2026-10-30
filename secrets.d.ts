interface Env { BRIDGE_TOKEN: string; }
interface Env { CALLBACK_HOSTS?: string; }

interface Env { OAUTH: DurableObjectNamespace<import('./src/oauth-state').OAuthState>; OAUTH_REDIRECT_URIS?: string; EVENTS_DISCOVERY_ENABLED?: string; }
