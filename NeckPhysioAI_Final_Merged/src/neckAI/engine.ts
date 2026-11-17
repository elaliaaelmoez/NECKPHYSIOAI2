import {ExerciseConfig} from './config';
import {clamp,virtualPoint,targetAt,stdDev,Measurement} from './geometry';
export type {Measurement} from './geometry';

/** Webcam-derived orientation and posture proxies; NOT joint angles or force. All values are experimental. */
export type FormStatus='correct'|'adjust'|'unavailable'|'calibrating';
export type Phase='idle'|'moving'|'holding'|'returning'|'completed';
export type FeedbackCode='center'|'nod'|'moving'|'stable'|'drift'|'target'|'offTarget'|'noSide'|'nodTooSmall'|'nodTooLarge'|'headLift'|'trunkLean'|'rotation'|'pitch'|'roll'|'hold'|'release'|'shrug'|'translation'|'cva'|'jpe'|'unavailable'|'completed'|'calUnstable';
export type Metric={key:string;label:string;labelAr:string;value:number;unit:string;acceptable:boolean;target:string};
export type Advice={en:string;ar:string};
export type Quality={ok:boolean;confidence:number;jitter?:number};
export type Observation={message:FeedbackCode;hit:boolean;hold:number;observations:number;accuracy:number|null;dot:{x:number;y:number};target:{x:number;y:number};status:FormStatus;reps:number;targetReps:number;phase:Phase;metrics:Metric[];reason:string;validSeconds:number;invalidSeconds:number;advice:Advice|null;reliable:boolean;confidence:number;compensations:string[];primary:{label:string;labelAr:string;value:number|null;unit:string;target:string}|null;requiredHold:number;jpe:number|null;lastJpe:number|null};
type Ev={hit:boolean;atRest:boolean;message:FeedbackCode;reason:string;advice:Advice|null;primary:Observation['primary']};

const A=(en:string,ar:string):Advice=>({en,ar});
const deg=(x:number)=>Math.max(1,Math.round(x));
const LASER_SEQ:[number,number][]=[[1,0],[-1,0],[0,1],[0,-1]];

export class ExerciseAnalyzer {
 baseline:Measurement|null=null;
 lastTime:number|null=null;
 elapsed=0; hold=0; hits=0; observations=0; reps=0; validSeconds=0; invalidSeconds=0;
 phase:Phase='idle';
 /** Neutral head: compare against the fixed experimental CVA target instead of the calibrated reference. */
 useFixedCva=false;
 lastJpe:number|null=null;
 private restT=0; private doneT=0; private unavailableT=0;
 private cvaHist:{t:number;v:number}[]=[]; private laserIdx=0;
 private trial={t:0,n:0,on:0,ts:[] as number[],hx:[] as number[],hy:[] as number[],tx:[] as number[],ty:[] as number[]};
 constructor(public config:ExerciseConfig){}
 calibrate(m:Measurement){
  this.baseline={...m};this.lastTime=null;this.elapsed=0;this.hold=0;this.hits=0;this.observations=0;this.reps=0;this.validSeconds=0;this.invalidSeconds=0;
  this.phase='idle';this.restT=0;this.doneT=0;this.unavailableT=0;this.cvaHist=[];this.laserIdx=0;this.lastJpe=null;this.resetTrial();
 }
 private resetTrial(){this.trial={t:0,n:0,on:0,ts:[],hx:[],hy:[],tx:[],ty:[]};}
 private resetRep(){this.phase='idle';this.hold=0;this.restT=0;this.cvaHist=[];}

 /** Call every frame. m=null or an unreliable quality pauses analysis (timers frozen, no counting). */
 analyze(m:Measurement|null,now:number,q:Quality={ok:true,confidence:1}):Observation|null{
  if(!this.baseline)return null;
  const dt=Math.max(0,Math.min(0.25,(now-(this.lastTime??now))/1000));this.lastTime=now;
  const c=this.config,t=c.targets,b=this.baseline;
  if(!m||!q.ok||q.confidence<0.5){
   this.unavailableT+=dt;if(this.unavailableT>1.5)this.resetRep();
   return this.build({hit:false,atRest:false,message:'unavailable',reason:'Measurement confidence is too low, analysis paused',advice:A('Tracking paused. Show your face and shoulders clearly in good light.','التتبع متوقف مؤقتًا. أظهري الوجه والكتفين بوضوح وفي إضاءة جيدة.'),primary:null},'unavailable',[],[],q,{x:0,y:0},{x:0,y:0},null);
  }
  this.unavailableT=0;this.elapsed+=dt;
  const yaw=m.yaw-b.yaw,pitch=m.pitch-b.pitch,roll=m.roll-b.roll;
  const range=t.rangeDeg??15;
  let dot=virtualPoint(yaw,pitch,range),target={x:0,y:0};
  const metrics:Metric[]=[],comps:string[]=[];
  const lim=(key:string,label:string,labelAr:string,value:number,limit:number,unit='°')=>{const ok=Math.abs(value)<=limit;metrics.push({key,label,labelAr,value,unit,acceptable:ok,target:`≤ ${limit}${unit}`});return ok;};
  const rng=(key:string,label:string,labelAr:string,value:number,lo:number,hi:number,unit='°')=>{const ok=value>=lo&&value<=hi;metrics.push({key,label,labelAr,value,unit,acceptable:ok,target:`${lo}–${hi}${unit}`});return ok;};
  const info=(key:string,label:string,labelAr:string,value:number,unit:string,target='monitor',acceptable=true)=>metrics.push({key,label,labelAr,value,unit,acceptable,target});
  // ---- shared compensation checks (only when the measurement exists) ----
  const trunkD=m.trunk!==undefined&&b.trunk!==undefined?m.trunk-b.trunk:null;
  const trunkOk=trunkD===null?true:lim('trunk','Trunk change','ميل الجذع',trunkD,t.maxTrunkDeg);
  if(!trunkOk)comps.push('trunk');
  const shrugD=c.view==='front'?(m.neckH!==undefined&&b.neckH!==undefined?(b.neckH-m.neckH)*100:null):(m.torsoV!==undefined&&b.torsoV!==undefined?(m.torsoV-b.torsoV)*100:null);
  const shrugOk=shrugD===null?true:lim('shrug','Shoulder shrug','رفع الكتف',shrugD,t.maxShrugPct,'%');
  if(!shrugOk)comps.push('shrug');
  const precise=q.confidence>=0.7&&(q.jitter===undefined||q.jitter<=1.5);
  const compAdvice=(code:FeedbackCode):Advice=>code==='trunkLean'?A('Keep your trunk still; avoid leaning.','ثبتي الجذع وتجنبي الميل.'):A('Relax your shoulders; do not raise them.','أرخي كتفيك ولا ترفعيهم.');
  let ev:Ev;
  const isStatic=c.mode==='isometric'||c.mode==='neutral';
  if(c.mode==='deepFlexor'){
   if(m.nod===undefined||b.nod===undefined){return this.build({hit:false,atRest:false,message:'noSide',reason:'Side-view ear and nose landmarks unavailable',advice:A('Turn sideways so your ear, nose, shoulder and hip are visible.','اقفي جنب الكاميرا بحيث تظهر الأذن والأنف والكتف والحوض.'),primary:null},'unavailable',[],[],q,dot,target,null);}
   const [lo,hi]=t.nod!;const nodD=m.nod-b.nod;
   const nodOk=rng('nod','Chin nod (proxy)','إيماءة الذقن',nodD,lo,hi);
   const liftD=m.lift!==undefined&&b.lift!==undefined?(m.lift-b.lift)*100:null;
   let liftOk=true;
   if(liftD!==null){if(t.lift)liftOk=rng('lift','Head lift','رفع الرأس',liftD,t.lift[0],t.lift[1],'%');else{liftOk=lim('lift','Head lift','رفع الرأس',liftD,t.maxLiftPct??2,'%');}}
   if(!liftOk)comps.push('lift');
   const fwdD=m.fwd!==undefined&&b.fwd!==undefined?(m.fwd-b.fwd)*100:null;
   const fwdOk=fwdD===null?true:lim('fwd','Forward head offset','إزاحة الرأس للأمام',fwdD,t.maxFwdPct??4,'%');
   if(!fwdOk)comps.push('translation');
   const hit=nodOk&&liftOk&&fwdOk&&trunkOk&&shrugOk;
   const atRest=nodD<1.5&&Math.abs(liftD??0)<1;
   const primary={label:'Chin nod',labelAr:'إيماءة الذقن',value:nodD,unit:'°',target:`${lo}–${hi}°`};
   let message:FeedbackCode='nod',reason='Gentle nod in target; keep holding',advice:Advice|null=null;
   if(!trunkOk){message='trunkLean';reason='Keep your trunk still';advice=compAdvice(message);}
   else if(!shrugOk){message='shrug';reason='Relax your shoulders';advice=compAdvice(message);}
   else if(!fwdOk){message='translation';reason='Keep your head from sliding forward';advice=A('Keep your head over your shoulders; do not push it forward.','خلي رأسك فوق كتفيك ولا تدفعيه للأمام.');}
   else if(!liftOk&&!t.lift){message='headLift';reason='Avoid lifting or translating your head';advice=A('Do not lift your head; only nod your chin.','لا ترفعي رأسك، حركي الذقن فقط.');}
   else if(nodD<lo){message='nodTooSmall';reason='Nod your chin gently';advice=nodD<0?A('Tuck your chin down gently instead of tilting your head back.','ادخلي الذقن لأسفل بلطف بدل ما تميلي الرأس للخلف.'):precise?A(`Increase your chin nod gently by approximately ${deg(lo-nodD)}°.`,`زودي إيماءة الذقن بلطف بحوالي ${deg(lo-nodD)}°.`):A('Increase your chin nod gently. The measurement is too uncertain for an exact correction.','زودي إيماءة الذقن بلطف. القياس غير مؤكد بما يكفي لتحديد درجة دقيقة.');}
   else if(nodD>hi){message='nodTooLarge';reason='Reduce the chin nod';advice=precise?A(`Reduce your chin nod slightly, by approximately ${deg(nodD-hi)}°.`,`قللي إيماءة الذقن قليلًا بحوالي ${deg(nodD-hi)}°.`):A('Reduce your chin nod slightly. The measurement is too uncertain for an exact correction.','قللي إيماءة الذقن قليلًا. القياس غير مؤكد بما يكفي لتحديد درجة دقيقة.');}
   else if(!liftOk&&t.lift&&liftD!==null){message='headLift';reason='Adjust the controlled head lift';advice=liftD<t.lift[0]?A('Lift your head slightly while keeping the nod.','ارفعي رأسك قليلًا مع الحفاظ على الإيماءة.'):A('Lower your head slightly; keep the lift small and controlled.','نزلي رأسك قليلًا وخلي الرفع صغير ومتحكم فيه.');}
   ev={hit,atRest,message,reason,advice,primary};
  }else if(c.mode==='neutral'){
   if(m.cva===undefined||b.cva===undefined||m.nod===undefined||b.nod===undefined){return this.build({hit:false,atRest:false,message:'noSide',reason:'Side-view posture landmarks unavailable',advice:A('Turn sideways so your ear, nose, shoulder and hip are visible.','اقفي جنب الكاميرا بحيث تظهر الأذن والأنف والكتف والحوض.'),primary:null},'unavailable',[],[],q,dot,target,null);}
   const refCva=this.useFixedCva?(t.referenceCva??50):b.cva;
   const cvaErr=m.cva-refCva;
   const cvaOk=lim('cva',this.useFixedCva?'Estimated CVA vs ~50° target (experimental)':'CVA change from your reference','زاوية الوضعية التقديرية',cvaErr,this.useFixedCva?(t.cvaTolDeg??8):4);
   const pitchErr=m.nod-b.nod;const pitchOk=lim('pitch','Head pitch error','خطأ ميل الرأس',pitchErr,t.maxPitchErrDeg??4);
   this.cvaHist.push({t:this.elapsed,v:m.cva});this.cvaHist=this.cvaHist.filter(h=>this.elapsed-h.t<=3);
   const drift=this.cvaHist.length>=10?stdDev(this.cvaHist.map(h=>h.v)):0;
   const driftOk=lim('postureDrift','Posture drift (3 s)','ثبات الوضعية',drift,t.maxPostureDriftDeg??2);
   const fwdD=m.fwd!==undefined&&b.fwd!==undefined?(m.fwd-b.fwd)*100:null;
   const fwdOk=fwdD===null?true:lim('fwd','Forward head offset','إزاحة الرأس للأمام',fwdD,t.maxFwdPct??5,'%');
   if(!fwdOk)comps.push('translation');
   const hit=cvaOk&&pitchOk&&driftOk&&fwdOk&&trunkOk&&shrugOk;
   const primary={label:'Estimated CVA error',labelAr:'فرق زاوية الوضعية',value:cvaErr,unit:'°',target:`≤ ${this.useFixedCva?(t.cvaTolDeg??8):4}°`};
   let message:FeedbackCode='stable',reason='Head posture stable relative to the reference',advice:Advice|null=null;
   if(!trunkOk){message='trunkLean';reason='Keep your trunk still';advice=compAdvice(message);}
   else if(!shrugOk){message='shrug';reason='Relax your shoulders';advice=compAdvice(message);}
   else if(!cvaOk){message='cva';reason='Bring your head toward the reference posture';advice=precise?(cvaErr<0?A(`Bring your head back over your shoulders by approximately ${deg(-cvaErr)}° (estimated CVA).`,`رجعي رأسك لفوق كتفيك بحوالي ${deg(-cvaErr)}° (زاوية تقديرية).`):A(`Lower your head toward the reference by approximately ${deg(cvaErr)}° (estimated CVA).`,`نزلي رأسك ناحية الوضع المرجعي بحوالي ${deg(cvaErr)}°.`)):A('Bring your head toward the reference posture. The measurement is too uncertain for an exact correction.','رجعي رأسك ناحية الوضع المرجعي. القياس غير مؤكد بما يكفي لتحديد درجة.');}
   else if(!pitchOk){message='pitch';reason='Return your head toward neutral';advice=A('Level your chin; tilt your head slightly '+(pitchErr>0?'up.':'down.'),'عدّلي ميل الذقن؛ ارفعي أو نزلي الرأس قليلًا.');}
   else if(!fwdOk){message='translation';reason='Keep your head over your shoulders';advice=A('Keep your head over your shoulders.','خلي رأسك فوق كتفيك.');}
   else if(!driftOk){message='drift';reason='Hold the posture more steadily';advice=A('Hold the posture more steadily.','ثبتي الوضعية بثبات أكتر.');}
   ev={hit,atRest:!hit,message,reason,advice,primary};
  }else if(c.mode==='isometric'){
   const hasDrift=m.hx!==undefined&&b.hx!==undefined&&m.hy!==undefined&&b.hy!==undefined;
   const driftPct=hasDrift?Math.hypot(m.hx!-b.hx!,m.hy!-b.hy!)*100:0;
   const driftOk=hasDrift?lim('drift','Head drift (of shoulder width)','حركة الرأس',driftPct,t.maxDriftPct??3,'%'):true;
   const yawOk=lim('yaw','Head orientation (yaw)','دوران الرأس',yaw,t.maxOrientDeg??3);
   const pitchOk=lim('pitch','Head orientation (pitch)','ميل الرأس للأمام',pitch,t.maxOrientDeg??3);
   const rollOk=lim('roll','Head roll change','ميل الرأس الجانبي',roll,t.maxRollDeg??3);
   const hit=driftOk&&yawOk&&pitchOk&&rollOk&&trunkOk&&shrugOk;
   let message:FeedbackCode='stable',reason='Head remains steady; hand contact and force are not verified',advice:Advice|null=null;
   if(!yawOk){message='rotation';reason='Keep your head from rotating';advice=A(precise?`Keep your head still: it turned about ${deg(Math.abs(yaw))}°.`:'Keep your head from rotating.',precise?`ثبتي رأسك: دارت حوالي ${deg(Math.abs(yaw))}°.`:'ثبتي رأسك ولا تدوريه.');}
   else if(!pitchOk){message='pitch';reason='Keep your head from tilting forward/back';advice=A('Keep your head from tilting forward or back.','ثبتي الرأس من غير ميل للأمام أو الخلف.');}
   else if(!rollOk){message='roll';reason='Keep your head level';advice=A('Keep your head level; do not tilt it sideways.','خلي رأسك مستقيمة من غير ميل جانبي.');}
   else if(!driftOk){message='drift';reason='Head moved from the calibrated position';advice=A('Your head is drifting; press without moving it.','رأسك بتتحرك؛ اضغطي من غير ما تحركيها.');}
   else if(!trunkOk){message='trunkLean';reason='Keep your trunk still';advice=compAdvice(message);}
   else if(!shrugOk){message='shrug';reason='Relax your shoulders';advice=compAdvice(message);}
   ev={hit,atRest:!hit,message,reason,advice,primary:{label:'Head drift',labelAr:'حركة الرأس',value:hasDrift?driftPct:Math.max(Math.abs(yaw),Math.abs(pitch),Math.abs(roll)),unit:hasDrift?'%':'°',target:hasDrift?`≤ ${t.maxDriftPct??3}%`:`≤ ${t.maxOrientDeg??3}°`}};
  }else if(c.mode==='laser'){
   const amp=t.targetAmplitudeDeg??10,rad=t.targetRadiusDeg??3.5,jpeMax=t.jpeMaxDeg??6;
   const [sx,sy]=LASER_SEQ[this.laserIdx%LASER_SEQ.length];const tx=sx*amp,ty=sy*amp;
   const jpe=Math.hypot(yaw,pitch),err=Math.hypot(yaw-tx,pitch-ty);
   target=this.phase==='returning'||this.phase==='completed'?{x:0,y:0}:{x:tx/range,y:-ty/range};
   const inTarget=err<=rad,home=jpe<=jpeMax;
   metrics.push({key:'targetError',label:'Target error',labelAr:'خطأ متابعة الهدف',value:err,unit:'°',acceptable:inTarget,target:`≤ ${rad}°`});
   metrics.push({key:'jpe',label:'Joint position error (return)',labelAr:'خطأ الرجوع للوضع الأصلي',value:jpe,unit:'°',acceptable:home,target:`< ${jpeMax}°`});
   info('yaw','Yaw','دوران الرأس',yaw,'°');info('pitch','Pitch','ميل الرأس',pitch,'°');
   const hit=inTarget&&trunkOk&&shrugOk;
   let message:FeedbackCode=hit?'target':'offTarget',reason=hit?'On virtual target; hold the dwell':'Move your head gently toward the target',advice:Advice|null=null;
   if(!trunkOk){message='trunkLean';reason='Keep shoulders and trunk steady';advice=compAdvice(message);}
   else if(!shrugOk){message='shrug';reason='Relax your shoulders';advice=compAdvice(message);}
   else if(this.phase==='returning'){message='jpe';reason='Return to the starting position';advice=home?A('Good. Hold still at the start position.','تمام. ثبتي عند وضع البداية.'):(precise?A(`Return to the start position; you are about ${deg(jpe-jpeMax+0.5)}° outside the ${jpeMax}° limit.`,`ارجعي لوضع البداية؛ أنتِ خارج الحد ${jpeMax}° بحوالي ${deg(jpe-jpeMax+0.5)}°.`):A('Return to the start position.','ارجعي لوضع البداية.'));}
   else if(!hit&&precise){advice=A(`Move your head toward the target by about ${deg(err-rad)}°.`,`حركي رأسك ناحية الهدف بحوالي ${deg(err-rad)}°.`);}
   else if(!hit){advice=A('Move your head gently toward the target.','حركي رأسك بهدوء ناحية الهدف.');}
   this.lastJpe=this.phase==='returning'?jpe:this.lastJpe;
   ev={hit,atRest:home,message,reason,advice,primary:{label:'Joint position error',labelAr:'خطأ وضعية المفصل',value:jpe,unit:'°',target:`< ${jpeMax}°`}};
  }else{ // tracking
   const tr=this.trial;tr.t+=dt;
   target=targetAt(tr.t,'tracking',Math.min(2,c.stage));
   const errN=Math.hypot(dot.x-target.x,dot.y-target.y),hit=errN<=c.targetRadius&&trunkOk&&shrugOk;
   tr.n++;if(hit)tr.on++;tr.ts.push(tr.t);tr.hx.push(dot.x*range);tr.hy.push(dot.y*range);tr.tx.push(target.x*range);tr.ty.push(target.y*range);
   const onPct=100*tr.on/Math.max(1,tr.n),minOn=t.minTimeOnTargetPct??70,n=tr.hx.length;
   const rmse=Math.sqrt(tr.hx.reduce((s,v,i)=>s+(v-tr.tx[i])**2+(tr.hy[i]-tr.ty[i])**2,0)/Math.max(1,n));
   let lagMs=0,gain=1,jerk=0,over=0;
   if(n>=30){
    const dtm=tr.t/n;let best=0,bestE=Infinity;
    for(let sft=0;sft<=6;sft++){let e=0,k=0;for(let i=sft;i<n;i++){e+=Math.abs(tr.hx[i]-tr.tx[i-sft])+Math.abs(tr.hy[i]-tr.ty[i-sft]);k++;}if(k&&e/k<bestE){bestE=e/k;best=sft;}}
    lagMs=best*dtm*1000;
    const path=(xs:number[],ys:number[])=>{let s=0;for(let i=1;i<xs.length;i++)s+=Math.hypot(xs[i]-xs[i-1],ys[i]-ys[i-1]);return s;};
    const tp=path(tr.tx,tr.ty);gain=tp>1e-6?path(tr.hx,tr.hy)/tp:1;
    const sp:number[]=[];for(let i=1;i<n;i++)sp.push(Math.hypot(tr.hx[i]-tr.hx[i-1],tr.hy[i]-tr.hy[i-1])/dtm);
    let jj=0;for(let i=2;i<sp.length;i++)jj+=Math.abs(sp[i]-2*sp[i-1]+sp[i-2])/(dtm*dtm);jerk=jj/Math.max(1,sp.length-2);
    const ext=Math.max(...tr.tx.map(Math.abs),...tr.ty.map(Math.abs));over=Math.max(0,Math.max(...tr.hx.map(Math.abs),...tr.hy.map(Math.abs))-ext);
   }
   metrics.push({key:'timeOnTarget',label:'Time on target',labelAr:'الوقت داخل الهدف',value:onPct,unit:'%',acceptable:onPct>=minOn,target:`≥ ${minOn}%`});
   metrics.push({key:'targetError',label:'Tracking error (RMSE)',labelAr:'خطأ المتابعة (RMSE)',value:rmse,unit:'°',acceptable:true,target:'monitor'});
   if(n>=30){metrics.push({key:'lag',label:'Lag',labelAr:'التأخير',value:lagMs,unit:' ms',acceptable:lagMs<=(t.maxLagMs??300),target:`≤ ${t.maxLagMs??300} ms`});
    metrics.push({key:'gain',label:'Gain (head/target path)',labelAr:'نسبة السرعة',value:gain,unit:'',acceptable:gain>=0.8&&gain<=1.2,target:'0.8–1.2'});
    info('jerk','Smoothness (jerk, lower = smoother)','السلاسة (أقل = أنعم)',jerk,'');info('overshoot','Overshoot','تجاوز الهدف',over,'°');}
   let message:FeedbackCode=hit?'target':'offTarget',reason=hit?'On virtual target':'Move your head gently toward the target',advice:Advice|null=null;
   if(!trunkOk){message='trunkLean';reason='Keep shoulders and trunk steady';advice=compAdvice(message);}
   else if(!shrugOk){message='shrug';reason='Relax your shoulders';advice=compAdvice(message);}
   else if(!hit)advice=A('Follow the target slowly and smoothly with your head.','اتبعي الهدف ببطء وسلاسة برأسك.');
   if(this.phase==='idle'||this.phase==='completed'&&this.doneT>=1.2)this.phase='moving';
   if(this.phase==='completed')this.doneT+=dt;
   if(tr.t>=(t.trialSeconds??20)){if(onPct>=minOn){this.reps++;}this.phase='completed';this.doneT=0;this.hold=0;this.resetTrial();}
   else this.hold=tr.t;
   ev={hit,atRest:false,message,reason,advice,primary:{label:'Time on target',labelAr:'الوقت داخل الهدف',value:onPct,unit:'%',target:`≥ ${minOn}%`}};
   if(this.phase==='completed')ev.message='completed';
   this.account(ev.hit,dt);
   return this.build(ev,hit?'correct':'adjust',metrics,comps,q,dot,target,null);
  }
  // ---- repetition state machine for hold-based modes: IDLE → MOVING → HOLDING → RETURNING → COMPLETED ----
  const req=c.mode==='laser'?(t.dwellSeconds??2):t.holdSeconds;
  this.account(ev.hit,dt);
  this.step(ev.hit,ev.atRest,dt,isStatic,req);
  if(this.phase==='returning'&&ev.hit&&isStatic){ev.message='release';ev.reason='Hold complete; gently release before the next repetition';ev.advice=A('Hold complete. Relax and release before the next repetition.','الثبات اكتمل. ارتاحي واتركي الوضع قبل التكرار التالي.');}
  if(this.phase==='completed'){ev.message='completed';ev.reason='Repetition completed';}
  return this.build(ev,ev.hit?'correct':'adjust',metrics,comps,q,dot,target,this.lastJpe);
 }
 private account(hit:boolean,dt:number){this.observations++;if(hit){this.hits++;this.validSeconds+=dt;}else this.invalidSeconds+=dt;}
 private step(hit:boolean,atRest:boolean,dt:number,isStatic:boolean,req:number){
  switch(this.phase){
   case 'idle':if(hit){this.phase='holding';this.hold=0;}else if(!isStatic&&!atRest)this.phase='moving';break;
   case 'moving':if(hit){this.phase='holding';this.hold=0;this.restT=0;}else if(atRest){this.restT+=dt;if(this.restT>1){this.phase='idle';this.restT=0;}}else this.restT=0;break;
   case 'holding':
    if(hit){this.hold+=dt;if(this.hold>=req){this.phase='returning';this.restT=0;}}
    else{this.hold=0;this.phase='moving';}
    break;
   case 'returning':
    if(atRest){this.restT+=dt;const need=isStatic?0.6:0.5;if(this.restT>=need){this.reps++;this.phase='completed';this.doneT=0;this.restT=0;this.hold=0;if(this.config.mode==='laser')this.laserIdx++;}}
    else this.restT=0;
    break;
   case 'completed':this.doneT+=dt;if(this.doneT>=1.2){this.phase='idle';this.doneT=0;}break;
  }
 }
 private build(ev:Ev,status:FormStatus,metrics:Metric[],comps:string[],q:Quality,dot:{x:number;y:number},target:{x:number;y:number},jpe:number|null):Observation{
  const t=this.config.targets;
  const o:Observation={message:ev.message,hit:ev.hit,hold:this.hold,observations:this.observations,accuracy:this.observations?clamp(100*this.hits/this.observations,0,100):null,dot,target,status,reps:this.reps,targetReps:10,phase:this.phase,metrics,reason:ev.reason,validSeconds:this.validSeconds,invalidSeconds:this.invalidSeconds,advice:ev.advice,reliable:status!=='unavailable',confidence:q.confidence,compensations:comps,primary:ev.primary,requiredHold:this.config.mode==='laser'?(t.dwellSeconds??2):this.config.mode==='tracking'?(t.trialSeconds??20):t.holdSeconds,jpe,lastJpe:this.lastJpe};
  return o;
 }
}
