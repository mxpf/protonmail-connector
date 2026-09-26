import express, {type Request, type Response, type ErrorRequestHandler} from 'express';
import {rateLimit} from 'express-rate-limit';
import {realpathSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {mcpAuthRouter, getOAuthProtectedResourceMetadataUrl} from '@modelcontextprotocol/sdk/server/auth/router.js';
import {requireBearerAuth} from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {createServer} from './server.js';
import {MailService} from './mail.js';
import {loadConfig} from './config.js';
import {OAuthStore, ProtonOAuth, loadOAuthConfig, opaque, hash, validOpaque, SCOPE, type Pending, type Consent} from './oauth.js';

const BASE_CSP = "default-src 'none'; img-src 'self'; style-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";
export function consentPolicy(redirectUri:string) {
  const destination = new URL(redirectUri);
  // This URL comes from the validated client's stored redirect URI, never a header.
  // Limit source syntax so client metadata cannot inject additional CSP directives.
  if (!/^https:\/\/[A-Za-z0-9.\[\]:-]+$/.test(destination.origin)) throw new Error('Invalid return origin.');
  return BASE_CSP.replace("form-action 'self'", `form-action 'self' ${destination.origin}`);
}

const escape = (s:string) => s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
function page(title:string,body:string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)} · Proton Mail Connector</title><link rel="stylesheet" href="/style.css"></head><body><main><img src="/logo.png" width="100" height="100" alt=""><p class="brand">Proton Mail Connector</p><h1>${escape(title)}</h1>${body}</main></body></html>`;
}
const CONSENT_COOKIE='__Host-proton-consent';
const CONSENT_TTL=300;
const cookieOptions={httpOnly:true,secure:true,sameSite:'lax' as const,path:'/'};
function browserCookie(req:Request,name='__Host-proton-oauth') {
  const value=req.headers.cookie?.split(';').map(s=>s.trim()).find(s=>s.startsWith(name+'='))?.split('=')[1];
  return validOpaque(value) ? value : undefined;
}
const clearCookie=(res:Response)=>res.clearCookie('__Host-proton-oauth',cookieOptions);
async function githubJSON(fetcher:typeof fetch,url:string,options:RequestInit) {
  const response=await fetcher(url,{...options,redirect:'error',signal:AbortSignal.timeout(15000)});
  if(!response.ok) throw new Error('GitHub request failed.');
  const text=await response.text();
  if(text.length>100000) throw new Error('GitHub response too large.');
  return JSON.parse(text);
}

export function createHttpApp(provider:ProtonOAuth,service:Pick<MailService,'execute'>,fetcher:typeof fetch=fetch) {
  const app=express();
  const origin=provider.config.issuerUrl;
  app.disable('x-powered-by');
  app.set('trust proxy','loopback');
  // no-referrer makes native form POSTs carry Origin: null in browsers.
  // same-origin preserves the exact-origin CSRF check without cross-site referrers.
  app.use((req,res,next)=>{
    res.set({'Cache-Control':'no-store','Referrer-Policy':'same-origin','X-Content-Type-Options':'nosniff',
      'X-Frame-Options':'DENY','Content-Security-Policy':BASE_CSP});
    if(req.get('host')!==new URL(origin).host) {res.status(421).send('Incorrect host.');return;}
    next();
  });
  app.use(rateLimit({windowMs:60000,limit:180,standardHeaders:'draft-8',legacyHeaders:false}));
  const loginLimit=rateLimit({windowMs:60000,limit:15,standardHeaders:'draft-8',legacyHeaders:false});
  app.get('/',(_req,res)=>res.type('html').send(page('Your mail, connected.',
    '<p>A private connection to Proton Mail, hosted in Finland. GitHub verifies your identity; it does not receive your email.</p><p><a class="button" href="/signin">Check GitHub sign-in</a></p><p class="muted">Connect your assistant using <code>https://mail-tools.pfennig.haus/mcp</code>. Access is restricted to the owner.</p>')));
  app.get('/logo.png',(_req,res)=>res.sendFile(fileURLToPath(new URL('../../assets/proton-mail-connector-logo.png',import.meta.url))));
  app.get('/style.css',(_req,res)=>res.type('css').send('html{color-scheme:dark}body{margin:0;background:#191813;color:#e9e4db;font:18px/1.6 system-ui,sans-serif}main{max-width:560px;margin:8vh auto;padding:28px}img{border-radius:20px}.brand{font-size:14px;letter-spacing:.08em;color:#bfb6a7}h1{font-size:36px;line-height:1.2;font-weight:600}a{color:inherit}button,.button{display:inline-block;border:0;border-radius:8px;padding:13px 20px;background:#e1d9cc;color:#191813;font:inherit;text-decoration:none;cursor:pointer}.muted{color:#bfb6a7;font-size:15px}code{overflow-wrap:anywhere;font-size:14px}.destination{padding:12px;background:#27251f;overflow-wrap:anywhere}'));
  app.get('/signin',loginLimit,(_req,res)=>provider.beginLogin(res));
  app.get('/oauth/github/callback',loginLimit,async(req,res)=>{
    try {
      const {state,code}=req.query;
      const cookie=browserCookie(req);
      if(!validOpaque(state) || typeof code!=='string' || code.length>1024 || !cookie) throw new Error('Invalid callback.');
      const pending=provider.store.get<Pending>('pending',state);
      if(!pending || pending.cookieHash!==hash(cookie)) throw new Error('Invalid login state.');
      provider.store.take('pending',state);
      const token=await githubJSON(fetcher,'https://github.com/login/oauth/access_token',{method:'POST',headers:{Accept:'application/json','Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:provider.config.githubClientId,client_secret:provider.config.githubClientSecret,code,redirect_uri:origin+'/oauth/github/callback',code_verifier:pending.githubVerifier})});
      if(typeof token.access_token!=='string' || token.access_token.length>2048 || token.error) throw new Error('GitHub rejected code.');
      const identity=await githubJSON(fetcher,'https://api.github.com/user',{headers:{Accept:'application/vnd.github+json',Authorization:`Bearer ${token.access_token}`,'User-Agent':'Proton-Mail-Connector','X-GitHub-Api-Version':'2022-11-28'}});
      if(String(identity.id)!==provider.config.githubOwnerId) {clearCookie(res);res.status(403).type('html').send(page('Access is restricted.','<p>This connector is available only to its owner.</p>'));return;}
      // GitHub tokens are used solely for identity verification and never persisted.
      if(!pending.code) {clearCookie(res);res.type('html').send(page('Sign-in verified.','<p>Your GitHub account is recognized as the owner. The connector is ready for assistant authorization.</p><p class="muted">This check has not granted access to an assistant or sent any email.</p>'));return;}
      // Give approval its own full lifetime, independent of time spent at GitHub
      // or a separate sign-in check clearing the login cookie. No tokens in URLs.
      const consent=opaque(), consentCookie=opaque();
      provider.store.transaction(()=>{
        provider.store.put('consent',consent,{cookieHash:hash(consentCookie),code:pending.code,clientState:pending.clientState,clientName:pending.clientName} satisfies Consent,CONSENT_TTL);
        provider.store.put('consent-session',consentCookie,{consent},CONSENT_TTL);
      });
      clearCookie(res);
      res.cookie(CONSENT_COOKIE,consentCookie,{...cookieOptions,maxAge:CONSENT_TTL*1000});
      // A clean same-site page verifies cookie round-trip before offering approval.
      res.redirect(303,'/oauth/consent');
    } catch {clearCookie(res);res.status(400).type('html').send(page('Sign-in could not be completed.','<p>Restart the connection from your assistant and try again.</p>'));}
  });
  app.get('/oauth/consent',loginLimit,(req,res)=>{
    const cookie=browserCookie(req,CONSENT_COOKIE);
    const session=cookie ? provider.store.get<{consent:string}>('consent-session',cookie) : undefined;
    const consent=session ? provider.store.get<Consent>('consent',session.consent) : undefined;
    if(!cookie || !session || !consent?.code || consent.cookieHash!==hash(cookie)) {
      console.warn(`OAuth consent page rejected: ${cookie ? 'session' : 'cookie'}`);
      res.status(403).type('html').send(page('Connection approval unavailable.', '<p>Your approval session is missing or expired. Start a fresh connection from ChatGPT in the same browser and allow cookies for this site.</p>'));
      return;
    }
    res.set('Content-Security-Policy',consentPolicy(consent.code.redirectUri)).type('html').send(page('Allow access to your mail?',
      `<p><strong>${escape((consent.clientName || 'An assistant').slice(0,150))}</strong> is requesting access. Client names are supplied by the requesting app; check its return address:</p><p class="destination">${escape(consent.code.redirectUri)}</p><p>This connection can search and read email and attachments, create drafts, send email, and organize messages. Access lasts up to 30 days.</p><p>Only approve an assistant connection you started and trust. Your assistant should ask before sending email.</p><form method="post" action="/oauth/consent"><input type="hidden" name="consent" value="${session.consent}"><button type="submit">Allow this connection</button></form><p><a href="/">Cancel</a></p>`));
  });
  app.post('/oauth/consent',loginLimit,express.urlencoded({extended:false,limit:'4kb'}),(req,res)=>{
    const cookie=browserCookie(req,CONSENT_COOKIE), key=req.body?.consent;
    const rejection = req.get('origin')!==origin ? 'origin' : !cookie ? 'cookie' : !validOpaque(key) ? 'form' : undefined;
    if(rejection) {
      console.warn(`OAuth consent rejected: ${rejection}`);
      res.status(403).type('html').send(page('Connection approval failed.', '<p>The browser did not provide a valid approval request. Start a fresh sign-in from ChatGPT.</p>'));
      return;
    }
    const consent=provider.store.get<Consent>('consent',key);
    if(!consent?.code || consent.cookieHash!==hash(cookie!)) {res.status(403).send('Consent expired. Restart the connection.');return;}
    const code=opaque();
    provider.store.transaction(()=>{provider.store.take('consent',key);provider.store.remove('consent-session',cookie!);provider.store.put('code',code,consent.code,60);});
    res.clearCookie(CONSENT_COOKIE,cookieOptions);
    const destination=new URL(consent.code.redirectUri);
    destination.searchParams.set('code',code);
    if(consent.clientState!==undefined) destination.searchParams.set('state',consent.clientState);
    res.set('Content-Security-Policy',consentPolicy(consent.code.redirectUri)).redirect(303,destination.href);
  });
  app.use(mcpAuthRouter({provider,issuerUrl:new URL(origin),resourceServerUrl:new URL(provider.resource),resourceName:'Proton Mail Connector',scopesSupported:[SCOPE],
    clientRegistrationOptions:{clientSecretExpirySeconds:0,rateLimit:{windowMs:3600000,limit:10}}}));
  app.use('/mcp',requireBearerAuth({verifier:provider,requiredScopes:[SCOPE],resourceMetadataUrl:getOAuthProtectedResourceMetadataUrl(new URL(provider.resource))}));
  app.post('/mcp',express.json({limit:'300kb'}),async(req,res)=>{
    const requestOrigin=req.get('origin');
    if(requestOrigin && ![origin,'https://chatgpt.com','https://chat.openai.com'].includes(requestOrigin)) {res.status(403).send('Origin not permitted.');return;}
    const server=createServer(service);
    const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
    res.on('close',()=>{void server.close();});
    await server.connect(transport);
    await transport.handleRequest(req,res,req.body);
  });
  app.all('/mcp',(_req,res)=>res.status(405).set('Allow','POST').send('Use POST.'));
  app.use((_req,res)=>res.status(404).send('Not found.'));
  const errorHandler:ErrorRequestHandler=(_error,_req,res,_next)=>{if(!res.headersSent) res.status(400).send('Request could not be completed.');};
  app.use(errorHandler);
  return app;
}

if(process.argv[1] && realpathSync(process.argv[1])===fileURLToPath(import.meta.url)) {
  if(!process.env.PROTON_CONFIG || !process.env.PROTON_OAUTH_CONFIG || !process.env.PROTON_OAUTH_DB) throw new Error('Private configuration paths are required.');
  const service=new MailService(loadConfig(process.env.PROTON_CONFIG));
  const store=new OAuthStore(process.env.PROTON_OAUTH_DB);
  const provider=new ProtonOAuth(loadOAuthConfig(process.env.PROTON_OAUTH_CONFIG),store);
  const server=createHttpApp(provider,service).listen(3100,'127.0.0.1',()=>console.log('Proton Mail Connector listening on loopback.'));
  server.requestTimeout=60000; server.headersTimeout=15000;
  const stop=()=>server.close(()=>{service.close();store.close();process.exit(0);});
  process.once('SIGTERM',stop);process.once('SIGINT',stop);
}
