import {describe,it,expect} from 'vitest';
import {angle3,ema,virtualPoint,sideMetrics} from './geometry';
import {ExerciseAnalyzer} from './engine';
import {TRACKER_CONFIGS} from './config';
describe('neck camera mathematics (not clinical validation)',()=>{
 it('right-angle geometry',()=>expect(angle3({x:1,y:0},{x:0,y:0},{x:0,y:1})).toBeCloseTo(90));
 it('smooths',()=>expect(ema(0,10,0.2)).toBe(2));
 it('clamps virtual screen coordinate',()=>expect(virtualPoint(60,-60)).toEqual({x:1,y:1}));
 it('rejects incomplete side pose',()=>expect(sideMetrics([])).toBeNull());
 it('no analysis before calibration',()=>expect(new ExerciseAnalyzer(TRACKER_CONFIGS['cervical-isometric']).analyze({yaw:0,pitch:0,roll:0},1000)).toBeNull());
 it('isometric measures head stability but not force',()=>{const a=new ExerciseAnalyzer(TRACKER_CONFIGS['cervical-isometric']);a.calibrate({yaw:0,pitch:0,roll:0});expect(a.analyze({yaw:2,pitch:0,roll:0},1000)?.message).toBe('stable');expect(a.analyze({yaw:12,pitch:0,roll:0},1100)?.message).toBe('rotation');});
});

describe('camera-based form feedback (prototype)',()=>{
 it('explains isometric rotation errors and recovers',()=>{
  const a=new ExerciseAnalyzer(TRACKER_CONFIGS['cervical-isometric']);
  a.calibrate({yaw:0,pitch:0,roll:0,trunk:0});
  const wrong=a.analyze({yaw:12,pitch:0,roll:0,trunk:0},1000);
  expect(wrong?.status).toBe('adjust');expect(wrong?.message).toBe('rotation');
  const correct=a.analyze({yaw:1,pitch:1,roll:1,trunk:0},1100);
  expect(correct?.status).toBe('correct');
 });
 it('counts rep only after a sustained hold and release, not per frame',()=>{
  const a=new ExerciseAnalyzer(TRACKER_CONFIGS['cervical-isometric']);
  a.calibrate({yaw:0,pitch:0,roll:0});
  for(let t=0;t<=5400;t+=100)a.analyze({yaw:0,pitch:0,roll:0},t);
  expect(a.reps).toBe(0);
  for(let t=5500;t<=6500;t+=100)a.analyze({yaw:12,pitch:0,roll:0},t);
  expect(a.reps).toBe(1);
 });
 it('does not call missing side landmarks correct',()=>{
  const a=new ExerciseAnalyzer(TRACKER_CONFIGS['deep-flexor-1']);a.calibrate({yaw:0,pitch:0,roll:0});
  expect(a.analyze({yaw:0,pitch:0,roll:0},1000)?.status).toBe('unavailable');
 });
});
