// Shared by real aircraft tracks and practice targets. Preserve each material's
// original opacity/depth behavior so reacquisition restores the same model.
const originals=new WeakMap();
export function setContactOpacity(model,opacity=1){
  opacity=Math.max(0,Math.min(1,Number.isFinite(opacity)?opacity:1));
  model.visible=opacity>0;
  if(model.userData.contactOpacity===opacity)return;
  model.userData.contactOpacity=opacity;
  model.traverse(object=>{
    for(const material of Array.isArray(object.material)?object.material:object.material?[object.material]:[]){
      let initial=originals.get(material);
      if(!initial){initial={opacity:material.opacity,transparent:material.transparent,depthWrite:material.depthWrite};originals.set(material,initial);}
      const transparent=initial.transparent||opacity<1;
      if(material.transparent!==transparent){material.transparent=transparent;material.needsUpdate=true;}
      material.opacity=initial.opacity*opacity;
      material.depthWrite=opacity<1?false:initial.depthWrite;
    }
  });
}
