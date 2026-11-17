import {describe,expect,it} from 'vitest';
import {ExerciseAnalyzer,Measurement} from './engine';
import {TRACKER_CONFIGS,DCF_STAGES,TRACKING_STAGES,ISOMETRIC_STAGES,LASER_STAGES} from './config';
import {poseMeasurements,summarizeCalibration,targetAt,Point} from './geometry';

const base:Measurement={yaw:0,pitch:0,roll:0,nod:10,cva:55,lift:0.5,fwd:0.2,trunk:0,torsoV:1,hx:0,hy:-0.5,neckH:0.5};
const mk=(a:Partial<Measurement>={}):Measurement=>({...base,...a});
const run=(a:ExerciseAnalyzer,m:Measurement,fromMs:number,seconds:number,q={ok:true,confidence:0.95,jitter:0.3})=>{let o=null as ReturnType<ExerciseAnalyzer['analyze']>;for(let t=0;t<seconds*1000;t+=100)o=a.analyze(m,fromMs+t,q);return o;};
const dcf=(id='deep-flexor-1')=>{const a=new ExerciseAnalyzer(TRACKER_CONFIGS[id]);a.calibrate(base);return a;};

describe('specification targets',()=>{
 it('deep flexor stage targets, holds and tracking/isometric/laser thresholds',()=>{
  expect(DCF_STAGES[1].nod).toEqual([5,8]);expect(DCF_STAGES[2].nod).toEqual([8,12]);expect(DCF_STAGES[3].nod).toEqual([10,15]);
  expect([1,2,3].every(s=>DCF_STAGES[s].holdSeconds===10)).toBe(true);expect(DCF_STAGES[4].lift).toBeTruthy();expect(DCF_STAGES[5].nod).toEqual([8,12]);
  expect([70,75,80]).toEqual([1,2,3].map(s=>TRACKING_STAGES[s].minTimeOnTargetPct));
  expect(ISOMETRIC_STAGES[1]).toMatchObject({maxDriftPct:3,maxRollDeg:3,maxShrugPct:3});
  expect([LASER_STAGES[1].jpeMaxDeg,LASER_STAGES[2].jpeMaxDeg,LASER_STAGES[1].dwellSeconds]).toEqual([6,4.5,2]);
 });
});

describe('deep cervical flexor feedback',()=>{
 it('gives an approximate numeric correction when reliable (3° vs 5–8° target → ~2°)',()=>{
  const o=run(dcf(),mk({nod:13}),1000,0.5)!;
  expect(o.status).toBe('adjust');expect(o.advice?.en).toMatch(/Increase your chin nod gently by approximately 2°/);
 });
 it('does not give an exact-degree correction when the measurement is uncertain',()=>{
  const o=run(dcf(),mk({nod:13}),1000,0.5,{ok:true,confidence:0.95,jitter:4})!;
  expect(o.advice?.en).not.toMatch(/\d°/);expect(o.advice?.en).toMatch(/uncertain/);
 });
 it('is correct inside the range and reports reduce when above it',()=>{
  expect(run(dcf(),mk({nod:16}),1000,0.3)!.status).toBe('correct');
  expect(run(dcf(),mk({nod:21}),1000,0.3)!.advice?.en).toMatch(/Reduce your chin nod.*approximately 3°/);
 });
 it('flags compensations: trunk lean and shoulder shrug',()=>{
  const t=run(dcf(),mk({nod:16,trunk:9}),1000,0.3)!;expect(t.status).toBe('adjust');expect(t.compensations).toContain('trunk');
  const s=run(dcf(),mk({nod:16,torsoV:1.06}),1000,0.3)!;expect(s.compensations).toContain('shrug');
 });
 it('counts a rep only after target + 10 s hold + compensation-free + return to baseline',()=>{
  const a=dcf();
  run(a,mk({nod:16}),1000,9);expect(a.reps).toBe(0);                 // hold too short
  run(a,base,10000,2);expect(a.reps).toBe(0);                        // released before the 10 s hold finished
  run(a,mk({nod:16}),12000,10.5);expect(a.reps).toBe(0);             // held, but not yet returned
  expect(a.phase).toBe('returning');
  run(a,base,23000,1);expect(a.reps).toBe(1);
  const b=dcf();run(b,mk({nod:16,trunk:9}),1000,12);run(b,base,14000,1);expect(b.reps).toBe(0); // compensation blocks the rep
 });
 it('pauses analysis and counts nothing while landmarks are missing',()=>{
  const a=dcf();run(a,mk({nod:16}),1000,4);const h=a.hold;
  const o=a.analyze(null,5000,{ok:false,confidence:0});expect(o?.status).toBe('unavailable');
  for(let t=5100;t<5800;t+=100)a.analyze(null,t,{ok:false,confidence:0});expect(a.hold).toBe(h);
  expect(a.analyze(mk({nod:16}),6000,{ok:true,confidence:0.3})?.status).toBe('unavailable');
 });
});

describe('other exercises',()=>{
 it('isometric: drift, roll and shrug limits',()=>{
  const a=()=>{const x=new ExerciseAnalyzer(TRACKER_CONFIGS['cervical-isometric']);x.calibrate(base);return x;};
  expect(run(a(),mk(),1000,0.3)!.status).toBe('correct');
  expect(run(a(),mk({hx:0.05}),1000,0.3)!.message).toBe('drift');          // 5% of shoulder width
  expect(run(a(),mk({roll:4}),1000,0.3)!.message).toBe('roll');
  expect(run(a(),mk({neckH:0.45}),1000,0.3)!.compensations).toContain('shrug');
 });
 it('neutral head: posture drift and pitch error',()=>{
  const a=new ExerciseAnalyzer(TRACKER_CONFIGS['neutral-head-1']);a.calibrate(base);
  expect(run(a,mk(),1000,1)!.status).toBe('correct');
  expect(run(a,mk({nod:15}),3000,0.3)!.message).toBe('pitch');             // 5° pitch error > 4°
  const b=new ExerciseAnalyzer(TRACKER_CONFIGS['neutral-head-1']);b.calibrate(base);b.useFixedCva=true;
  expect(run(b,mk({cva:55}),1000,0.3)!.status).toBe('correct');expect(run(b,mk({cva:70}),3000,0.3)!.message).toBe('cva');
 });
 it('laser: counts a repositioning only when the return JPE is below the limit',()=>{
  const mkL=()=>{const x=new ExerciseAnalyzer(TRACKER_CONFIGS['laser-proprioception']);x.calibrate(base);return x;};
  const good=mkL();run(good,mk({yaw:10}),1000,2.5);run(good,mk({yaw:2}),4000,1);expect(good.reps).toBe(1);expect(good.lastJpe).toBeLessThan(6);
  const bad=mkL();run(bad,mk({yaw:10}),1000,2.5);run(bad,mk({yaw:8}),4000,2);expect(bad.reps).toBe(0);
 });
 it('tracking: time-on-target decides whether a trial counts; metrics are reported',()=>{
  const a=new ExerciseAnalyzer(TRACKER_CONFIGS['tracking-1']);a.calibrate(base);let t=1000,tt=0,o=null as ReturnType<ExerciseAnalyzer['analyze']>;
  for(let i=0;i<205;i++){const g=targetAt(tt,'tracking',1);o=a.analyze(mk({yaw:g.x*15,pitch:-g.y*15}),t,{ok:true,confidence:0.95});t+=100;tt+=0.1;}
  expect(a.reps).toBe(1);
  const keys=(o?.metrics??[]).map(m=>m.key);
  const b=new ExerciseAnalyzer(TRACKER_CONFIGS['tracking-1']);b.calibrate(base);
  for(let i=0;i<60;i++)o=b.analyze(mk({yaw:0}),1000+i*100,{ok:true,confidence:0.95});
  expect(['timeOnTarget','targetError','lag','gain','jerk','overshoot'].every(k=>(o?.metrics??[]).some(m=>m.key===k))).toBe(true);
  expect(keys.length).toBeGreaterThan(0);
  const c=new ExerciseAnalyzer(TRACKER_CONFIGS['tracking-1']);c.calibrate(base);for(let i=0;i<205;i++)c.analyze(mk({yaw:14}),1000+i*100,{ok:true,confidence:0.95});expect(c.reps).toBe(0);
 });
});

describe('measurement layer',()=>{
 const pose=(faceRight:boolean,w=640,h=480):Point[]=>{const p:Point[]=Array.from({length:33},()=>({x:0,y:0,visibility:0}));
  const set=(i:number,x:number,y:number)=>{p[i]={x:x/w,y:y/h,visibility:0.95};};
  const d=faceRight?1:-1;set(7,300,100);set(0,300+d*30,106);set(11,290,200);set(23,290,360);return p;};
 it('chin nod is identical whichever way the user faces and independent of video aspect ratio',()=>{
  const r=poseMeasurements(pose(true),{w:640,h:480},'side')!,l=poseMeasurements(pose(false),{w:640,h:480},'side')!;
  expect(r.nod).toBeCloseTo(l.nod!,5);expect(r.nod).toBeCloseTo(Math.atan2(6,30)*180/Math.PI,3);
 });
 it('returns null when landmarks are not confident',()=>{expect(poseMeasurements(pose(true).map(p=>({...p,visibility:0.2})),{w:640,h:480},'side')).toBeNull();});
 it('rejects an unstable calibration and accepts a steady one',()=>{
  const steady=Array.from({length:30},(_,i)=>mk({yaw:0.1*(i%3),nod:10+0.2*(i%2)}));
  expect(summarizeCalibration(steady).stable).toBe(true);
  const moving=Array.from({length:30},(_,i)=>mk({yaw:i}));
  const r=summarizeCalibration(moving);expect(r.stable).toBe(false);expect(r.worst).toBe('yaw');
 });
});
