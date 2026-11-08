// Renderer coordinates: east=+X, north=-Z, up=+Y.
const degrees=rad=>((rad*180/Math.PI)%360+360)%360;
export function mapViewHeading(forward,right,previous=0){
  if(Math.hypot(forward[0],forward[2])>1e-5)return degrees(Math.atan2(forward[0],-forward[2]));
  // At vertical view the forward projection vanishes; screen-right still fixes north.
  if(Math.hypot(right[0],right[2])>1e-5)return (degrees(Math.atan2(right[0],-right[2]))+270)%360;
  return Number.isFinite(previous)?(previous%360+360)%360:0;
}
