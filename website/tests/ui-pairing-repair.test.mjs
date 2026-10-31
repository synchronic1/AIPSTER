import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

async function ui({ deferred = false, holdInventory = false } = {}) {
  const elements = new Map(), calls = [], pending = [], inventory = [], copied = [], logs = [];
  let holdInventoryNow = false;
  const el = id => {
    if (!elements.has(id)) elements.set(id, { id, hidden:true, innerHTML:'', textContent:'', value:'', dataset:{}, listeners:{},
      addEventListener(type, fn) { this.listeners[type] = fn; }, setAttribute() {}, querySelectorAll() { return []; } });
    return elements.get(id);
  };
  const names = ['overview','compute','shared','sharing','keys','usage','settings'];
  const tabs = names.map(name => Object.assign(el('nav-' + name), { dataset:{ tab:name } }));
  const response = (data, status = 200) => new Response(JSON.stringify(data), { status, headers:{'Content-Type':'application/json'} });
  const context = vm.createContext({
    document:{ getElementById:el, querySelectorAll(selector) { return selector === '[data-tab]' ? tabs : selector === '[role="tabpanel"]' ? names.map(n => el('tab-'+n)) : []; } },
    location:{origin:'http://localhost:8787',pathname:'/app/',search:''}, URLSearchParams, history:{replaceState(){}},
    navigator:{platform:'Win32',userAgent:'Windows',clipboard:{writeText:async text => copied.push(text)}}, setTimeout(){return 0;},
    console:{log:(...x)=>logs.push(x),warn:(...x)=>logs.push(x),error:(...x)=>logs.push(x),info:(...x)=>logs.push(x)},
    fetch:async (path, init={}) => {
      calls.push({path,init});
      if(path === '/api/auth/get-session') return response({user:{id:'synthetic-alice',name:'Alice',email:'synthetic@example.invalid'}});
      if(path === '/api/auth/sign-out') return response({ok:true});
      if(path === '/api/pairing/codes') {
        if(deferred) return new Promise(resolve => pending.push((data,status) => resolve(response(data,status))));
        return response({code:'SYNTHETIC-PAIR-CODE',expiresAt:'2100-01-01T00:00:00Z'},201);
      }
      if(path === '/api/inventory?limit=50' && holdInventoryNow) {
        return new Promise(resolve => inventory.push((data,status = 200) => resolve(response(data,status))));
      }
      if(path.startsWith('/api/usage')) return response({items:[],totals:{requests:0,tokensIn:0,tokensOut:0,modelCostUsd:0,executionCostUsd:0}});
      if(path.startsWith('/api/status')) return response({items:[],summary:{total:0,online:0,stale:0,offline:0,unknown:0},source:'declared-resources',telemetry:'unavailable'});
      return response({items:[],total:0,displayName:'Alice'});
    },
  });
  new vm.Script(await readFile(new URL('../public/app/app.js', import.meta.url),'utf8')).runInContext(context);
  const flush = async () => { for(let i=0;i<8;i++) await new Promise(setImmediate); };
  await flush();
  holdInventoryNow = holdInventory;
  const tab = async name => { tabs.find(t => t.dataset.tab === name).listeners.click(); await flush(); };
  await tab('compute');
  const press = async action => { el('connect-card').onclick({target:{dataset:{action}}}); await flush(); };
  const choose = async value => { el('connect-card').onchange({target:{dataset:{action:'os'},value}}); await flush(); };
  return {context,el,calls,pending,inventory,copied,logs,flush,tab,press,choose};
}

const pairedResource = {
  id:'synthetic-paired-row',name:'NEWEST-PAIRED-INVENTORY',kind:'local',origin:'paired',
  owner:{name:'Alice'},compute:{cpu:'synthetic',gpu:'none'},
  state:{configured:true,authenticated:true,online:false,usable:false,status:'unverified'},
  heartbeatAt:null,scope:'heartbeat',capabilities:[],
};

test('UI repair: Done inventory refresh wins over older success or failure in the same generation', async () => {
  for (const oldFailure of [false,true]) {
    const t = await ui({holdInventory:true});
    assert.equal(t.inventory.length,1);
    await t.press('pair'); await t.press('pair-done');
    assert.equal(t.inventory.length,2);
    t.inventory[1]({items:[pairedResource],total:1}); await t.flush();
    const cards = t.el('compute-list').innerHTML, selector = t.el('grant-resource').innerHTML;
    assert.match(cards,/NEWEST-PAIRED-INVENTORY/);
    assert.match(selector,/synthetic-paired-row/);
    t.inventory[0](oldFailure ? {error:'OLD-INVENTORY-FAILURE'} : {items:[],total:0},oldFailure ? 500 : 200);
    await t.flush();
    assert.equal(t.el('compute-list').innerHTML,cards);
    assert.equal(t.el('grant-resource').innerHTML,selector);
  }
});

test('UI repair: newest inventory failure stays visible after older successful snapshots', async () => {
  const t = await ui({holdInventory:true});
  await t.press('pair-done'); await t.press('pair-done');
  assert.equal(t.inventory.length,3);
  t.inventory[2]({error:'NEWEST-INVENTORY-FAILURE'},503); await t.flush();
  assert.match(t.el('compute-list').innerHTML,/NEWEST-INVENTORY-FAILURE/);
  for (const index of [1,0]) {
    t.inventory[index]({items:[pairedResource],total:1}); await t.flush();
    assert.match(t.el('compute-list').innerHTML,/NEWEST-INVENTORY-FAILURE/);
    assert.equal(t.el('grant-resource').innerHTML,'');
  }
});

test('INDEPENDENT UI: target change discards a late pairing-code success', async () => {
  const t = await ui({deferred:true});
  await t.press('pair'); await t.choose('linux');
  assert.ok(!t.el('connect-card').innerHTML.includes('SYNTHETIC-LATE-CODE'));
  t.pending[0]({code:'SYNTHETIC-LATE-CODE',expiresAt:'2100-01-01T00:00:00Z'},201); await t.flush();
  assert.ok(!t.el('connect-card').innerHTML.includes('SYNTHETIC-LATE-CODE'), 'cleared pairing state was repopulated after target change');
});

test('INDEPENDENT UI: target change discards a late pairing-code error', async () => {
  const t = await ui({deferred:true});
  await t.press('pair'); await t.choose('linux');
  t.pending[0]({error:'SYNTHETIC-LATE-ERROR',code:'PAIRING_LIMIT'},409); await t.flush();
  assert.ok(!t.el('connect-card').innerHTML.includes('SYNTHETIC-LATE-ERROR'));
});

test('INDEPENDENT UI: navigation, logout and replacement mint fence old responses; mint has CSRF', async () => {
  const t = await ui({deferred:true});
  await t.press('pair');
  const mint = t.calls.find(c => c.path === '/api/pairing/codes');
  assert.equal(mint.init.headers['X-Aipster-CSRF'],'1');
  assert.deepEqual(JSON.parse(mint.init.body),{ttlMinutes:10});
  await t.tab('keys'); t.pending[0]({code:'OLD-NAVIGATION-CODE'},201); await t.flush();
  assert.ok(!t.el('connect-card').innerHTML.includes('OLD-NAVIGATION-CODE'));
  await t.tab('compute'); await t.press('pair'); await t.press('pair-again');
  t.pending[2]({code:'NEWEST-CODE'},201); await t.flush();
  t.pending[1]({code:'REPLACED-CODE'},201); await t.flush();
  assert.ok(t.el('connect-card').innerHTML.includes('NEWEST-CODE'));
  assert.ok(!t.el('connect-card').innerHTML.includes('REPLACED-CODE'));
  await t.press('pair'); await t.el('logout').listeners.click();
  t.pending[3]({code:'PREVIOUS-IDENTITY-CODE'},201); await t.flush();
  assert.equal(t.el('connect-card').innerHTML,'');
  assert.equal(t.el('view-app').hidden,true);
});

test('INDEPENDENT UI: agent setup never clipboard-copies the revealed pairing bearer', async () => {
  const t = await ui(); await t.press('pair'); await t.press('copy-agent');
  assert.equal(t.copied.length,1);
  assert.ok(!t.copied[0].includes('SYNTHETIC-PAIR-CODE'));
  assert.ok(!JSON.stringify(t.logs).includes('SYNTHETIC-PAIR-CODE'));
});

test('UI repair: pairing checkout uses the published reviewed source pin and qualified sparse paths', async () => {
  const t = await ui();
  const commands = t.context.workerCommands('windows').join('\n');
  const pin = /git checkout --detach ([a-f0-9]{40})/.exec(commands)[1];
  assert.equal(pin,'3fa309cb08461ea046ee23e801404911c1f3bcc2');
  assert.match(commands,/sparse-checkout set --no-cone \/local-worker\/ \/LICENSE/);
  assert.ok(!commands.includes('git clone https://'), 'no full checkout replaces the qualified sparse flow');
  assert.match(t.context.agentInstructions('windows'), /Use the pinned commands below for pairing/);
});

test('UI repair: dismiss and navigation erase shown codes and invalidate pending mint work', async () => {
  const t = await ui({deferred:true});
  await t.press('pair'); await t.press('pair-done');
  t.pending[0]({code:'DISMISSED-CODE'},201); await t.flush();
  assert.ok(!t.el('connect-card').innerHTML.includes('DISMISSED-CODE'));
  await t.press('pair'); t.pending[1]({code:'SHOWN-CODE'},201); await t.flush();
  assert.ok(t.el('connect-card').innerHTML.includes('SHOWN-CODE'));
  await t.tab('keys');
  assert.ok(!t.el('connect-card').innerHTML.includes('SHOWN-CODE'), 'hidden tab retains no displayed bearer');
});

test('UI repair: anonymous/demo guards and displayed codes cannot become active markup', async () => {
  const t = await ui({deferred:true});
  vm.runInContext('me.demo = true', t.context);
  await t.press('pair'); assert.equal(t.pending.length,0);
  vm.runInContext('me = null', t.context);
  await t.press('pair'); assert.equal(t.pending.length,0);
  vm.runInContext('me = {id:"synthetic-alice", demo:false}', t.context);
  await t.press('pair');
  t.pending[0]({code:'<script>SYNTHETIC</script>',expiresAt:'<img src=x>'},201); await t.flush();
  assert.ok(!t.el('connect-card').innerHTML.includes('<script>'));
  assert.ok(t.el('connect-card').innerHTML.includes('&lt;script&gt;'));
});

test('INDEPENDENT UI: double Pair click while minting starts one mint', async () => {
  const t = await ui({deferred:true});
  await t.press('pair'); await t.press('pair');
  assert.equal(t.pending.length,1);
  t.pending[0]({code:'ONLY-CODE',expiresAt:'2100-01-01T00:00:00Z'},201); await t.flush();
  assert.ok(t.el('connect-card').innerHTML.includes('ONLY-CODE'));
  assert.ok(t.el('connect-card').innerHTML.includes('Authorizing: code minted'));
});

test('INDEPENDENT UI: source instructions start a sender and distinguish paired credential revocation', async () => {
  const t = await ui();
  const instructions = t.context.agentInstructions('windows');
  assert.match(instructions,/heartbeat-loop/, 'pair stores credentials and returns; source daemon does not start the sender');
  assert.ok(!/worker sends reachability heartbeats on its own/.test(instructions));
  assert.ok(!t.el('connect-card').innerHTML.includes('there is nothing to revoke here'), 'paired heartbeat keys remain live until explicitly revoked');
});
