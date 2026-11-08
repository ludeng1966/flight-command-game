export class RadarRadio{
  constructor({getWorld,radio,isBusy}){this.getWorld=getWorld;this.radio=radio;this.isBusy=isBusy;this.world=getWorld();this.cursor=new Map(this.world.units.map(u=>[u.id,u.radar?.sequence??0]));this.active=false;}
  pump(){
    const world=this.getWorld();if(world!==this.world){this.world=world;this.cursor=new Map(world.units.map(u=>[u.id,u.radar?.sequence??0]));}
    if(this.active||this.isBusy())return;
    for(const unit of world.units){const entry=unit.radar?.events.find(e=>e.sequence>(this.cursor.get(unit.id)??0));if(!entry)continue;
      this.cursor.set(unit.id,entry.sequence);this.active=true;
      const text=`指挥台，${unit.callsign}。${entry.text}。`;
      Promise.resolve().then(()=>this.radio.transmit({speaker:'pilot',unitId:unit.id,text,language:'zh-CN',simTime:entry.time,radarEventId:entry.sequence}))
        .catch(()=>{}).finally(()=>{this.active=false;});break;
    }
  }
}
