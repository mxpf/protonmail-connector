// SSH-admin-only helper. stdout is a secret pipe consumed by health-hosted.mjs.
import {OAuthStore,loadOAuthConfig,opaque,HEALTH_SCOPE} from '../dist/src/oauth.js';
export function issueProbe(store,resource) {
 const access=opaque(),family=opaque(),ttl=120,clientId='proton-maintenance-health';
 store.transaction(()=>{
  store.put('family',family,{clientId},ttl);
  store.put('access',access,{clientId,scopes:[HEALTH_SCOPE],resource,family,expiresAt:store.now()+ttl},ttl);
 });
 return {access_token:access,expires_in:ttl};
}
export function revokeProbe(store,token) {
 const grant=store.get('access',token);
 if(grant?.scopes?.length!==1 || grant.scopes[0]!==HEALTH_SCOPE)throw Error('Not a probe grant');
 store.transaction(()=>{store.remove('family',grant.family);store.remove('access',token);});
}
import {fileURLToPath} from 'node:url';
import {realpathSync} from 'node:fs';
if(process.argv[1] && realpathSync(process.argv[1])===fileURLToPath(import.meta.url)) {
 let store;
 try {
  if(!process.env.PROTON_OAUTH_DB || !process.env.PROTON_OAUTH_CONFIG)throw Error();
  const config=loadOAuthConfig(process.env.PROTON_OAUTH_CONFIG);store=new OAuthStore(process.env.PROTON_OAUTH_DB);
  if(process.argv[2]==='--revoke') {
   let token='';for await(const chunk of process.stdin){token+=chunk;if(token.length>128)throw Error();}
   revokeProbe(store,token.trim());console.log(JSON.stringify({revoked:true}));
  } else if(process.argv.length===2)console.log(JSON.stringify(issueProbe(store,config.issuerUrl+'/mcp')));
  else throw Error();
 }catch {console.error('Health probe grant operation failed.');process.exitCode=1;}finally{store?.close();}
}
