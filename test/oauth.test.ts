import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {request} from 'node:http';
import {OAuthStore,ProtonOAuth,opaque,SCOPE,type OAuthConfig} from '../src/oauth.js';
import {createHttpApp,consentPolicy} from '../src/http.js';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const config:OAuthConfig={issuerUrl:'https://mail-tools.pfennig.haus',githubClientId:'test-client-id',githubClientSecret:'test-secret-not-real-123456',githubOwnerId:'546459',githubOwnerLogin:'mxpf'};
const redirect='https://chatgpt.com/connector_platform/oauth/callback';
const challenge=(verifier:string)=>createHash('sha256').update(verifier).digest('base64url');

test('authorization codes bind client, redirect and audience; tokens rotate, revoke and expire',async()=>{
  let now=1000;
  const directory=mkdtempSync(join(tmpdir(),'proton-oauth-'));
  const path=join(directory,'state.sqlite');
  let store=new OAuthStore(path,()=>now);
  let provider=new ProtonOAuth(config,store);
  const client=await provider.clientsStore.registerClient({redirect_uris:[redirect],token_endpoint_auth_method:'none'});
  const other=await provider.clientsStore.registerClient({redirect_uris:[redirect],token_endpoint_auth_method:'none'});
  const code=opaque();
  store.put('code',code,{clientId:client.client_id,redirectUri:redirect,challenge:challenge(opaque()),resource:provider.resource,scopes:[SCOPE]},60);
  await assert.rejects(provider.exchangeAuthorizationCode(other,code,undefined,redirect));
  await assert.rejects(provider.exchangeAuthorizationCode(client,code,undefined,'https://evil.example/callback'));
  await assert.rejects(provider.exchangeAuthorizationCode(client,code,undefined,redirect,new URL('https://evil.example/mcp')));
  const tokens=await provider.exchangeAuthorizationCode(client,code,undefined,redirect);
  await assert.rejects(provider.exchangeAuthorizationCode(client,code,undefined,redirect));
  store.close(); store=new OAuthStore(path,()=>now);provider=new ProtonOAuth(config,store);
  assert.equal((await provider.verifyAccessToken(tokens.access_token)).clientId,client.client_id);
  await assert.rejects(provider.exchangeRefreshToken(other,tokens.refresh_token!));
  const fresh=await provider.exchangeRefreshToken(client,tokens.refresh_token!);
  await assert.rejects(provider.exchangeRefreshToken(client,tokens.refresh_token!));
  await assert.rejects(provider.verifyAccessToken(fresh.access_token));
  const expiring=opaque();store.put('code',expiring,{clientId:client.client_id,redirectUri:redirect,challenge:'x',resource:provider.resource,scopes:[SCOPE]},60);
  now+=61;await assert.rejects(provider.challengeForAuthorizationCode(client,expiring));
  store.close();rmSync(directory,{recursive:true,force:true});
});

test('slow owner sign-in gets fresh cookie-bound consent, then PKCE and authenticated MCP discovery',async()=>{
  let identity=546459,mailCalls=0,now=Math.floor(Date.now()/1000);
  const store=new OAuthStore(':memory:',()=>now); const provider=new ProtonOAuth(config,store);
  const githubCalls:string[]=[];
  const fakeFetch:typeof fetch=async(input,options)=>{
    githubCalls.push(String(input));
    if(String(input).endsWith('/access_token')) {
      const body=new URLSearchParams(String(options?.body));
      assert.ok(body.get('code_verifier'));assert.equal(body.get('redirect_uri'),config.issuerUrl+'/oauth/github/callback');
      return Response.json({access_token:'fake-github-token'});
    }
    assert.equal(String(input),'https://api.github.com/user');return Response.json({id:identity,login:'mxpf'});
  };
  const app=createHttpApp(provider,{execute:async()=>{mailCalls++;return {authenticated:true};}},fakeFetch);
  const server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));
  const address=server.address();assert.ok(address && typeof address==='object');
  const base=`http://127.0.0.1:${address.port}`;
  const localFetch:typeof fetch=async(input,init={})=>new Promise((resolve,reject)=>{
    const headers=new Headers(init.headers);headers.set('Host','mail-tools.pfennig.haus');
    const req=request(String(input),{method:init.method || 'GET',headers:Object.fromEntries(headers)},res=>{
      const chunks:Buffer[]=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>{
        const responseHeaders=new Headers();for(const [key,value] of Object.entries(res.headers)) if(value) responseHeaders.set(key,Array.isArray(value)?value.join(','):value);
        resolve(new Response([204,304].includes(res.statusCode!)?null:Buffer.concat(chunks),{status:res.statusCode,headers:responseHeaders}));
      });
    });req.on('error',reject);req.end(init.body ? String(init.body):undefined);
  });
  const call=(path:string,init:RequestInit={})=>localFetch(base+path,init);
  try {
    assert.equal((await fetch(base+'/')).status,421);
    const unauth=await call('/mcp',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
    assert.equal(unauth.status,401);assert.match(unauth.headers.get('www-authenticate')||'',/oauth-protected-resource/);assert.equal(mailCalls,0);
    assert.equal((await call('/mcp',{method:'POST',headers:{Authorization:'Bearer invalid'}})).status,401);
    const registered=await call('/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({client_name:'Test assistant',redirect_uris:[redirect],token_endpoint_auth_method:'none',grant_types:['authorization_code','refresh_token'],response_types:['code']})});
    assert.equal(registered.status,201);const client=await registered.json();
    const verifier=opaque();
    const begin=()=>call('/authorize?'+new URLSearchParams({client_id:client.client_id,response_type:'code',redirect_uri:redirect,code_challenge:challenge(verifier),code_challenge_method:'S256',state:'client-state',resource:provider.resource,scope:SCOPE}));
    const initial=await begin();assert.equal(initial.status,302);
    const githubURL=new URL(initial.headers.get('location')!);
    assert.equal(githubURL.origin,'https://github.com');assert.equal(githubURL.searchParams.get('scope'),'');
    const state=githubURL.searchParams.get('state')!;
    const cookie=initial.headers.get('set-cookie')!.split(';')[0];
    assert.equal((await call('/oauth/github/callback?'+new URLSearchParams({state,code:'fake'}))).status,400);
    assert.equal(githubCalls.length,0);
    identity=123;
    assert.equal((await call('/oauth/github/callback?'+new URLSearchParams({state,code:'fake'}),{headers:{Cookie:cookie}})).status,403);
    identity=546459;
    const owner=await begin();const ownerState=new URL(owner.headers.get('location')!).searchParams.get('state')!;
    const ownerCookie=owner.headers.get('set-cookie')!.split(';')[0];
    // Reproduce a GitHub login that leaves almost no lifetime on the login cookie.
    now+=590;
    const callback=await call('/oauth/github/callback?'+new URLSearchParams({state:ownerState,code:'fake'}),{headers:{Cookie:ownerCookie}});
    assert.equal(callback.status,303);assert.equal(callback.headers.get('location'),'/oauth/consent');
    const setCookie=callback.headers.get('set-cookie')!;
    const consentCookie=/__Host-proton-consent=[A-Za-z0-9_-]{43}/.exec(setCookie)![0];
    assert.match(setCookie,/Max-Age=300/);assert.match(setCookie,/HttpOnly/);assert.match(setCookie,/Secure/);assert.match(setCookie,/SameSite=Lax/);
    assert.notEqual(consentCookie.split('=')[1],ownerCookie.split('=')[1]);
    now+=20; // The browser no longer has the expired login cookie.
    assert.equal((await call('/oauth/consent')).status,403);
    assert.equal((await call('/oauth/consent',{headers:{Cookie:ownerCookie}})).status,403);
    const consentPage=await call('/oauth/consent',{headers:{Cookie:consentCookie}});
    assert.equal(consentPage.status,200);assert.equal(consentPage.headers.get('referrer-policy'),'same-origin');assert.match(consentPage.headers.get('content-security-policy')!,/form-action 'self' https:\/\/chatgpt.com;/);const html=await consentPage.text();assert.match(html,/Allow access/);
    const consent=/name="consent" value="([A-Za-z0-9_-]+)"/.exec(html)![1];
    const consentPost=(origin:string,cookie=consentCookie,formToken=consent)=>call('/oauth/consent',{method:'POST',headers:{Cookie:cookie,Origin:origin,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({consent:formToken})});
    assert.equal((await consentPost('https://evil.example')).status,403);
    assert.equal((await consentPost('null')).status,403);
    assert.equal((await call('/oauth/consent',{method:'POST',headers:{Origin:config.issuerUrl,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({consent})})).status,403);
    assert.equal((await consentPost(config.issuerUrl,'__Host-proton-consent='+opaque())).status,403);
    assert.equal((await consentPost(config.issuerUrl,consentCookie,'malformed')).status,403);
    const allowed=await consentPost(config.issuerUrl);assert.equal(allowed.status,303);
    assert.match(allowed.headers.get('set-cookie')!,/__Host-proton-consent=;/);
    assert.equal(store.get('consent-session',consentCookie.split('=')[1]),undefined);
    assert.equal(store.get('consent',consent),undefined);
    const destination=new URL(allowed.headers.get('location')!);assert.equal(destination.searchParams.get('state'),'client-state');
    assert.equal((await consentPost(config.issuerUrl)).status,403);
    const exchange=(codeVerifier:string)=>call('/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:client.client_id,grant_type:'authorization_code',code:destination.searchParams.get('code')!,code_verifier:codeVerifier,redirect_uri:redirect,resource:provider.resource})});
    assert.equal((await exchange(opaque())).status,400);
    const tokenResponse=await exchange(verifier);assert.equal(tokenResponse.status,200);const tokens=await tokenResponse.json();
    assert.equal((await exchange(verifier)).status,400);
    const transport=new StreamableHTTPClientTransport(new URL(base+'/mcp'),{fetch:localFetch,requestInit:{headers:{Host:'mail-tools.pfennig.haus',Authorization:`Bearer ${tokens.access_token}`}}});
    const mcp=new Client({name:'test',version:'1'});await mcp.connect(transport);
    assert.equal((await mcp.listTools()).tools.length,10);
    await mcp.callTool({name:'proton_status',arguments:{}});assert.equal(mailCalls,1);
    await mcp.close();
    await provider.revokeToken(client,{token:tokens.access_token});
    assert.equal((await call('/mcp',{method:'POST',headers:{Authorization:`Bearer ${tokens.access_token}`}})).status,401);
    // An expired approval cannot render or issue a code, even with both secrets.
    const expiredCookie=opaque(),expiredConsent=opaque();
    store.put('consent-session',expiredCookie,{consent:expiredConsent},300);
    store.put('consent',expiredConsent,{cookieHash:createHash('sha256').update(expiredCookie).digest('hex'),code:{clientId:client.client_id,redirectUri:redirect,challenge:challenge(verifier),resource:provider.resource,scopes:[SCOPE]}},300);
    now+=301;
    assert.equal((await call('/oauth/consent',{headers:{Cookie:'__Host-proton-consent='+expiredCookie}})).status,403);
    assert.equal((await consentPost(config.issuerUrl,'__Host-proton-consent='+expiredCookie,expiredConsent)).status,403);
  } finally {server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));store.close();}
});

 test('consent policy permits only the registered return origin and rejects CSP injection',()=>{
  const policy=consentPolicy('https://chatgpt.com/connector/oauth/test?next=https://evil.example');
  assert.match(policy,/form-action 'self' https:\/\/chatgpt.com;/);
  assert.ok(!policy.includes('evil.example'));
  assert.throws(()=>consentPolicy('https://evil.example;script-src/callback'));
  assert.throws(()=>consentPolicy('http://chatgpt.com/callback'));
 });
