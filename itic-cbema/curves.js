// itic-cbema/curves.js — Núcleo puro (sin DOM) de análisis ITIC/CBEMA.
// Extraído de index.html para tener una fuente única testeable con Vitest.
// El HTML lo importa vía <script type="module"> y lo expone en globalThis para
// el script clásico y los handlers onclick inline.
/* ===================== NÚCLEO v2 (verificado con hopper) ===================== */
export const ITIC={
  PROH_X:[1e-6,1e-3,1e-3,3e-3,3e-3,20e-3,20e-3,0.5,0.5,10,10,100,1000],
  PROH_Y:[500,500,200,200,140,140,120,120,110,110,110,110,110],
  FREE_X:[20e-3,20e-3,0.5,0.5,10,10,100,1000],
  FREE_Y:[0,70,70,80,80,90,90,90],
};
export const PHASES=['X1','X2','X3'];
export const AUTO_US_THRESHOLD=50000;
export function cleanNum(v){
  if(v===null||v===undefined)return NaN;
  if(typeof v==='number')return v;
  let s=String(v).trim().replace(',','.').replace(/[^0-9.\-+eE]/g,'');
  if(s===''||s==='-'||s==='+'||s==='.')return NaN;
  const n=Number(s);return Number.isFinite(n)?n:NaN;
}
export function colGet(row,cands){
  if(!row)return undefined;
  const low={};for(const k of Object.keys(row))low[k.trim().toLowerCase()]=k;
  for(const c of cands){const r=low[c.trim().toLowerCase()];if(r!==undefined)return row[r];}
  return undefined;
}
export function median(arr){
  const a=arr.filter(Number.isFinite).slice().sort((x,y)=>x-y);
  if(!a.length)return NaN;const m=Math.floor(a.length/2);
  return a.length%2?a[m]:(a[m-1]+a[m])/2;
}
export function durToSeconds(d,unit,freq){
  const F=(freq&&freq>0)?freq:60;
  if(!Number.isFinite(d))return NaN;
  switch(unit){case 'cycles':return d/F;case 'us':return d/1e6;case 'ms':return d/1e3;case 's':return d;default:return d/F;}
}
export function inferUnit(durations){const m=median(durations);if(!Number.isFinite(m))return 'cycles';return m>AUTO_US_THRESHOLD?'us':'cycles';}
export function interpCurveY(xSeconds,curveX,curveY){
  const x=Math.max(Number(xSeconds),1e-12),lq=Math.log10(x);
  const lx=curveX.map(v=>Math.log10(v));
  if(lq<=lx[0])return curveY[0];
  if(lq>=lx[lx.length-1])return curveY[curveY.length-1];
  for(let i=0;i<lx.length-1;i++){
    if(lq>=lx[i]&&lq<=lx[i+1]){const t=(lx[i+1]===lx[i])?0:(lq-lx[i])/(lx[i+1]-lx[i]);return curveY[i]+t*(curveY[i+1]-curveY[i]);}
  }
  return curveY[curveY.length-1];
}
export function classifyPoint(durS,magPct){
  const yF=interpCurveY(durS,ITIC.PROH_X,ITIC.PROH_Y);
  const yN=interpCurveY(durS,ITIC.FREE_X,ITIC.FREE_Y);
  if(magPct<=yN)return 'free';if(magPct<=yF)return 'normal';return 'prohibited';
}
export function rowKind(row){
  const tn=String(colGet(row,['Template Name','template_name','templateName'])||'').toLowerCase();
  const et=String(colGet(row,['Event Type','alertType','thresholdType'])||'').toLowerCase();
  const blob=tn+' '+et;
  if(/swell/.test(blob))return 'swell';
  if(/sag/.test(blob))return 'sag';
  if(/power/.test(blob))return 'power';
  return null;
}
export function bucketRows(filesArr){
  const b={sag:[],swell:[],power:[]};
  for(const f of filesArr){
    const fname=(f.name||'').toLowerCase();
    for(const row of (f.rows||[])){
      let k=rowKind(row);
      if(!k){
        if(/vsag|_sag/.test(fname))k='sag';
        else if(/vswell|_swell/.test(fname))k='swell';
        else if(/powerloss|powerrestored|power/.test(fname))k='power';
      }
      if(k)b[k].push(row);
    }
  }
  return b;
}
export function countOutages(powerRows){
  let n=0;
  for(const r of powerRows){
    const val=String(colGet(r,['Value','MsgStr','duration'])||'').toLowerCase();
    if(/loss/.test(val)){n++;continue;}
    const sp=colGet(r,['Subpanel Time']);const hasValueCol=colGet(r,['Value'])!==undefined;
    if(sp!==undefined&&String(sp).trim()!==''&&!hasValueCol)n++;
  }
  return n;
}
export function buildEvents(sagRows,swellRows,opts){
  opts=opts||{};
  const refDefault=Number(opts.ref)>0?Number(opts.ref):120;
  const freq=(opts.freq&&opts.freq>0)?opts.freq:60;
  const events=[];const detected={SAG:{X1:0,X2:0,X3:0},SWELL:{X1:0,X2:0,X3:0}};let dropped=0;
  function resolveUnit(rows,mode){
    if(mode&&mode!=='auto')return mode;
    const ds=[];for(const row of rows)for(const ph of PHASES){const d=cleanNum(colGet(row,[ph+' Duration']));if(Number.isFinite(d))ds.push(d);}
    return inferUnit(ds);
  }
  const sagUnit=resolveUnit(sagRows||[],opts.durUnit);
  const swellUnit=resolveUnit(swellRows||[],opts.durUnit);
  const unitUsed={SAG:sagUnit,SWELL:swellUnit};
  function harvest(rows,type,valTpl,unit){
    if(!Array.isArray(rows))return;
    for(const row of rows){
      const t=colGet(row,['Date','Time','time','Subpanel Time'])||'';
      const node=colGet(row,['Node Name','dev_eui','Node ID','node','node_name'])||'';
      const nomRow=cleanNum(colGet(row,['Nominal Voltage','nominalVoltage','Operating Voltage']));
      const R=Number.isFinite(nomRow)&&nomRow>0?nomRow:refDefault;
      for(const ph of PHASES){
        const val=cleanNum(colGet(row,[ph+' '+valTpl]));
        const durRaw=cleanNum(colGet(row,[ph+' Duration']));
        if(Number.isFinite(val))detected[type][ph]++;
        if(!Number.isFinite(val)||!Number.isFinite(durRaw)){if(Number.isFinite(val))dropped++;continue;}
        const durS=durToSeconds(durRaw,unit,freq);const magPct=+(val/R*100).toFixed(1);
        events.push({Time:t,Phase:ph,Type:type,DurationS:+durS.toFixed(6),DurationRaw:+durRaw.toFixed(3),
          Unit:unit,MagPct:magPct,Value:+val.toFixed(3),Nominal:R,Node:node,Zone:classifyPoint(durS,magPct)});
      }
    }
  }
  harvest(sagRows,'SAG','Lowest Value',sagUnit);
  harvest(swellRows,'SWELL','Highest Value',swellUnit);
  return {events,detected,dropped,unitUsed};
}
export function summarize(events,powerlossCount,detected,unitUsed){
  const z={free:0,normal:0,prohibited:0},byPhase={X1:0,X2:0,X3:0};let sag=0,swell=0;
  for(const e of events){z[e.Zone]++;byPhase[e.Phase]++;e.Type==='SAG'?sag++:swell++;}
  return {total:events.length,sag,swell,powerloss:powerlossCount||0,zones:z,byPhase,detected,unitUsed};
}
/* --- Conteo por hora del día (5 min) --- */
export const COUNT_BINS=288; // 24h * 12 (cada 5 min)
export function countBucketLabel(i){const h=Math.floor(i/12),m=(i%12)*5;return String(h).padStart(2,'0')+':'+String(m).padStart(2,'0');}
export function parseTimeOfDay(str){
  if(str===null||str===undefined)return -1;
  const s=String(str).trim();if(!s)return -1;
  const m=s.match(/(\d{1,2}):(\d{2})(?::\d{2})?\s*([AaPp][Mm])?/);
  if(!m)return -1;
  let h=parseInt(m[1],10);const min=parseInt(m[2],10);const ap=m[3]?m[3].toLowerCase():null;
  if(ap){if(ap==='am'){if(h===12)h=0;}else{if(h!==12)h+=12;}}
  if(!(h>=0&&h<=23)||!(min>=0&&min<=59))return -1;
  return h*12+Math.floor(min/5);
}
export function buildCount(filesArr){
  const b=bucketRows(filesArr);
  const z=()=>new Array(COUNT_BINS).fill(0);
  const sag={X1:z(),X2:z(),X3:z()},swell={X1:z(),X2:z(),X3:z()},power=z();
  let parsed=0,noTime=0;
  function harvest(rows,valTpl,target){
    for(const row of (rows||[])){
      const bin=parseTimeOfDay(colGet(row,['Date','Time','time','Subpanel Time']));
      let any=false;
      for(const ph of PHASES){if(Number.isFinite(cleanNum(colGet(row,[ph+' '+valTpl])))){if(bin>=0)target[ph][bin]++;any=true;}}
      if(any){if(bin>=0)parsed++;else noTime++;}
    }
  }
  harvest(b.sag,'Lowest Value',sag);
  harvest(b.swell,'Highest Value',swell);
  for(const r of (b.power||[])){
    const val=String(colGet(r,['Value','MsgStr','duration'])||'').toLowerCase();
    const sp=colGet(r,['Subpanel Time']);const hasValueCol=colGet(r,['Value'])!==undefined;
    const isLoss=/loss/.test(val)||(sp!==undefined&&String(sp).trim()!==''&&!hasValueCol);
    if(!isLoss)continue;
    const bin=parseTimeOfDay(colGet(r,['Date','Time','time','Subpanel Time']));
    if(bin>=0){power[bin]++;parsed++;}else noTime++;
  }
  const totSag=z(),totSwell=z();
  for(let i=0;i<COUNT_BINS;i++){totSag[i]=sag.X1[i]+sag.X2[i]+sag.X3[i];totSwell[i]=swell.X1[i]+swell.X2[i]+swell.X3[i];}
  sag.Total=totSag;swell.Total=totSwell;
  const labels=[];for(let i=0;i<COUNT_BINS;i++)labels.push(countBucketLabel(i));
  return {labels,sag,swell,power,parsed,noTime};
}
/* ===================== FIN NÚCLEO ===================== */
