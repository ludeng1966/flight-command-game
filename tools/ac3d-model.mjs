// AC3D static mesh reader. Keeps the hierarchy transform and source polygon winding.
export function readAC3D(text){
  const lines=text.split(/\r?\n/);let cursor=0;const materials=[];
  const next=()=>lines[cursor++]?.trim();
  if(!next()?.startsWith('AC3D'))throw Error('Not AC3D');
  while(lines[cursor]?.startsWith('MATERIAL ')){
    const line=next(),name=/^MATERIAL "([^"]*)"/.exec(line)?.[1]??'',rgb=/ rgb ([\d.e+-]+) ([\d.e+-]+) ([\d.e+-]+)/.exec(line),trans=/ trans ([\d.e+-]+)/.exec(line);
    materials.push({name,rgb:rgb?.slice(1).map(Number),opacity:1-Number(trans?.[1]??0)});
  }
  function object(){
    while(lines[cursor]?.trim()==='')cursor++;
    const header=next();if(!header?.startsWith('OBJECT '))throw Error('Expected object at '+cursor);
    const node={name:'',kind:header.slice(7),vertices:[],faces:[],children:[],loc:[0,0,0],rot:[1,0,0,0,1,0,0,0,1]};
    for(;;){
      const line=next();if(line===undefined)throw Error('Truncated AC3D');
      const [key,...args]=line.split(/\s+/);
      if(key==='name')node.name=line.slice(5).replace(/^"|"$/g,'');
      else if(key==='texture')node.texture=line.slice(8).replace(/^"|"$/g,'');
      else if(key==='loc'||key==='rot')node[key]=args.map(Number);
      else if(key==='data'){let count=0;while(count<Number(args[0])){const data=lines[cursor++];count+=data.length+1;}}
      else if(key==='numvert')for(let i=0;i<Number(args[0]);i++)node.vertices.push(next().split(/\s+/).slice(0,3).map(Number));
      else if(key==='numsurf')for(let i=0;i<Number(args[0]);i++){
        let flag=0,mat=0,refs;
        for(;;){const [k,...v]=next().split(/\s+/);if(k==='SURF')flag=Number(v[0]);if(k==='mat')mat=Number(v[0]);if(k==='refs'){refs=Array.from({length:Number(v[0])},()=>Number(next().split(/\s+/)[0]));break;}}
        if((flag&15)===0&&refs.length>=3)node.faces.push({mat,refs});
      }
      else if(key==='kids'){for(let i=0;i<Number(args[0]);i++)node.children.push(object());return node;}
    }
  }
  return {materials,root:object()};
}

export function flattenAC3D(root){
  const parts=[];
  function visit(node,transform=p=>p,ancestors=[]){
    const r=node.rot,l=node.loc,apply=p=>transform([r[0]*p[0]+r[1]*p[1]+r[2]*p[2]+l[0],r[3]*p[0]+r[4]*p[1]+r[5]*p[2]+l[1],r[6]*p[0]+r[7]*p[1]+r[8]*p[2]+l[2]]);
    if(node.faces.length)parts.push({...node,ancestors,vertices:node.vertices.map(apply)});
    for(const child of node.children)visit(child,apply,[...ancestors,node.name]);
  }
  visit(root);return parts;
}
