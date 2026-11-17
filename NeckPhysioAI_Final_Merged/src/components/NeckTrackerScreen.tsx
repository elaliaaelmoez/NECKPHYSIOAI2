import {useEffect,useRef,useState} from 'react';
import {FaceLandmarker,PoseLandmarker,FilesetResolver} from '@mediapipe/tasks-vision';
import {apiFetch} from '../utils/api';
import {store} from '../game/store';
import {useLanguage} from '../i18n/LanguageContext';
import {TopBar} from './primitives';
import {NECK_EXERCISES} from '../data/neckExercises';
import {TRACKER_CONFIGS} from '../neckAI/config';
import {ExerciseAnalyzer,Measurement,Observation,Quality} from '../neckAI/engine';
import {ema,faceYawPitch,estimateHeadAngles,poseMeasurements,summarizeCalibration,stdDev,isVisible,Point} from '../neckAI/geometry';

type TrackingStatus='off'|'loading'|'calibration'|'tracking'|'stopped';
const info:{[k:string]:[string,string]}={
 nodTooSmall:['Nod your chin gently.','حركي الذقن للداخل برفق.'],
 nodTooLarge:['Reduce the chin nod.','قللي حركة الذقن.'],
 headLift:['Avoid lifting or translating your head.','تجنبي رفع الرأس أو إزاحته.'],
 trunkLean:['Keep your shoulders and trunk still.','ثبتي الكتفين والجذع.'],
 rotation:['Keep your head facing forward.','خلي الرأس ثابتة من غير دوران.'],
 pitch:['Return your head toward neutral.','ارجعي بالرأس للوضع المحايد.'],
 roll:['Keep your head level.','خلي الرأس مستقيمة من غير ميل جانبي.'],
 hold:['Maintain the position gently.','ثبتي الوضع بهدوء.'],
 release:['Hold complete! Release before the next repetition.','الثبات اكتمل! ارجعي للوضع الأول قبل التكرار التالي.'],
 center:['Face the camera before calibration.','واجهي الكاميرا قبل المعايرة.'],
 nod:['Small chin nod observed. Avoid lifting or forcing.','تم رصد إيماءة ذقن صغيرة؛ تجنبي رفع الرأس أو الضغط.'],
 stable:['Head direction relatively stable. Muscle force is not measured.','اتجاه الرأس ثابت نسبيًا؛ قوة العضلات غير مقاسة.'],
 drift:['Head position moved away from calibration reference.','الرأس ابتعد عن الوضع المرجعي للمعايرة.'],
 moving:['Movement observed.','تم رصد حركة.'],
 target:['Virtual target reached.','وصلتي للهدف الافتراضي.'],
 offTarget:['Move gently toward the on-screen target.','حركي الرأس بهدوء نحو الهدف على الشاشة.'],
 noSide:['For this exercise, show the side of your head and shoulder.','للتمرين ده، أظهري جانب الرأس والكتف في الكاميرا.'],
 lost:['Tracking interrupted. Reposition your face and shoulders.','التتبع انقطع؛ عدّلي وضع الرأس والكتفين.'],
 shrug:['Relax your shoulders; do not raise them.','أرخي كتفيك ولا ترفعيهم.'],
 translation:['Keep your head over your shoulders.','خلي رأسك فوق كتفيك.'],
 cva:['Bring your head toward the reference posture.','رجعي رأسك ناحية الوضع المرجعي.'],
 jpe:['Return to the starting position.','ارجعي لوضع البداية.'],
 unavailable:['Tracking paused: landmarks missing or low confidence.','التتبع متوقف: النقاط غير ظاهرة أو الثقة منخفضة.'],
 completed:['Repetition completed.','اكتمل التكرار.'],
 calUnstable:['You moved during calibration. Hold still and calibrate again.','اتحركتي أثناء المعايرة. ثبتي وأعيدي المعايرة.'],
 done:['Session stopped and camera closed.','انتهت الجلسة وتم إغلاق الكاميرا.']
};
const selectText=(en:string,ar:string,lang:string)=>lang==='ar'?ar:en;
const startModel='https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
const poseModel='https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';
export function NeckTrackerScreen(){
 const {language}=useLanguage();const tr=(en:string,ar:string)=>selectText(en,ar,language);
 const selected=store.getState().selectedNeckExerciseId;
 const exercise=NECK_EXERCISES.find(x=>x.id===selected);
 const config=selected?TRACKER_CONFIGS[selected]:null;
 const video=useRef<HTMLVideoElement>(null),overlay=useRef<HTMLCanvasElement>(null);
 const stream=useRef<MediaStream|null>(null),faceDetector=useRef<FaceLandmarker|null>(null),poseDetector=useRef<PoseLandmarker|null>(null);
 const frameId=useRef(0),active=useRef(false),lastFrame=useRef(0),lastUi=useRef(0),started=useRef(0),sampleCount=useRef(0),goodFrames=useRef(0);
 const filtered=useRef<Measurement|null>(null),calibrateStart=useRef<number|null>(null),calibrationSamples=useRef<Measurement[]>([]);
 const analyzer=useRef<ExerciseAnalyzer|null>(null),lastObservation=useRef<Observation|null>(null),calibratedRef=useRef(false),stableFrames=useRef(0),residuals=useRef<number[]>([]),rawNod=useRef<number|null>(null);
 const [status,setStatus]=useState<TrackingStatus>('off'),[message,setMessage]=useState(''),[error,setError]=useState('');
 const [observation,setObservation]=useState<Observation|null>(null),[calibrated,setCalibrated]=useState(false),[sessionSaved,setSessionSaved]=useState(false);
 const [effort,setEffort]=useState(3),[safetyBlocked,setSafetyBlocked]=useState(false);
 const [showPoints,setShowPoints]=useState(true),[report,setReport]=useState<Observation|null>(null),[calibrating,setCalibrating]=useState(false),[fixedCva,setFixedCva]=useState(false),[diag,setDiag]=useState('');
 useEffect(()=>{let alive=true;apiFetch('/api/neck/assessment/latest').then(r=>r.ok?r.json():null).then(a=>{if(alive)setSafetyBlocked(!!a?.answers?.warningSymptoms?.length||(a?.answers?.pain??0)>=7);}).catch(()=>{});return()=>{alive=false;stopCamera();};},[]);
 function stopCamera(){active.current=false;cancelAnimationFrame(frameId.current);stream.current?.getTracks().forEach(t=>t.stop());stream.current=null;faceDetector.current?.close();poseDetector.current?.close();faceDetector.current=null;poseDetector.current=null;if(video.current)video.current.srcObject=null;}
 function sample(now:number){
  frameId.current=requestAnimationFrame(sample);if(!active.current||now-lastFrame.current<90)return;lastFrame.current=now;
  const v=video.current,f=faceDetector.current,p=poseDetector.current;if(!v||!f||!p||v.readyState<2)return;
  try{
   const fr=f.detectForVideo(v,now),pr=p.detectForVideo(v,now);
   const pts=pr.landmarks?.[0] as Point[]|undefined;
   const facePts=fr.faceLandmarks?.[0] as Point[]|undefined;
   const matrix=fr.facialTransformationMatrixes?.[0]?.data;
   const size={w:v.videoWidth||640,h:v.videoHeight||480};
   let ang=matrix?faceYawPitch(Array.from(matrix)):null;
   if(!ang&&facePts)ang=estimateHeadAngles(facePts); // fallback when the transformation matrix is missing
   const view=config?.view??'front';
   const body=pts?poseMeasurements(pts,size,view):null;
   if(!ang&&view==='side'&&body)ang={yaw:0,pitch:0,roll:0}; // side exercises are measured from the pose only
   if(showPoints)drawCanvas(facePts??null,pts??null);else overlay.current?.getContext('2d')?.clearRect(0,0,overlay.current.width,overlay.current.height);
   sampleCount.current++;
   if(now-lastUi.current>400)setDiag(`Face ${facePts?'✓':'✗'} · Matrix ${matrix?'✓':'✗'} · Pose ${pts?'✓':'✗'} · Body ${body?'✓ '+Math.round(body.conf*100)+'%':'✗'}`);
   if(!ang||!body){ // landmarks missing: analysis is paused, nothing is counted
    if(calibratedRef.current){const o=analyzer.current?.analyze(null,now,{ok:false,confidence:0});if(o){lastObservation.current=o;if(now-lastUi.current>220){setObservation({...o});setMessage('unavailable');lastUi.current=now;}}}
    else if(now-lastUi.current>700){setMessage('lost');lastUi.current=now;}
    stableFrames.current=0;return;
   }
   goodFrames.current++;
   const {conf,...rest}=body;
   const raw:Measurement={...ang,...rest};
   const f0=filtered.current;
   const sm=(k:keyof Measurement)=>raw[k]===undefined?undefined:ema((f0?.[k] as number|undefined)??null,raw[k] as number);
   filtered.current=f0?{yaw:ema(f0.yaw,raw.yaw),pitch:ema(f0.pitch,raw.pitch),roll:ema(f0.roll,raw.roll),nod:sm('nod'),cva:sm('cva'),lift:sm('lift'),fwd:sm('fwd'),trunk:sm('trunk'),torsoV:sm('torsoV'),hx:sm('hx'),hy:sm('hy'),neckH:sm('neckH')}:raw;
   // jitter = spread of (raw − smoothed) nod; used to decide whether an exact-degree correction is justified
   if(raw.nod!==undefined&&filtered.current.nod!==undefined){residuals.current.push(raw.nod-filtered.current.nod);if(residuals.current.length>15)residuals.current.shift();}
   const quality:Quality={ok:conf>=0.5,confidence:conf,jitter:residuals.current.length>=8?stdDev(residuals.current)*2:undefined};
   // auto-start calibration after ~1 s of stable detection
   if(!calibratedRef.current&&calibrateStart.current===null){stableFrames.current++;if(stableFrames.current>=10){stableFrames.current=0;calibrateStart.current=now;calibrationSamples.current=[];setCalibrating(true);}}
   if(calibrateStart.current!==null){
    calibrationSamples.current.push(filtered.current);
    if(now-calibrateStart.current>=3000&&calibrationSamples.current.length>=8){
     const {baseline,stable}=summarizeCalibration(calibrationSamples.current);
     calibrateStart.current=null;setCalibrating(false);
     if(!stable){setMessage('calUnstable');calibrationSamples.current=[];stableFrames.current=0;return;} // moved: ask to hold still and retry
     if(analyzer.current)analyzer.current.useFixedCva=fixedCva;
     analyzer.current?.calibrate(baseline);calibratedRef.current=true;setCalibrated(true);setStatus('tracking');
    }
    return;
   }
   if(analyzer.current)analyzer.current.useFixedCva=fixedCva;
   const result=analyzer.current?.analyze(filtered.current,now,quality);
   if(result){lastObservation.current=result;if(now-lastUi.current>220){setObservation({...result});setMessage(result.message);lastUi.current=now;}}
  }catch(e){console.error('[neck tracker]',e);if(now-lastUi.current>800){setMessage('lost');lastUi.current=now;}}
 }
 function drawCanvas(face:Point[]|null,pose:Point[]|null){
  const c=overlay.current,v=video.current;if(!c||!v)return;c.width=v.videoWidth||640;c.height=v.videoHeight||480;
  const g=c.getContext('2d');if(!g)return;g.clearRect(0,0,c.width,c.height);
  g.strokeStyle=lastObservation.current?.status==='adjust'?'#ff6f77':lastObservation.current?.status==='correct'?'#47e3a5':'#76f0d1';g.lineWidth=3;
  const lines=[[0,1],[1,2],[2,3],[7,11],[8,12],[11,12],[11,23],[12,24]];
  if(pose){for(const [i,j] of lines){const a=pose[i],b=pose[j];if(!isVisible(a)||!isVisible(b))continue;g.beginPath();g.moveTo(a.x*c.width,a.y*c.height);g.lineTo(b.x*c.width,b.y*c.height);g.stroke();}}
  g.fillStyle='#fce4a6';if(face)for(const i of [1,33,263,61,291]){const a=face[i];if(!a)continue;g.beginPath();g.arc(a.x*c.width,a.y*c.height,4,0,2*Math.PI);g.fill();}
 }
 async function begin(){
  if(!config||safetyBlocked){setError('Safety review required before exercise.');return;}
  if(!navigator.mediaDevices?.getUserMedia){setError('Webcam requires a supported browser and localhost/HTTPS.');return;}
  setError('');setReport(null);setSessionSaved(false);setStatus('loading');
  try{
   const media=await navigator.mediaDevices.getUserMedia({audio:false,video:{facingMode:'user',width:{ideal:640},height:{ideal:480}}});stream.current=media;
   if(!video.current)throw Error('No video element');video.current.srcObject=media;await video.current.play();
   const vision=await FilesetResolver.forVisionTasks('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.32/wasm');
   const load=async<T,>(create:(delegate:'GPU'|'CPU')=>Promise<T>)=>{try{return await create('GPU');}catch{return await create('CPU');}};
   faceDetector.current=await load(delegate=>FaceLandmarker.createFromOptions(vision,{baseOptions:{modelAssetPath:startModel,delegate},runningMode:'VIDEO',numFaces:1,outputFacialTransformationMatrixes:true}));
   poseDetector.current=await load(delegate=>PoseLandmarker.createFromOptions(vision,{baseOptions:{modelAssetPath:poseModel,delegate},runningMode:'VIDEO',numPoses:1}));
   analyzer.current=new ExerciseAnalyzer(config);lastObservation.current=null;filtered.current=null;calibrateStart.current=null;calibratedRef.current=false;stableFrames.current=0;residuals.current=[];rawNod.current=null;setCalibrating(false);calibrationSamples.current=[];sampleCount.current=0;goodFrames.current=0;lastFrame.current=0;lastUi.current=0;setCalibrated(false);setObservation(null);setMessage('center');
   started.current=Date.now();active.current=true;setStatus('calibration');frameId.current=requestAnimationFrame(sample);
  }catch(e){stopCamera();setStatus('off');setError(e instanceof DOMException&&e.name==='NotAllowedError'?'Camera permission denied.':'Camera or MediaPipe model failed to initialize. Check browser console and connection.');}
 }
 function startCalibration(){if(!active.current||!filtered.current){setMessage('lost');return;}
  if(config?.view==='side'&&filtered.current.cva===undefined){setMessage('noSide');return;}
  calibrateStart.current=performance.now();calibrationSamples.current=[];calibratedRef.current=false;setCalibrating(true);setStatus('calibration');setCalibrated(false);
 }
 async function finish(safety=false){
  const duration=Math.max(0,Math.round((Date.now()-started.current)/1000));setReport(lastObservation.current);stopCamera();setStatus('stopped');setMessage('done');
  const a=analyzer.current;const quality=sampleCount.current===0?'lost':goodFrames.current/sampleCount.current>0.75?'good':'limited';
  const notes=[`Exercise ID: ${selected??'unknown'}`,`Mode: ${config?.mode??'unknown'}`,`Stage: ${config?.stage??0}`,`Observed samples: ${a?.observations??0}`,`On-target frames: ${a?.hits??0}`,`Hold at end: ${Math.round((lastObservation.current?.hold??0)*10)/10}s`,`Completed observable reps: ${a?.reps??0}`,`Time in target: ${Math.round(a?.validSeconds??0)}s`,`Time outside target: ${Math.round(a?.invalidSeconds??0)}s`,`Camera-matched frames: ${lastObservation.current?.accuracy?.toFixed(0)??'N/A'}% (not clinical accuracy)`,...((lastObservation.current?.metrics??[]).map(m=>`${m.label}: ${m.value.toFixed(1)}${m.unit} (demo target: ${m.target})`)),`Self-reported effort: ${effort}/10`,safety?'Stopped because patient reported symptoms':'No clinical correctness or muscle force measured'];
  if(safety)setSafetyBlocked(true);
  if(!selected){setError('No video selected.');return;}
  try{const r=await apiFetch('/api/neck/sessions',{method:'POST',body:JSON.stringify({exerciseId:selected,durationSeconds:duration,leftTurns:0,rightTurns:0,trackingQuality:quality,notes})});if(!r.ok)throw Error('Cannot save session');setSessionSaved(true);}
  catch{setError('Session finished, but saving to patient history failed. Check login and backend.');}
 }
 const mode=config?.mode, feedback=info[message];
 const adviceText=observation?.advice?(language==='ar'?observation.advice.ar:observation.advice.en):(feedback?selectText(feedback[0],feedback[1],language):'');
 const phaseLabel:Record<string,[string,string]>={idle:['IDLE','انتظار'],moving:['MOVING','حركة'],holding:['HOLDING','ثبات'],returning:['RETURNING','رجوع'],completed:['COMPLETED','اكتمل']};
 const compLabel:Record<string,[string,string]>={trunk:['trunk lean','ميل الجذع'],shrug:['shoulder shrug','رفع الكتف'],lift:['head lift','رفع الرأس'],translation:['forward head shift','إزاحة الرأس للأمام']};
 const assessment=observation?.status;
 const stateLabel=!calibrated?tr('CALIBRATING','جاري المعايرة'):assessment==='correct'?tr('CORRECT','صحيح'):assessment==='adjust'?tr('NEEDS CORRECTION','تحتاج تصحيح'):tr('TRACKING UNAVAILABLE','التتبع غير متاح');
 const statusColor=assessment==='correct'?'#107f55':assessment==='adjust'?'#bd394e':'#a36a1a';
 return <div className="screen dots-bg" dir={language==='ar'?'rtl':'ltr'} style={{minHeight:'100vh',padding:18}}>
  <TopBar here={2} steps={language==='ar'?['التقييم','الفيديو','الكاميرا']:['Assessment','Video','Camera']}/>
  <main className="plush" style={{maxWidth:1150,margin:'22px auto',padding:22,background:'var(--surface)'}}>
  <h1 style={{marginBottom:4}}>{tr('AI Exercise Analysis','تحليل التمرين بالذكاء الاصطناعي')}</h1>
  <h2>{exercise?.title??tr('Choose an exercise from the video library','اختاري تمرين من مكتبة الفيديوهات')}</h2>
  <p>{config?(language==='ar'?config.descriptionAr:config.descriptionEn):''}</p>
  <p><b>{tr('Camera direction:','اتجاه الكاميرا:')}</b> {config?.view==='side'?tr('side view, head and shoulders visible','من الجانب، مع ظهور الرأس والكتفين'):tr('front view, face and shoulders visible','من الأمام، مع ظهور الوجه والكتفين')}</p>
  <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(min(100%,410px),1fr))',gap:18,alignItems:'start'}}>
   <section aria-label={tr('Live webcam','الكاميرا المباشرة')}>
    <div style={{display:'flex',gap:10,justifyContent:'space-between',alignItems:'center',marginBottom:10}}>
     <b>📷 {tr('LIVE CAMERA','الكاميرا المباشرة')}</b>
     <label style={{fontSize:12}}><input type="checkbox" checked={showPoints} onChange={e=>setShowPoints(e.target.checked)}/> {tr('Show skeleton','إظهار نقاط الجسم')}</label>
    </div>
  <div style={{position:'relative',width:'100%',maxWidth:690,aspectRatio:'4/3',background:'#182a33',borderRadius:16,overflow:'hidden',margin:'auto'}}>
   <video ref={video} playsInline autoPlay muted style={{width:'100%',height:'100%',objectFit:'contain',transform:'scaleX(-1)'}}/>
   <canvas ref={overlay} aria-hidden="true" style={{position:'absolute',inset:0,width:'100%',height:'100%',objectFit:'contain',transform:'scaleX(-1)',pointerEvents:'none'}}/>
   {status==='off'&&<div style={{position:'absolute',inset:0,display:'grid',placeItems:'center',color:'#fff',padding:25,textAlign:'center'}}>{tr('Camera will appear here after permission.','الكاميرا هتظهر هنا بعد الموافقة على تشغيلها.')}</div>}
  </div>

    <div style={{marginTop:10,padding:12,borderRadius:12,background:assessment==='correct'?'#e4f8ed':assessment==='adjust'?'#fff0f1':'#f5f5ee',border:`1px solid ${assessment==='correct'?'#99d9b5':assessment==='adjust'?'#f0adb5':'#ddd'}`,color:'#183c3c'}} role="status" aria-live="polite">
      <strong style={{color:statusColor,fontSize:19}}>{assessment==='correct'?'✓ ':assessment==='adjust'?'! ':'● '}{stateLabel}</strong>
      <p style={{margin:'7px 0 0',fontSize:14}}>{!calibrated?(feedback&&message==='calUnstable'?selectText(feedback[0],feedback[1],language):calibrating?tr('Hold your neutral posture still for 3 seconds…','ثبتي وضعك المحايد ثابت لمدة ٣ ثوانٍ…'):tr('Hold a neutral posture; calibration starts automatically.','ثبتي الوضع المحايد؛ المعايرة هتبدأ تلقائيًا.')):adviceText}</p>
    </div>
   </section>
   <aside aria-label={tr('Live exercise assessment','تقييم التمرين المباشر')} style={{display:'grid',gap:12}}>
     <div style={{padding:17,borderRadius:16,background:'#f0f7f5',border:'1px solid #d6e7e2'}}>
       <b style={{fontSize:17}}>✓ {tr('Form Feedback','تقييم الحركة')}</b>
       <div style={{color:statusColor,fontSize:22,fontWeight:800,marginTop:11}}>{stateLabel}</div>
       <p style={{fontSize:14,margin:'6px 0'}}>{adviceText||tr('No tracking result yet.','لا توجد نتائج بعد.')}</p>
       {observation?.primary&&observation.reliable&&<div style={{fontSize:13,lineHeight:1.7}}><div>{tr('Current','القياس الحالي')}: <b>{language==='ar'?observation.primary.labelAr:observation.primary.label} {observation.primary.value===null?'—':observation.primary.value.toFixed(1)}{observation.primary.unit}</b></div><div>{tr('Target range','النطاق المستهدف')}: <b>{observation.primary.target}</b></div></div>}
       {!!observation?.compensations?.length&&<div style={{fontSize:13,color:'#bd394e'}}>{tr('Compensation detected','تعويض مرصود')}: {observation.compensations.map(k=>selectText(compLabel[k]?.[0]??k,compLabel[k]?.[1]??k,language)).join(', ')}</div>}
       <small style={{opacity:.8}}>{tr('Measurement reliability','موثوقية القياس')}: {Math.round((observation?.confidence??0)*100)}%{observation&&!observation.reliable?tr(' — too low, no exact corrections',' — منخفضة، لا تصحيحات دقيقة'):''}</small>
     </div>
     <div style={{display:'grid',gridTemplateColumns:'repeat(2,minmax(0,1fr))',gap:10}}>
      <div style={{padding:15,borderRadius:13,background:'#f3f4f8'}}><small>{tr('Target Match','التطابق مع الهدف')}</small><div style={{fontSize:27,fontWeight:800}}>{observation?.accuracy?.toFixed(0)??'—'}%</div></div>
      <div style={{padding:15,borderRadius:13,background:'#f3f4f8'}}><small>{tr('Completed Reps','التكرارات المكتملة')}</small><div style={{fontSize:27,fontWeight:800}}>{observation?.reps??0}</div></div>
      <div style={{padding:15,borderRadius:13,background:'#f3f4f8'}}><small>{tr('Current Hold','الثبات الحالي')}</small><div style={{fontSize:27,fontWeight:800}}>{(observation?.hold??0).toFixed(1)}s<small style={{fontSize:13}}> / {observation?.requiredHold??config?.targets.holdSeconds??0}s</small></div></div>
      <div style={{padding:15,borderRadius:13,background:'#f3f4f8'}}><small>{tr('Tracking Phase','مرحلة التتبع')}</small><div style={{fontSize:18,fontWeight:700}}>{observation?selectText(phaseLabel[observation.phase][0],phaseLabel[observation.phase][1],language):'—'}</div></div>
     </div>
     <div style={{padding:16,borderRadius:14,border:'1px solid #dce5e4'}}>
       <b>{tr('Live Angle & Motion Checks','فحص الزوايا والحركة المباشر')}</b>
       {observation?.metrics?.length ? observation.metrics.map(m=><div key={m.key} style={{display:'flex',alignItems:'center',justifyContent:'space-between',gap:8,borderBottom:'1px solid #edf0ef',padding:'9px 0'}}>
        <div><div style={{fontWeight:600,fontSize:14}}>{language==='ar'?m.labelAr:m.label}</div><small style={{opacity:.75}}>{tr('Demo target','النطاق التجريبي')}: {m.target}</small></div>
        <strong style={{fontSize:19,color:m.acceptable?'#107f55':'#bd394e',whiteSpace:'nowrap'}}>{m.value.toFixed(1)}{m.unit} {m.acceptable?'✓':'!'}</strong>
       </div>):<p style={{fontSize:13}}>{tr('Angles appear after calibration and reliable detection.','الزوايا هتظهر بعد المعايرة ورصد الجسم بوضوح.')}</p>}
     </div>
     <small>{tr('Demo camera-match score, not verified medical accuracy. 3D neck motion, muscle activity and resistance force cannot be fully assessed using one webcam.','دي نسبة مطابقة تجريبية، مش دقة طبية مثبتة. كاميرا واحدة لا تقيس حركة الرقبة ثلاثية الأبعاد أو نشاط العضلات أو قوة المقاومة بدقة.')}</small>
   </aside>
  </div>
  {(mode==='laser'||mode==='tracking')&&<div style={{margin:'14px auto',maxWidth:420,textAlign:'center'}}>
   <p>{tr('Virtual head-controlled dot (blue) and target (orange)','النقطة المتحركة بالرأس (أزرق) والهدف (برتقالي)')}</p>
   <svg viewBox="0 0 240 160" style={{width:'100%',border:'1px solid #aaa',borderRadius:12,background:'#f7f9fc'}}>
    <line x1="120" x2="120" y1="0" y2="160" stroke="#ddd"/><line x1="0" x2="240" y1="80" y2="80" stroke="#ddd"/>
    <circle cx={120+(observation?.target.x??0)*85} cy={80+(observation?.target.y??0)*60} r={mode==='laser'?22:config?.stage===2?15:22} fill="none" stroke="#ed8f40" strokeWidth="4"/>
    <circle cx={120+(observation?.dot.x??0)*85} cy={80+(observation?.dot.y??0)*60} r="8" fill="#2479d7"/>
   </svg>
  </div>}
  <div style={{display:'flex',gap:9,flexWrap:'wrap',marginTop:18}}>
   {status==='off'&&<button className="btn-plush primary" disabled={!config||safetyBlocked} onClick={begin}>{tr('Turn on camera','تشغيل الكاميرا')}</button>}
   {(status==='calibration'||status==='tracking')&&<><button className="btn-plush" onClick={startCalibration}>{tr('Calibrate for 3 seconds','معايرة الوضع لمدة ٣ ثوانٍ')}</button><button className="btn-plush primary" onClick={()=>finish()}>{tr('Finish and save','إنهاء وحفظ')}</button></>}
   <button className="btn-plush" onClick={()=>{stopCamera();store.setScreen('neck-video');}}>{tr('Back to video','الرجوع للفيديو')}</button>
  </div>
  {status==='loading'&&<p>{tr('Loading MediaPipe models…','جاري تحميل نماذج MediaPipe…')}</p>}
  <small style={{display:'block',opacity:.7}}>{diag}</small>
  <p role="status" aria-live="polite">{tr('Tracking:','حالة التتبع:')} {status} · {calibrated?tr('Calibrated','تمت المعايرة'):tr('Calibration required','تحتاج معايرة')}</p>
  <p role="status">{feedback?selectText(feedback[0],feedback[1],language):tr('Please remain in view.','من فضلك ابقي داخل إطار الكاميرا.')}</p>

  {mode==='neutral'&&<label style={{display:'block',margin:'8px 0'}}><input type="checkbox" checked={fixedCva} onChange={e=>setFixedCva(e.target.checked)}/> {tr('Compare with the fixed experimental CVA target (~50°) instead of my calibrated reference','قارني بهدف زاوية الوضعية التجريبي (~٥٠°) بدل وضعي المرجعي')}</label>}
  {mode==='isometric'&&<label>{tr('Self-reported effort (camera cannot measure force):','المجهود الذي تشعرين به (الكاميرا لا تقيس القوة):')} {effort}/10 <input type="range" min="1" max="10" value={effort} onChange={e=>setEffort(Number(e.target.value))}/></label>}
  {(status==='tracking'||status==='calibration')&&<button type="button" style={{marginTop:12,color:'#9e1538',border:'2px solid #9e1538',padding:12,borderRadius:10}} onClick={()=>finish(true)}>{tr('STOP: pain / dizziness / numbness / weakness','إيقاف فوري: ألم / دوخة / تنميل / ضعف')}</button>}
  {safetyBlocked&&<p role="alert" style={{color:'#a13543'}}>{tr('Safety symptoms reported. Seek a physiotherapist evaluation before exercise.','تم الإبلاغ عن أعراض تحذيرية. راجعي أخصائي العلاج الطبيعي قبل التمرين.')}</p>}
  {error&&<p role="alert" style={{color:'#a13543'}}>{error}</p>}
  {report&&status==='stopped'&&<div style={{border:'1px solid #cfded9',borderRadius:14,padding:16,marginTop:16}}><h3>{tr('Session summary','ملخص الجلسة')}</h3><p>{tr('Observable completed reps:','التكرارات المكتملة حسب قياسات الكاميرا:')} <b>{report.reps}</b> · {tr('Time in target:','الوقت داخل النطاق:')} <b>{report.validSeconds.toFixed(1)}s</b> · {tr('Target match:','نسبة التطابق:')} <b>{report.accuracy?.toFixed(0)??'—'}%</b></p><small>{tr('Prototype score — not clinically validated.','نتيجة تجريبية غير معتمدة طبيًا.')}</small></div>}
  {sessionSaved&&<p role="status">{tr('Session observations saved to patient history.','تم حفظ ملاحظات الجلسة في سجل المريض.')}</p>}
  <small>{tr('Research/demo tracking only: camera-derived proxies are not validated cervical angles; no strength, deep-muscle activation, or actual laser detection. Targets and thresholds must be reviewed by a physiotherapist before real patient use.','تتبع تجريبي فقط: القيم المستخرجة من الكاميرا ليست زوايا رقبة معتمدة؛ لا يتم قياس القوة أو العضلات العميقة أو الليزر الحقيقي. يجب مراجعة الحدود والأهداف مع أخصائي العلاج الطبيعي قبل الاستخدام مع مرضى فعليين.')}</small>
  </main></div>;
}
