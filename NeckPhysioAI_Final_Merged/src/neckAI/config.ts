/**
 * EXPERIMENTAL configuration values. They come from the project specification and require clinical
 * review and camera validation. They are not validated therapeutic thresholds or prescriptions.
 */
export type ExerciseMode = 'deepFlexor'|'isometric'|'laser'|'neutral'|'tracking';
export type View = 'front'|'side';
export type Targets = {
  holdSeconds:number;
  maxTrunkDeg:number;            // trunk compensation
  maxShrugPct:number;            // shoulder shrug, % of reference body dimension
  // deep cervical flexor
  nod?:[number,number];          // chin-nod range in degrees (chin-down positive)
  lift?:[number,number];         // intended head lift, % of torso length (stage 4)
  maxLiftPct?:number;            // unwanted head lift, % of torso length
  maxFwdPct?:number;             // unwanted forward head translation, % of torso length
  // isometric
  maxDriftPct?:number;           // head drift, % of shoulder width
  maxRollDeg?:number; maxOrientDeg?:number;
  // neutral head
  referenceCva?:number; cvaTolDeg?:number; maxPitchErrDeg?:number; maxPostureDriftDeg?:number;
  // laser
  jpeMaxDeg?:number; dwellSeconds?:number; targetAmplitudeDeg?:number; targetRadiusDeg?:number;
  // tracking
  rangeDeg?:number; minTimeOnTargetPct?:number; trialSeconds?:number; maxLagMs?:number;
};
export type ExerciseConfig = {id:string;mode:ExerciseMode;view:View;stage:number;holdSeconds:number;targetRadius:number;targets:Targets;descriptionEn:string;descriptionAr:string};

const common={maxTrunkDeg:5,maxShrugPct:3};
export const DCF_STAGES:Record<number,Targets>={
 1:{...common,nod:[5,8],holdSeconds:10,maxLiftPct:2,maxFwdPct:4},
 2:{...common,nod:[8,12],holdSeconds:10,maxLiftPct:2,maxFwdPct:4},
 3:{...common,nod:[10,15],holdSeconds:10,maxLiftPct:2,maxFwdPct:4},
 4:{...common,nod:[10,15],lift:[3,5],holdSeconds:5,maxFwdPct:4},   // controlled head lift after a maintained nod
 5:{...common,nod:[8,12],holdSeconds:10,maxLiftPct:2,maxFwdPct:4}, // seated neutral nod, approximately 10°
};
export const ISOMETRIC_STAGES:Record<number,Targets>={
 1:{...common,holdSeconds:5,maxDriftPct:3,maxRollDeg:3,maxOrientDeg:3},
 2:{...common,holdSeconds:8,maxDriftPct:3,maxRollDeg:3,maxOrientDeg:3},
 3:{...common,holdSeconds:10,maxDriftPct:3,maxRollDeg:3,maxOrientDeg:3},
};
export const LASER_STAGES:Record<number,Targets>={
 1:{...common,holdSeconds:2,dwellSeconds:2,jpeMaxDeg:6,targetAmplitudeDeg:10,targetRadiusDeg:3.5},
 2:{...common,holdSeconds:2,dwellSeconds:2,jpeMaxDeg:4.5,targetAmplitudeDeg:12,targetRadiusDeg:3},
};
export const NEUTRAL_STAGES:Record<number,Targets>={
 1:{...common,holdSeconds:10,referenceCva:50,cvaTolDeg:8,maxPitchErrDeg:4,maxPostureDriftDeg:2,maxFwdPct:5},
 2:{...common,holdSeconds:15,referenceCva:50,cvaTolDeg:8,maxPitchErrDeg:4,maxPostureDriftDeg:2,maxFwdPct:5},
};
export const TRACKING_STAGES:Record<number,Targets>={
 1:{...common,holdSeconds:0,rangeDeg:15,minTimeOnTargetPct:70,trialSeconds:20,maxLagMs:300},
 2:{...common,holdSeconds:0,rangeDeg:15,minTimeOnTargetPct:75,trialSeconds:20,maxLagMs:300},
 3:{...common,holdSeconds:0,rangeDeg:15,minTimeOnTargetPct:80,trialSeconds:20,maxLagMs:300},
};
const make=(id:string,mode:ExerciseMode,view:View,stage:number,targets:Targets,targetRadius:number,descriptionEn:string,descriptionAr:string):ExerciseConfig=>({id,mode,view,stage,holdSeconds:targets.holdSeconds,targetRadius,targets,descriptionEn,descriptionAr});
export const TRACKER_CONFIGS: Record<string,ExerciseConfig> = {
  'deep-flexor-1': make('deep-flexor-1','deepFlexor','side',1,DCF_STAGES[1],0.3,'Observe small chin nods from the side. Deep muscle activation cannot be detected.','راقبي إيماءة الذقن الصغيرة من الجانب. لا يمكن قياس تنشيط العضلات العميقة.'),
  'deep-flexor-2': make('deep-flexor-2','deepFlexor','side',2,DCF_STAGES[2],0.25,'Progression: observe head lifting and nod consistency; no strength measurement.','مرحلة متقدمة: مراقبة رفع الرأس وثبات الإيماءة، دون قياس القوة.'),
  'cervical-isometric': make('cervical-isometric','isometric','front',1,ISOMETRIC_STAGES[1],0.18,'Check head stability during the exercise, not resistance force.','مراقبة ثبات الرأس أثناء التمرين، وليس قوة المقاومة.'),
  'laser-proprioception': make('laser-proprioception','laser','front',1,LASER_STAGES[1],0.23,'Virtual laser demo controlled by head direction; no physical laser is tracked.','ليزر افتراضي يتحرك باتجاه الرأس؛ لا يتم تتبع ليزر حقيقي.'),
  'neutral-head-1': make('neutral-head-1','neutral','side',1,NEUTRAL_STAGES[1],0.18,'Observe stability relative to a calibrated clinician-guided reference.','مراقبة الثبات مقارنة بوضع مرجعي يحدده الأخصائي.'),
  'neutral-head-2': make('neutral-head-2','neutral','side',2,NEUTRAL_STAGES[2],0.14,'Longer neutral-head stability observation, not a posture diagnosis.','مراقبة ثبات الرأس لمدة أطول، دون تشخيص وضعية الرقبة.'),
  'tracking-1': make('tracking-1','tracking','front',1,TRACKING_STAGES[1],0.26,'Follow the moving target using gentle head movement.','اتبعي الهدف المتحرك بحركة رأس هادئة.'),
  'tracking-2': make('tracking-2','tracking','front',2,TRACKING_STAGES[2],0.19,'Progression: trace a slower figure-eight target with your head.','مرحلة متقدمة: اتبعي مسار شكل ثمانية ببطء باستخدام الرأس.'),
};
