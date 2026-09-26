import {DatabaseSync} from 'node:sqlite';
import {randomBytes, createHash} from 'node:crypto';
import {chmodSync, readFileSync, statSync} from 'node:fs';
import {z} from 'zod';
import type {Response} from 'express';
import type {OAuthServerProvider, AuthorizationParams} from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type {OAuthClientInformationFull, OAuthTokenRevocationRequest, OAuthTokens} from '@modelcontextprotocol/sdk/shared/auth.js';
import {InvalidGrantError, InvalidTokenError, InvalidClientMetadataError, InvalidScopeError, InvalidTargetError} from '@modelcontextprotocol/sdk/server/auth/errors.js';

export const SCOPE = 'proton:mail';
export const opaque = () => randomBytes(32).toString('base64url');
export const hash = (s: string) => createHash('sha256').update(s).digest('hex');
export const validOpaque = (s: unknown): s is string => typeof s === 'string' && /^[A-Za-z0-9_-]{43}$/.test(s);
export const oauthConfigSchema = z.object({
  issuerUrl: z.literal('https://mail-tools.pfennig.haus'),
  githubClientId: z.string().min(10).max(100), githubClientSecret: z.string().min(20).max(200),
  githubOwnerId: z.string().regex(/^\d+$/), githubOwnerLogin: z.string().min(1).max(100),
}).strict();
export type OAuthConfig = z.infer<typeof oauthConfigSchema>;
export function loadOAuthConfig(path: string): OAuthConfig {
  if ((statSync(path).mode & 0o077) !== 0) throw new Error('OAuth configuration must be private.');
  return oauthConfigSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

// SQLite transactions are synchronous: taking a one-use record and issuing its
// replacement cannot interleave with a competing request in this process.
export class OAuthStore {
  readonly db: DatabaseSync;
  constructor(path: string, readonly now = () => Math.floor(Date.now() / 1000)) {
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec('PRAGMA busy_timeout=5000; PRAGMA secure_delete=ON; CREATE TABLE IF NOT EXISTS oauth_records (kind TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, expires INTEGER NOT NULL, PRIMARY KEY(kind,key));');
  }
  put(kind: string, key: string, value: unknown, ttl: number) {
    this.db.prepare('DELETE FROM oauth_records WHERE expires <= ?').run(this.now());
    const count = this.db.prepare('SELECT count(*) AS n FROM oauth_records').get() as {n:number};
    if (count.n >= 10000) throw new Error('OAuth storage capacity reached.');
    this.db.prepare('INSERT INTO oauth_records VALUES (?,?,?,?)').run(kind, hash(key), JSON.stringify(value), this.now() + ttl);
  }
  get<T>(kind: string, key: string): T | undefined {
    const row = this.db.prepare('SELECT value FROM oauth_records WHERE kind=? AND key=? AND expires>?').get(kind,hash(key),this.now()) as {value:string}|undefined;
    return row ? JSON.parse(row.value) as T : undefined;
  }
  take<T>(kind: string, key: string): T | undefined {
    const row = this.db.prepare('DELETE FROM oauth_records WHERE kind=? AND key=? AND expires>? RETURNING value').get(kind,hash(key),this.now()) as {value:string}|undefined;
    return row ? JSON.parse(row.value) as T : undefined;
  }
  remove(kind:string,key:string) { this.db.prepare('DELETE FROM oauth_records WHERE kind=? AND key=?').run(kind,hash(key)); }
  transaction<T>(fn:()=>T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result=fn(); this.db.exec('COMMIT'); return result; }
    catch(error) { this.db.exec('ROLLBACK'); throw error; }
  }
  close() { this.db.close(); }
}

type Grant = {clientId:string; scopes:string[]; resource:string; family:string; expiresAt:number};
export type Code = {clientId:string; scopes:string[]; resource:string; redirectUri:string; challenge:string};
export type Pending = {cookieHash:string; githubVerifier:string; code?:Code; clientState?:string; clientName?:string};
export type Consent = Omit<Pending,'githubVerifier'>;

export class ProtonOAuth implements OAuthServerProvider {
  readonly resource: string;
  readonly clientsStore;
  constructor(readonly config:OAuthConfig, readonly store:OAuthStore) {
    this.resource = config.issuerUrl + '/mcp';
    this.clientsStore = {
      getClient: (id:string) => store.get<OAuthClientInformationFull>('client',id),
      registerClient: async (input:Omit<OAuthClientInformationFull,'client_id'|'client_id_issued_at'>):Promise<OAuthClientInformationFull> => {
        if (!input.redirect_uris.length || input.redirect_uris.length > 5 || JSON.stringify(input).length > 8000) throw new InvalidClientMetadataError('Invalid client metadata.');
        for (const value of input.redirect_uris) {
          const uri = new URL(value);
          if (uri.protocol !== 'https:' || uri.username || uri.password || uri.hash || value.length > 2048) throw new InvalidClientMetadataError('Only exact HTTPS redirect URLs are supported.');
        }
        if (input.scope && input.scope !== SCOPE) throw new InvalidScopeError('Unsupported scope.');
        const client:OAuthClientInformationFull = {...input,client_id:opaque(),client_id_issued_at:store.now(),scope:SCOPE};
        store.put('client',client.client_id,client,180*86400);
        return client;
      }
    };
  }
  checkResource(resource?:URL) {
    if (resource && resource.href !== this.resource) throw new InvalidTargetError('Incorrect protected resource.');
  }
  checkScopes(scopes?:string[]) {
    if (scopes && scopes.some(s=>s!==SCOPE)) throw new InvalidScopeError('Unsupported scope.');
  }
  async authorize(client:OAuthClientInformationFull,params:AuthorizationParams,res:Response) {
    this.checkResource(params.resource); this.checkScopes(params.scopes);
    if (!/^[A-Za-z0-9_-]{43}$/.test(params.codeChallenge) || !client.redirect_uris.includes(params.redirectUri)) throw new InvalidGrantError('Invalid authorization request.');
    this.beginLogin(res,{
      clientId:client.client_id,scopes:[SCOPE],resource:this.resource,redirectUri:params.redirectUri,challenge:params.codeChallenge
    },params.state,client.client_name);
  }
  beginLogin(res:Response,code?:Code,clientState?:string,clientName?:string) {
    const state=opaque(), cookie=opaque(), githubVerifier=opaque();
    this.store.put('pending',state,{cookieHash:hash(cookie),githubVerifier,code,clientState,clientName} satisfies Pending,600);
    res.cookie('__Host-proton-oauth',cookie,{httpOnly:true,secure:true,sameSite:'lax',path:'/',maxAge:600000});
    const url=new URL('https://github.com/login/oauth/authorize');
    url.search=new URLSearchParams({client_id:this.config.githubClientId,redirect_uri:this.config.issuerUrl+'/oauth/github/callback',
      scope:'',state,code_challenge:createHash('sha256').update(githubVerifier).digest('base64url'),code_challenge_method:'S256',allow_signup:'false',login:this.config.githubOwnerLogin}).toString();
    res.redirect(url.href);
  }
  code(client:OAuthClientInformationFull,token:string):Code {
    const code=this.store.get<Code>('code',token);
    if(!code || code.clientId!==client.client_id) throw new InvalidGrantError('Invalid or expired authorization code.');
    return code;
  }
  async challengeForAuthorizationCode(client:OAuthClientInformationFull,token:string) { return this.code(client,token).challenge; }
  async exchangeAuthorizationCode(client:OAuthClientInformationFull,token:string,_verifier?:string,redirectUri?:string,resource?:URL):Promise<OAuthTokens> {
    this.checkResource(resource);
    return this.store.transaction(()=>{
      const code=this.code(client,token);
      if(redirectUri!==code.redirectUri) throw new InvalidGrantError('Redirect URI mismatch.');
      this.store.take('code',token);
      const family=opaque(); this.store.put('family',family,{clientId:client.client_id},30*86400);
      return this.issue({...code,family,expiresAt:this.store.now()+30*86400});
    });
  }
  private issue(grant:Grant):OAuthTokens {
    const access=opaque(),refresh=opaque();
    const remaining=grant.expiresAt-this.store.now();
    if(remaining<=0) throw new InvalidGrantError('Sign in again.');
    const seconds=Math.min(3600,remaining);
    this.store.put('access',access,{...grant,expiresAt:this.store.now()+seconds},seconds);
    this.store.put('refresh',refresh,grant,remaining);
    return {access_token:access,token_type:'Bearer',expires_in:seconds,refresh_token:refresh,scope:grant.scopes.join(' ')};
  }
  async exchangeRefreshToken(client:OAuthClientInformationFull,token:string,scopes?:string[],resource?:URL):Promise<OAuthTokens> {
    this.checkResource(resource); this.checkScopes(scopes);
    // A reused refresh token invalidates its grant, including the replacement.
    const used=this.store.get<Grant>('used-refresh',token);
    if(used && used.clientId===client.client_id) {this.store.remove('family',used.family);throw new InvalidGrantError('Refresh token already used. Sign in again.');}
    return this.store.transaction(()=>{
      const grant=this.store.get<Grant>('refresh',token);
      if(!grant || grant.clientId!==client.client_id || !this.store.get('family',grant.family)) throw new InvalidGrantError('Invalid refresh token.');
      this.store.take('refresh',token);
      this.store.put('used-refresh',token,grant,grant.expiresAt-this.store.now());
      return this.issue(grant);
    });
  }
  async verifyAccessToken(token:string) {
    const grant=this.store.get<Grant>('access',token);
    if(!grant || !this.store.get('family',grant.family) || grant.resource!==this.resource) throw new InvalidTokenError('Invalid or expired access token.');
    return {token,clientId:grant.clientId,scopes:grant.scopes,expiresAt:grant.expiresAt,resource:new URL(grant.resource)};
  }
  async revokeToken(client:OAuthClientInformationFull,request:OAuthTokenRevocationRequest) {
    for(const kind of ['access','refresh','used-refresh']) {
      const grant=this.store.get<Grant>(kind,request.token);
      if(grant?.clientId===client.client_id) this.store.remove('family',grant.family);
    }
  }
}
