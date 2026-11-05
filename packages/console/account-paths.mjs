import {join} from 'node:path';
const validId=id=>/^[a-f0-9-]{36}$/i.test(id);
export function accountDir(dataRoot,id){if(!validId(id))throw new Error('Invalid account ID');return join(dataRoot,'identity-profiles',id);}
export function autoSecretPath(dataRoot,id){return join(accountDir(dataRoot,id),'secrets.json');}
