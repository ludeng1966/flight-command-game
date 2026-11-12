// Six-state constant-velocity EKF; measurements are range, azimuth, elevation
// in ENU and signed radial velocity. Covariance is never replaced with truth.
const mat=(n,m=n)=>Array.from({length:n},()=>Array(m).fill(0));
const identity=n=>mat(n).map((r,i)=>r.map((_,j)=>+(i===j)));
const transpose=a=>a[0].map((_,j)=>a.map(r=>r[j]));
const multiply=(a,b)=>a.map(r=>b[0].map((_,j)=>r.reduce((s,v,k)=>s+v*b[k][j],0)));
const add=(a,b)=>a.map((r,i)=>r.map((v,j)=>v+b[i][j]));
function inverse(a){const n=a.length,b=a.map((r,i)=>[...r,...identity(n)[i]]);for(let k=0;k<n;k++){
  let p=k;for(let i=k+1;i<n;i++)if(Math.abs(b[i][k])>Math.abs(b[p][k]))p=i;
  [b[k],b[p]]=[b[p],b[k]];if(Math.abs(b[k][k])<1e-15)return null;
  const d=b[k][k];b[k]=b[k].map(v=>v/d);for(let i=0;i<n;i++)if(i!==k){const f=b[i][k];b[i]=b[i].map((v,j)=>v-f*b[k][j]);}
}return b.map(r=>r.slice(n));}
export function predictFilter(track,time){
  const dt=Math.max(0,time-track.filterAt);if(!dt)return;
  if(track.filterMode==='search_axes'){
    const p=track.P,dt2=dt*dt;for(let i=0;i<3;i++){track.x[i]+=dt*track.x[i+3];
      p[i][i]+=2*dt*p[i][i+3]+dt2*p[i+3][i+3]+25*dt2*dt2/4;
      p[i][i+3]=p[i+3][i]=p[i][i+3]+dt*p[i+3][i+3]+25*dt2*dt/2;p[i+3][i+3]+=25*dt2;}
    track.filterAt=time;return;
  }
  // F=[I,dtI;0,I]: propagate its four blocks directly, avoiding 6x6
  // matrix products/allocation on every track of every sensor tick.
  const p=track.P,dt2=dt*dt,qpp=25*dt2*dt2/4,qpv=25*dt2*dt/2,qvv=25*dt2;
  for(let i=0;i<3;i++){track.x[i]+=dt*track.x[i+3];for(let j=0;j<3;j++){
    p[i][j]+=dt*(p[i][j+3]+p[i+3][j])+dt2*p[i+3][j+3]+(i===j?qpp:0);
  }}
  for(let i=0;i<3;i++)for(let j=0;j<3;j++){p[i][j+3]+=dt*p[i+3][j+3]+(i===j?qpv:0);p[i+3][j]+=dt*p[i+3][j+3]+(i===j?qpv:0);}
  for(let i=0;i<3;i++)p[i+3][i+3]+=qvv;track.filterAt=time;
}
// Search-only approximation: three independent position/velocity Kalman pairs.
// Isotropic measurement variance bounds the spherical position noise; discarded
// cross-axis correlations are conservatively added to the diagonal on demotion.
// Fire control always switches back to the full spherical EKF below.
export function correctSearchFilter(track,measurement,positionVariance){
  const p=track.P;
  if(track.filterMode!=='search_axes'){
    for(let i=0;i<6;i++)for(let j=0;j<6;j++)if(i%3!==j%3)p[i][i]+=Math.abs(p[i][j]);
    for(let i=0;i<6;i++)for(let j=0;j<6;j++)if(i%3!==j%3)p[i][j]=0;
  }
  for(let i=0;i<3;i++){
    const pp=p[i][i],pv=p[i][i+3],variance=pp+positionVariance,kp=pp/variance,kv=pv/variance,residual=measurement.position[i]-track.x[i];
    track.x[i]+=kp*residual;track.x[i+3]+=kv*residual;
    p[i][i]=Math.max(1e-9,(1-kp)*pp);p[i][i+3]=p[i+3][i]=(1-kp)*pv;p[i+3][i+3]=Math.max(1e-9,p[i+3][i+3]-kv*pv);
  }
  track.filterMode='search_axes';
}
export function initializeFilter(position,radialVelocity,los,time,positionSigma=200){
  const p=mat(6);for(let i=0;i<6;i++)p[i][i]=i<3?positionSigma**2:300**2;
  return {x:[...position,...los.map(v=>v*radialVelocity)],P:p,filterAt:time};
}
function projected(x,own,ownVelocity){const d=x.slice(0,3).map((v,i)=>v-own[i]),r=Math.max(1,Math.hypot(...d)),h=Math.hypot(d[0],d[1]);
  return [r,Math.atan2(d[0],d[1]),Math.atan2(d[2],h),d.reduce((s,v,i)=>s+v*(x[i+3]-ownVelocity[i]),0)/r];}
export function filterInnovation(track,measurement){
  const {z,R,observerPosition,observerVelocity}=measurement,h=projected(track.x,observerPosition,observerVelocity),H=mat(4,6);
  const d=track.x.slice(0,3).map((v,i)=>v-observerPosition[i]),r=Math.max(1,h[0]),horizontal=Math.max(.001,Math.hypot(d[0],d[1])),h2=horizontal*horizontal,r2=r*r;
  for(let i=0;i<3;i++){const los=d[i]/r;H[0][i]=los;H[3][i]=(track.x[i+3]-observerVelocity[i]-h[3]*los)/r;H[3][i+3]=los;}
  H[1][0]=d[1]/h2;H[1][1]=-d[0]/h2;H[2][0]=-d[0]*d[2]/(r2*horizontal);H[2][1]=-d[1]*d[2]/(r2*horizontal);H[2][2]=horizontal/r2;
  const innovation=z.map((v,i)=>i===1?Math.atan2(Math.sin(v-h[i]),Math.cos(v-h[i])):v-h[i]);
  const hp=mat(4,6),S=mat(4),lower=mat(4),whitened=Array(4).fill(0);
  for(let i=0;i<4;i++)for(let j=0;j<6;j++){let sum=0;for(let k=0;k<(i===3?6:3);k++)sum+=H[i][k]*track.P[k][j];hp[i][j]=sum;}
  for(let i=0;i<4;i++)for(let j=0;j<=i;j++){let sum=R[i][j];for(let k=0;k<6;k++)sum+=hp[i][k]*H[j][k];S[i][j]=S[j][i]=sum;}
  // Mahalanobis norm from a Cholesky solve, without constructing S^-1.
  let d2=0;for(let i=0;i<4;i++){
    for(let j=0;j<=i;j++){let value=S[i][j];for(let k=0;k<j;k++)value-=lower[i][k]*lower[j][k];
      if(i===j){if(!(value>0))return null;lower[i][j]=Math.sqrt(value);}else lower[i][j]=value/lower[j][j];}
    let value=innovation[i];for(let j=0;j<i;j++)value-=lower[i][j]*whitened[j];whitened[i]=value/lower[i][i];d2+=whitened[i]**2;
  }
  return {H,innovation,S,d2};
}
export function correctFilter(track,measurement,fit=filterInnovation(track,measurement)){
  if(!fit)return false;const {H,innovation}=fit;
  const diagonal=measurement.R.every((row,i)=>row.every((v,j)=>i===j||v===0));
  if(diagonal){
    const origin=[...track.x],ph=Array(6).fill(0),p=track.P;
    // Independent measurement noise permits sequential scalar updates at the
    // SAME linearization. Adjust each innovation for earlier state corrections.
    // This equals the batch EKF, without its 6x6 Joseph matrix products.
    for(let n=0;n<4;n++){
      const h=H[n];let residual=innovation[n],variance=measurement.R[n][n];
      for(let i=0;i<6;i++){residual-=h[i]*(track.x[i]-origin[i]);let sum=0;for(let j=0;j<6;j++)sum+=p[i][j]*h[j];ph[i]=sum;variance+=h[i]*sum;}
      if(!(variance>0))return false;
      const inverseVariance=1/variance;
      for(let i=0;i<6;i++){track.x[i]+=ph[i]*inverseVariance*residual;for(let j=0;j<=i;j++){const v=p[i][j]-ph[i]*ph[j]*inverseVariance;p[i][j]=p[j][i]=i===j?Math.max(1e-9,v):v;}}
    }
    track.filterMode='full_ekf';return true;
  }
  // Retain the full correlated-noise path for future sensor models.
  const inv=fit.inv??inverse(fit.S);if(!inv)return false;
  const K=multiply(multiply(track.P,transpose(H)),inv),delta=multiply(K,innovation.map(v=>[v]));
  track.x=track.x.map((v,i)=>v+delta[i][0]);const kh=multiply(K,H),a=identity(6).map((r,i)=>r.map((v,j)=>v-kh[i][j]));
  track.P=add(multiply(multiply(a,track.P),transpose(a)),multiply(multiply(K,measurement.R),transpose(K)));
  for(let i=0;i<6;i++){track.P[i][i]=Math.max(1e-9,track.P[i][i]);for(let j=0;j<i;j++)track.P[i][j]=track.P[j][i]=(track.P[i][j]+track.P[j][i])/2;}
  track.filterMode='full_ekf';return true;
}
